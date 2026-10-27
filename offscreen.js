// offscreen.js — owns the OpenVox calls, the single-job lock, audio playback, and prefetch.
// Runs in an offscreen document (reason: AUDIO_PLAYBACK), the MV3-correct place for audio
// that must outlive the popup and survive service-worker suspension.

import { clampSpeed } from "./lib/openvox-client.js";
import { TtsError } from "./lib/tts-error.js";
import { getProvider, PROVIDER_IDS } from "./lib/tts-providers.js";
import { MSG, PHASE } from "./lib/message-types.js";
import { releaseBuiltin } from "./lib/kokoro-builtin-client.js";
import { PAUSE_RELEASE_MS, shouldReleaseAfterPause } from "./lib/kokoro-builtin-device.js";

const audio = new Audio();
// Keepalive: Chrome closes an AUDIO_PLAYBACK offscreen document ~30 s after audible output stops, and
// its audibility test is power-based, so a silent or volume-0 stream does NOT count (measured: a
// looping volume-0 WAV was reaped at exactly 30 s). A 20 Hz tone at gain 0.001 is below hearing but
// above Chrome's threshold, and kept the document alive through a 63 s silence in the same test.
// Same play()/pause() surface as the old <audio> keepalive so the session logic is unchanged.
const keepalive = (() => {
  let ctx = null;
  let osc = null;
  return {
    async play() {
      if (!ctx) {
        ctx = new AudioContext();
        osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.frequency.value = 20;
        gain.gain.value = 0.001;
        osc.connect(gain).connect(ctx.destination);
        osc.start();
      }
      await ctx.resume();
    },
    pause() {
      ctx?.suspend().catch(() => {});
    },
  };
})();
let session = null;
const UI_LOADING = "loading";
const UI_PLAYING = "playing";
const UI_PAUSED = "paused";
const KEEP_BEHIND = 3; // ponytail: covers skip(-1); repeated skip-back past this re-synthesizes

// ---- single-job mutex: at most ONE OpenVox API call in flight at any time ----
// Playback is NOT a job (it doesn't hit the API), so we can prefetch chunk N+1 while
// chunk N plays — but two synth/load calls never overlap (would trip OpenVox's 429).
let jobChain = Promise.resolve();
function withJob(fn) {
  const run = jobChain.then(fn, fn);
  jobChain = run.then(
    () => {},
    () => {},
  );
  return run;
}

function send(msg) {
  chrome.runtime.sendMessage({ target: MSG.TARGET_SW, ...msg }).catch(() => {});
}

function hostOf(base) {
  try {
    return new URL(base).host;
  } catch {
    return base || "the TTS server";
  }
}

const MAX_ERROR_CHARS = 300; // provider/server text is unbounded; keep the popup line readable

function capText(text) {
  return text.length > MAX_ERROR_CHARS ? text.slice(0, MAX_ERROR_CHARS - 1) + "…" : text;
}

function humanError(err, s) {
  if (err && err.name === "AbortError") return "Stopped.";
  const label = s?.provider?.label || "the TTS server";
  if (err instanceof TtsError) {
    if (err.status === 429) return `${label} is busy (another job is running). Try again.`;
    if (err.status === 401) return `${label} rejected the API key — check it in Settings.`;
    if (err.status === 0) {
      if (s?.provider?.hasBaseUrl === false) return capText(err.message); // built-in: no server to point at
      const hint =
        s?.provider?.id === "openvox" ? " — is OpenVox open with the Local API enabled?" : " — is the server running?";
      return capText(`Can't reach ${label} at ${hostOf(s?.conn?.base)}${hint}`);
    }
    return capText(err.message);
  }
  return capText(err?.message || String(err));
}

function newSession(d) {
  const conn = d.options?.connection || {};
  return {
    sessionId: d.sessionId,
    tabId: d.tabId,
    title: d.title,
    chunks: d.chunks, // [{id,index,text}]
    options: { ...d.options, speed: clampSpeed(d.options?.speed) },
    provider: getProvider(conn.id),
    conn, // { id, base, model, language, voice, apiKey } — in memory only, never persisted here
    index: 0,
    blobs: new Map(), // index -> Blob
    urls: new Map(), // index -> objectURL
    jobs: new Map(), // `${index}:${speedGen}` -> in-flight synth Promise (shared by prefetch and playIndex)
    speedGen: 0, // bumped on every speed change; blobs synthesized under an older gen are discarded
    paused: false,
    stopped: false,
    modelReady: false,
    modelLoading: false, // a loadAndPlay() is in flight; a second one would only queue another load
    releaseTimer: null, // armed while paused: gives the built-in model back after PAUSE_RELEASE_MS
    phase: UI_LOADING,
    loadPhase: PHASE.MODEL, // which kind of "loading" the UI should describe
    progress: null, // { loaded, total } while loadPhase === DOWNLOAD
    engine: "", // "on GPU" / "on CPU" once the built-in provider has chosen (other providers: "")
    loadingSince: Date.now(), // reset whenever a loading phase begins; popup shows the elapsed time
    audioIndex: null,
    pendingIndex: null,
    playRequestId: 0,
    awaitingStart: false, // true between playIndex() and the 'playing' event
    aborter: new AbortController(),
  };
}

function isCurrent(s) {
  return !!s && session === s && !s.stopped;
}

function stateFor(s) {
  if (s.paused) return UI_PAUSED;
  return s.phase === UI_PLAYING ? UI_PLAYING : UI_LOADING;
}

function statePayload(s, state = stateFor(s)) {
  return {
    state,
    phase: state === UI_LOADING ? s.loadPhase : undefined,
    progress: state === UI_LOADING && s.loadPhase === PHASE.DOWNLOAD ? s.progress : undefined,
    startedAt: state === UI_LOADING ? s.loadingSince : undefined,
    index: s.index,
    total: s.chunks.length,
    speed: s.options.speed,
    provider: s.provider.label,
    engine: s.engine || undefined,
    title: s.title,
  };
}

function sendState(s, state = stateFor(s)) {
  if (!isCurrent(s)) return;
  send({ type: MSG.STATE, ...statePayload(s, state), tabId: s.tabId });
}

// Jobs are keyed by index AND speed generation: a stale job re-synthesizing under the new gen
// must never find (and resolve with) its own promise, which is a promise-chaining-cycle TypeError.
function jobKey(s, i) {
  return `${i}:${s.speedGen}`;
}

async function synthChunk(s, i) {
  if (!isCurrent(s)) return null;
  if (s.blobs.has(i)) return s.blobs.get(i);
  const key = jobKey(s, i);
  if (s.jobs.has(key)) return s.jobs.get(key); // prefetch and play both want it: share one request
  const chunk = s.chunks[i];
  if (!chunk) return null;
  const { speed } = s.options;
  const gen = s.speedGen;
  const signal = s.aborter.signal;
  const job = (async () => {
    const out = await withJob(() =>
      isCurrent(s) ? s.provider.synthesize({ conn: s.conn, input: chunk.text, speed, signal }) : null,
    );
    if (!isCurrent(s) || !out) return null;
    // Speed changed while this was in flight: the audio is at the old rate. Re-synthesize
    // (synthChunk will join a newer in-flight job for this index if one exists).
    if (gen !== s.speedGen) return synthChunk(s, i);
    const blob = new Blob([out.bytes], { type: out.mime || "audio/wav" });
    s.blobs.set(i, blob);
    return blob;
  })();
  s.jobs.set(key, job);
  job
    .finally(() => {
      if (s.jobs.get(key) === job) s.jobs.delete(key);
    })
    .catch(() => {}); // the caller observes the rejection; this derived promise must not go unhandled
  return job;
}

function prefetch(s, i) {
  if (!isCurrent(s) || i >= s.chunks.length) return;
  if (s.blobs.has(i) || s.jobs.has(jobKey(s, i))) return;
  synthChunk(s, i).catch(() => {});
}

function urlFor(s, i) {
  if (s.urls.has(i)) return s.urls.get(i);
  const url = URL.createObjectURL(s.blobs.get(i));
  s.urls.set(i, url);
  return url;
}

async function beginPlayback(s, i, requestId) {
  if (!isCurrent(s) || s.paused || s.playRequestId !== requestId) return;
  s.awaitingStart = true;
  s.audioIndex = i;
  audio.src = urlFor(s, i);
  try {
    await audio.play();
  } catch (err) {
    if (!isCurrent(s) || s.paused || err?.name === "AbortError") return;
    fail(s, "Audio playback was blocked: " + err.message);
    return;
  }
  if (isCurrent(s) && !s.paused && s.playRequestId === requestId) prefetch(s, i + 1);
}

async function playIndex(s, i) {
  if (!isCurrent(s)) return;
  s.index = i;
  if (!s.modelReady) {
    // Released during a long pause (or never loaded): reload from the Cache API, then play s.index.
    if (!s.modelLoading) {
      loadAndPlay(s);
      return;
    }
    s.phase = UI_LOADING;
    s.loadPhase = PHASE.MODEL;
    sendState(s, UI_LOADING);
    return;
  }
  const requestId = ++s.playRequestId;
  s.pendingIndex = i;
  if (!s.blobs.has(i)) {
    s.phase = UI_LOADING;
    s.loadPhase = PHASE.SYNTH;
    s.loadingSince = Date.now();
    sendState(s, UI_LOADING);
  }
  let blob;
  try {
    blob = await synthChunk(s, i);
  } catch (err) {
    if (err?.name === "AbortError" || !isCurrent(s) || s.playRequestId !== requestId) return; // deliberate stop/stale request
    fail(s, humanError(err, s));
    return;
  }
  if (!isCurrent(s) || s.playRequestId !== requestId) return;
  s.pendingIndex = null;
  if (!blob) {
    finish(s);
    return;
  }
  if (s.paused) {
    s.phase = UI_PAUSED;
    sendState(s, UI_PAUSED);
    return;
  }
  await beginPlayback(s, i, requestId);
}

/*
 * Keep the serialized job chain scoped to the captured session object above.
 * This prevents delayed prefetch/load work from an old session mutating a newer one.
 */
async function loadSessionModel(s) {
  const signal = s.aborter.signal;
  // Download progress (built-in provider, first run) is throttled to ~4 updates/s so the popup
  // is not flooded; a cache hit emits nothing and the phase stays MODEL.
  let lastSent = 0;
  const onProgress = ({ loaded, total }) => {
    if (!isCurrent(s) || !total) return;
    s.loadPhase = PHASE.DOWNLOAD;
    s.progress = { loaded, total };
    const now = Date.now();
    if (now - lastSent < 250 && loaded < total) return;
    lastSent = now;
    sendState(s); // derived, not UI_LOADING: a pause during the download must stay "paused"
  };
  const result = await withJob(() => (isCurrent(s) ? s.provider.ensureReady(s.conn, { signal, onProgress }) : false));
  if (isCurrent(s)) {
    s.progress = null;
    s.loadPhase = PHASE.MODEL;
    if (result && typeof result.label === "string") s.engine = result.label;
  }
  return result;
}

audio.addEventListener("playing", () => {
  const s = session;
  if (!isCurrent(s)) return;
  if (!s.awaitingStart || s.audioIndex === null) return; // ignore 'playing' fired by resume()
  s.awaitingStart = false;
  keepalive.pause();
  s.phase = UI_PLAYING;
  s.index = s.audioIndex;
  evictBefore(s, s.index - KEEP_BEHIND);
  const c = s.chunks[s.index];
  send({
    type: MSG.CHUNK_STARTED,
    tabId: s.tabId,
    chunkId: c.id,
    index: s.index,
    total: s.chunks.length,
  });
});

audio.addEventListener("ended", () => {
  const s = session;
  if (!isCurrent(s) || s.paused || s.audioIndex === null) return;
  const c = s.chunks[s.audioIndex];
  if (c) send({ type: MSG.CHUNK_ENDED, tabId: s.tabId, chunkId: c.id });
  const next = s.audioIndex + 1;
  s.audioIndex = null;
  if (next < s.chunks.length) playIndex(s, next);
  else finish(s);
});

function stopAudio() {
  try {
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
  } catch {
    /* noop */
  }
}

function revokeUrls(s) {
  if (!s) return;
  for (const url of s.urls.values()) {
    try {
      URL.revokeObjectURL(url);
    } catch {
      /* noop */
    }
  }
}

function evictBefore(s, cutoff) {
  for (const [i, url] of s.urls) {
    if (i < cutoff) { try { URL.revokeObjectURL(url); } catch {} s.urls.delete(i); }
  }
  for (const i of s.blobs.keys()) if (i < cutoff) s.blobs.delete(i);
}

async function startSession(d) {
  stopPreview();
  if (session) {
    const sameTab = session.tabId === d.tabId;
    cleanupSession(session, { notifyDone: !sameTab });
  }
  const s = newSession(d);
  session = s;
  // Reading with another provider now: the built-in model (several hundred MB) has no user left.
  if (s.provider.id !== PROVIDER_IDS.BUILTIN) releaseBuiltinIfUnused();
  await loadAndPlay(s);
}

// Load the session's model, then play from s.index (not 0: a skip() during the load already moved
// it). Used for the first load and for the reload after a long pause released the built-in model.
async function loadAndPlay(s) {
  s.modelReady = false;
  s.modelLoading = true;
  s.phase = UI_LOADING;
  s.loadPhase = PHASE.MODEL;
  s.loadingSince = Date.now();
  sendState(s); // derived: a session paused before its reload stays "paused"
  keepalive.play().catch(() => {});
  try {
    await loadSessionModel(s);
  } catch (err) {
    // Stop/fail already went through cleanupSession, which paused the keepalive tone.
    if (err?.name === "AbortError" || !isCurrent(s)) return; // deliberate stop
    fail(s, humanError(err, s));
    return;
  } finally {
    s.modelLoading = false;
  }
  if (!isCurrent(s)) return;
  s.modelReady = true;
  if (s.paused) {
    sendState(s, UI_PAUSED);
    return;
  }
  playIndex(s, s.index); // not 0: a skip() during the model load already moved s.index
}

/** Free the built-in model unless a live session or preview is using it. */
function releaseBuiltinIfUnused() {
  // A paused built-in session auditioning another provider's voice in Settings has not switched.
  if (isCurrent(session) && session.provider.id === PROVIDER_IDS.BUILTIN) return;
  if (preview && preview.provider.id === PROVIDER_IDS.BUILTIN) return;
  // Not through withJob: release waits for any abandoned generate itself, and must not hold up
  // the new provider's first request behind it.
  releaseBuiltin().catch(() => {});
}

// A built-in session paused this long gives its model back; resume reloads it from the Cache API
// (seconds, no download) and the popup shows the loading phase meanwhile.
function armIdleRelease(s) {
  clearTimeout(s.releaseTimer);
  s.releaseTimer = null;
  if (s.provider.id !== PROVIDER_IDS.BUILTIN) return;
  const pausedAt = Date.now();
  const check = () => {
    s.releaseTimer = null;
    if (!isCurrent(s) || !s.paused || !s.modelReady) return;
    const pausedMs = Date.now() - pausedAt;
    if (!shouldReleaseAfterPause(pausedMs)) {
      s.releaseTimer = setTimeout(check, PAUSE_RELEASE_MS - pausedMs); // timer fired early: wait out the rest
      return;
    }
    if (preview) return; // the Settings preview is borrowing the model; the next pause re-arms
    // The paused chunk's audio is dropped with the model: resume restarts that sentence (its WAV
    // is still in s.blobs, so only the model reload costs time, not the synthesis).
    stopAudio();
    s.awaitingStart = false;
    s.audioIndex = null;
    s.pendingIndex = null;
    s.modelReady = false; // playIndex must reload, not synthesize with a disposed model
    releaseBuiltin().catch(() => {});
  };
  s.releaseTimer = setTimeout(check, PAUSE_RELEASE_MS);
}

function pause() {
  const s = session;
  if (!isCurrent(s)) return;
  s.paused = true;
  s.phase = UI_PAUSED;
  audio.pause();
  keepalive.play().catch(() => {});
  armIdleRelease(s);
  sendState(s, UI_PAUSED);
}

function resume() {
  const s = session;
  if (!isCurrent(s)) return;
  clearTimeout(s.releaseTimer);
  s.releaseTimer = null;
  // Still loading: the keepalive tone is the only audible output keeping this document alive
  // through the download, so leave it running; startSession plays once the model is ready.
  if (!s.modelReady) {
    s.paused = false;
    if (!s.modelLoading) {
      loadAndPlay(s); // the model was released during a long pause: reload it, then play
      return;
    }
    s.phase = UI_LOADING;
    sendState(s);
    return;
  }
  s.paused = false;
  if (s.audioIndex === s.index && audio.src && audio.paused) {
    keepalive.pause();
    audio.play().catch((err) => {
      if (isCurrent(s) && !s.paused) fail(s, "Audio playback was blocked: " + err.message);
    });
    s.phase = UI_PLAYING;
    sendState(s, UI_PLAYING);
    return;
  }
  if (s.pendingIndex === s.index) {
    sendState(s, UI_LOADING);
    return;
  }
  keepalive.pause();
  playIndex(s, s.index);
}

function skip(delta) {
  const s = session;
  if (!isCurrent(s)) return;
  // Clear the highlight on the chunk we're leaving.
  const current = s.chunks[s.index];
  if (current) send({ type: MSG.CHUNK_ENDED, tabId: s.tabId, chunkId: current.id });
  stopAudio();
  s.awaitingStart = false;
  s.audioIndex = null;
  const target = Math.min(s.chunks.length - 1, Math.max(0, s.index + delta));
  s.paused = false;
  playIndex(s, target);
}

// Change playback speed for the live session. Everything synthesized at the old rate is
// discarded and the current sentence restarts at the new rate (OpenVox has no streaming, so
// this is the closest thing to an instant speed change). In-flight synth jobs re-run via
// the speedGen check in synthChunk.
function setSpeed(raw) {
  const s = session;
  if (!isCurrent(s)) return;
  const speed = clampSpeed(raw);
  if (speed === s.options.speed) return;
  s.options.speed = speed;
  s.speedGen++;
  stopAudio();
  s.awaitingStart = false;
  s.audioIndex = null;
  revokeUrls(s);
  s.urls.clear();
  s.blobs.clear();
  if (s.modelReady && !s.paused) playIndex(s, s.index);
  else sendState(s);
}

function cleanupSession(s, { abort = true, notifyDone = true } = {}) {
  if (!s) return null;
  const tabId = s.tabId;
  s.stopped = true;
  clearTimeout(s.releaseTimer);
  s.releaseTimer = null;
  if (abort) {
    try {
      s.aborter.abort();
    } catch {
      /* noop */
    }
  }
  stopAudio();
  keepalive.pause();
  revokeUrls(s);
  if (session === s) session = null;
  if (notifyDone) send({ type: MSG.SESSION_DONE, tabId });
  return tabId;
}

function finish(s = session) {
  if (!isCurrent(s)) return;
  cleanupSession(s);
  send({ type: MSG.STATE, state: "done" });
}

function fail(s, message) {
  const tabId = cleanupSession(s);
  send({ type: MSG.ERROR, tabId, message });
}

function stop({ notify = true } = {}) {
  const s = session;
  if (!s) {
    if (notify) send({ type: MSG.STATE, state: "idle" });
    return;
  }
  cleanupSession(s);
  if (notify) {
    send({ type: MSG.STATE, state: "idle" });
  }
}

// ---- voice preview (Settings page) -------------------------------------------
// Runs here, not in the options page, for two reasons: the built-in model lives in this document
// (a second copy would double memory and the download), and OpenVox returns 429 to overlapping
// calls, which the single-job lock prevents. One short phrase, played on its own <audio>.
const previewAudio = new Audio();
let preview = null; // { previewId, conn, provider, aborter, startedAt }

function sendPreview(p, patch) {
  if (!p || preview !== p) return;
  send({ type: MSG.PREVIEW_STATE, previewId: p.previewId, startedAt: p.startedAt, ...patch });
}

function stopPreview({ notify = true } = {}) {
  const p = preview;
  if (!p) return;
  preview = null;
  try {
    p.aborter.abort();
  } catch {
    /* noop */
  }
  previewAudio.pause();
  if (previewAudio.src) {
    URL.revokeObjectURL(previewAudio.src);
    previewAudio.removeAttribute("src");
  }
  if (!session) keepalive.pause();
  if (notify) send({ type: MSG.PREVIEW_STATE, previewId: p.previewId, state: "done" });
}

async function startPreview({ connection, text, previewId }) {
  if (session && !session.paused) {
    send({ type: MSG.PREVIEW_STATE, previewId, state: "error", message: "Pause or stop reading first, then try the preview." });
    return;
  }
  stopPreview({ notify: false });
  const conn = connection || {};
  const p = { previewId, conn, provider: getProvider(conn.id), aborter: new AbortController(), startedAt: Date.now() };
  preview = p;
  if (p.provider.id !== PROVIDER_IDS.BUILTIN) releaseBuiltinIfUnused();
  const signal = p.aborter.signal;
  keepalive.play().catch(() => {}); // a cold Kokoro Web / built-in load can exceed the 30 s reaper
  sendPreview(p, { state: "loading", phase: PHASE.MODEL, engine: undefined });
  try {
    let lastSent = 0;
    const onProgress = ({ loaded, total }) => {
      if (preview !== p || !total) return;
      const now = Date.now();
      if (now - lastSent < 250 && loaded < total) return;
      lastSent = now;
      sendPreview(p, { state: "loading", phase: PHASE.DOWNLOAD, progress: { loaded, total } });
    };
    const ready = await withJob(() => (preview === p ? p.provider.ensureReady(conn, { signal, onProgress }) : false));
    if (preview !== p) return;
    const engine = ready && typeof ready.label === "string" ? ready.label : undefined;
    sendPreview(p, { state: "loading", phase: PHASE.SYNTH, engine });
    const out = await withJob(() =>
      preview === p ? p.provider.synthesize({ conn, input: text, speed: 1.0, signal }) : null,
    );
    if (preview !== p || !out) return;
    const blob = new Blob([out.bytes], { type: out.mime || "audio/wav" });
    previewAudio.src = URL.createObjectURL(blob);
    previewAudio.onended = () => {
      if (preview === p) stopPreview();
    };
    await previewAudio.play();
    sendPreview(p, { state: "playing", engine });
  } catch (err) {
    if (preview !== p || err?.name === "AbortError") return;
    const message = humanError(err, { provider: p.provider, conn });
    preview = null;
    if (!session) keepalive.pause();
    send({ type: MSG.PREVIEW_STATE, previewId, state: "error", message });
  }
}


chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== MSG.TARGET_OFFSCREEN) return;
  // Only this extension's own non-tab contexts (in practice the service worker, which relays for
  // the popup and options page): a content script runs in a page renderer and must not be able
  // to start sessions or inject a connection.
  if (!sender || sender.id !== chrome.runtime.id || sender.tab) return;
  switch (msg.type) {
    case MSG.SESSION_START:
      startSession(msg);
      sendResponse({ ok: true });
      return;
    case MSG.SESSION_PAUSE:
      pause();
      sendResponse({ ok: true });
      return;
    case MSG.SESSION_RESUME:
      resume();
      sendResponse({ ok: true });
      return;
    case MSG.SESSION_STOP:
      stop();
      sendResponse({ ok: true });
      return;
    case MSG.SESSION_SKIP_NEXT:
      skip(1);
      sendResponse({ ok: true });
      return;
    case MSG.SESSION_SKIP_PREV:
      skip(-1);
      sendResponse({ ok: true });
      return;
    case MSG.SESSION_REREAD:
      skip(0);
      sendResponse({ ok: true });
      return;
    case MSG.SESSION_SET_SPEED:
      setSpeed(msg.speed);
      sendResponse({ ok: true });
      return;
    case MSG.SESSION_PREVIEW:
      startPreview(msg);
      sendResponse({ ok: true });
      return;
    case MSG.SESSION_PREVIEW_STOP:
      stopPreview();
      sendResponse({ ok: true });
      return;
    case MSG.GET_STATE:
      if (session) sendResponse(statePayload(session));
      else sendResponse({ state: "idle" });
      return;
  }
});
