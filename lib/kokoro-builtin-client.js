// lib/kokoro-builtin-client.js — run Kokoro-82M inside the extension (offscreen document) via
// kokoro-js + ONNX Runtime Web. No server, no remote code: the JS bundle and the ORT wasm live in
// vendor/ (built by `npm run build`); only the model weights and voice vectors are fetched, from
// huggingface.co, once, into the Cache API.
//
// Module top level is inert (no navigator/chrome access) so the provider registry can be imported
// in Node tests. Everything that touches the browser is inside functions.
import { TtsError } from "./tts-error.js";
import {
  canReuseBuiltinLoad,
  chooseBuiltinDevice,
  LoadWaiters,
  makeLoadAbortingFetch,
} from "./kokoro-builtin-device.js";
import { isValidBuiltinVoice } from "./kokoro-voices.js";

export const KOKORO_BUILTIN_MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";
const BUNDLE_PATH = "vendor/kokoro.bundle.js";
const ORT_PATH = "vendor/ort/";

let runtime = null; // { tts, decision, requestedPref, inflight } for the loaded model
// The in-flight load, so compatible callers share one download:
// { pref, promise, controller, waiters } — `controller` cancels the transfer once `waiters` empties.
let loading = null;

// Cancellation hook. transformers.js 3.8.1 (and kokoro-js's voice loader) download with a bare
// `fetch(url)` and offer no fetch override: `env` has useCustomCache/customCache for storage but
// nothing for the request, and getFile() passes no signal. So the only way to stop the bytes is to
// wrap globalThis.fetch. This module only loads a model inside the offscreen document (our own
// page), so the wrapper is scoped to that document; it touches only huggingface.co / hf.co URLs and
// only while a load is in flight, and otherwise calls the original fetch unchanged.
// Per-file caching in transformers.js means an abort mid-file loses only that file: everything that
// finished is already in the Cache API and the next load reads it back instead of re-downloading.
let hookedFetch = null;
function installFetchHook() {
  if (typeof globalThis.fetch !== "function" || globalThis.fetch === hookedFetch) return;
  const base = globalThis.fetch.__openvoxBase || globalThis.fetch;
  hookedFetch = makeLoadAbortingFetch(base, () => loading?.controller.signal ?? null);
  globalThis.fetch = hookedFetch;
}

const abortError = () => new DOMException("Aborted", "AbortError");

/** Release the ONNX sessions (GPU buffers / WASM heap). Best effort: a failed dispose only leaks. */
async function disposeTts(tts) {
  try {
    await tts?.model?.dispose?.();
  } catch {
    /* already gone */
  }
}

async function probeEnvironment() {
  const out = {
    hasAdapter: false,
    isFallbackAdapter: false,
    crossOriginIsolated: globalThis.crossOriginIsolated === true,
    hardwareConcurrency: navigator.hardwareConcurrency,
  };
  if ("gpu" in navigator) {
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter) {
        out.hasAdapter = true;
        out.isFallbackAdapter = adapter.isFallbackAdapter === true;
      }
    } catch {
      /* no WebGPU: stay on wasm */
    }
  }
  return out;
}

async function importBundle() {
  try {
    return await import(chrome.runtime.getURL(BUNDLE_PATH));
  } catch (err) {
    throw new TtsError(
      "The built-in voice bundle is missing. Run `npm run build` in the extension folder and reload the extension.",
      { status: 0, cause: err },
    );
  }
}

function raceAbort(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/**
 * Load (or reuse) the model. `onProgress({ loaded, total, file })` reports weight download; it is
 * silent on cache hits. Resolves to the device decision so the UI can say "on GPU" / "on CPU".
 * The model stays loaded until releaseBuiltin() (provider switch, long pause) or a reload for a
 * different device. Aborting `signal` abandons this caller's wait; when every caller sharing the
 * load has aborted, the download itself is cancelled.
 */
export async function ensureBuiltinLoaded({ devicePref, signal, onProgress } = {}) {
  try {
    for (;;) {
      if (signal?.aborted) throw abortError();
      if (runtime && canReuseBuiltinLoad({ requestedPref: runtime.requestedPref, device: runtime.decision.device }, devicePref)) {
        return runtime.decision;
      }
      // A load whose waiters all left is already cancelling: start over rather than join it.
      if (!loading || loading.controller.signal.aborted) loading = startLoad(devicePref, onProgress);
      // Join only a load for a compatible pref; otherwise let it land, then re-check and load our own.
      if (canReuseBuiltinLoad({ requestedPref: loading.pref }, devicePref)) {
        loading.waiters.add(signal);
        return await raceAbort(loading.promise, signal);
      }
      await raceAbort(loading.promise.catch(() => {}), signal);
    }
  } catch (err) {
    if (err?.name === "AbortError") throw err;
    if (err instanceof TtsError) throw err;
    throw new TtsError(humanLoadError(err), { status: 0, cause: err });
  }
}

function startLoad(devicePref, onProgress) {
  const controller = new AbortController();
  const entry = { pref: devicePref, promise: null, controller, waiters: new LoadWaiters(() => controller.abort()) };
  const { signal } = controller;
  entry.promise = (async () => {
    installFetchHook();
    const { KokoroTTS, env } = await importBundle();
    if (signal.aborted) throw abortError();
    const decision = chooseBuiltinDevice(await probeEnvironment(), devicePref);
    env.allowLocalModels = false;
    env.allowRemoteModels = true;
    env.useBrowserCache = true;
    env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL(ORT_PATH);
    env.backends.onnx.wasm.numThreads = decision.numThreads;
    env.backends.onnx.wasm.proxy = false;
    const totals = new Map();
    const loadedBytes = new Map();
    let tts;
    try {
      tts = await KokoroTTS.from_pretrained(KOKORO_BUILTIN_MODEL_ID, {
        dtype: decision.dtype,
        device: decision.device,
        progress_callback: (p) => {
          if (p.status !== "progress" || !p.file || !onProgress) return;
          totals.set(p.file, p.total || 0);
          loadedBytes.set(p.file, p.loaded || 0);
          const sum = (m) => [...m.values()].reduce((a, b) => a + b, 0);
          onProgress({ loaded: sum(loadedBytes), total: sum(totals), file: p.file });
        },
      });
    } catch (err) {
      if (signal.aborted) throw abortError(); // however the library wrapped the cancelled fetch
      throw err;
    }
    if (signal.aborted) {
      // Fallback for a load the fetch hook could not stop: every file was a cache hit, or the
      // abort landed while ORT was building sessions. Nobody is waiting for this model, so give
      // its memory back now instead of keeping it for a session that no longer exists; the bytes
      // are in the Cache API, so the next load is cheap.
      await disposeTts(tts);
      throw abortError();
    }
    const previous = runtime; // a reload for another device replaces it: free the old copy
    runtime = { tts, decision, requestedPref: devicePref, busy: new Set() };
    if (previous) releaseRuntime(previous);
    return decision;
  })().finally(() => {
    entry.waiters.close();
    if (loading === entry) loading = null;
  });
  entry.promise.catch(() => {}); // an abandoned load may reject with nobody left to observe it
  return entry;
}

async function releaseRuntime(r) {
  // A generate abandoned by its caller (Stop mid-chunk) is still running on these ONNX sessions;
  // disposing them under it would fail that run in ways we cannot report. Let it finish first.
  await Promise.allSettled([...r.busy]);
  await disposeTts(r.tts);
}

/**
 * Free the loaded model (several hundred MB of GPU buffers or WASM heap). Safe with nothing loaded.
 * The next ensureBuiltinLoaded() reloads it from the Cache API, without a download.
 */
export async function releaseBuiltin() {
  const r = runtime;
  if (!r) return;
  runtime = null; // first, so a synth racing the dispose says "not loaded" instead of using it
  await releaseRuntime(r);
}

const MAX_ERROR_CHARS = 300; // library/network text is unbounded; keep the popup line readable

function humanLoadError(err) {
  const m = String(err?.message || err);
  if (/fetch|network|Failed to load|404|403/i.test(m)) {
    return "Couldn't download the voice model from huggingface.co. Check your internet connection and try again.";
  }
  const text = `Couldn't start the built-in voice: ${m}`;
  return text.length > MAX_ERROR_CHARS ? text.slice(0, MAX_ERROR_CHARS - 1) + "…" : text;
}

/** Synthesize one chunk to WAV bytes. Requires ensureBuiltinLoaded() to have resolved. */
export async function synthesizeBuiltinWav({ input, voice, speed = 1.0, signal } = {}) {
  if (!runtime) throw new TtsError("Built-in voice is not loaded yet.", { status: 0 });
  if (!isValidBuiltinVoice(voice)) throw new TtsError(`Unknown built-in voice "${voice}" — pick one in Settings.`, { status: 400 });
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const r = runtime;
  const run = Promise.resolve(r.tts.generate(input, { voice, speed }));
  // Tracked even if our caller abandons it, so releaseBuiltin() waits before disposing under it.
  r.busy.add(run);
  run.then(
    () => r.busy.delete(run),
    () => r.busy.delete(run),
  );
  const audio = await raceAbort(run, signal);
  return audio.toWav(); // ArrayBuffer, RIFF/WAVE, 24 kHz mono float
}

/** The current device decision, or null before the first load. */
export function builtinDecision() {
  return runtime?.decision || null;
}
