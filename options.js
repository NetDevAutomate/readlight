// options.js — load/save settings and populate the model/language/voice pickers from the
// selected TTS provider's live API. Loaded as an ES module so it can import the provider registry.
import { clampSpeed } from "./lib/openvox-client.js";
import { MSG } from "./lib/message-types.js";
import { getProvider, listProviders } from "./lib/tts-providers.js";
import { BUILTIN_DEVICE_PREFS } from "./lib/kokoro-builtin-device.js";
import { CONSENT_PENDING, CONSENT_STATE, consentCopy } from "./lib/builtin-consent.js";
import { voiceLabel } from "./lib/voice-label.js";
import {
  SPEED_PRESETS,
  CODE_BLOCKS,
  connectionKeys,
  getSettings,
  getLocalSecrets,
  setBuiltinDevice,
} from "./lib/settings.js";

const $ = (id) => document.getElementById(id);

const OPENVOX_DEFAULT_PATTERN = "http://127.0.0.1:8005/*"; // the only origin granted at install

let settings = null; // last loaded chrome.storage.sync snapshot
let secrets = null; // last loaded chrome.storage.local snapshot (secrets, built-in consent + device)
let provider = null; // active provider object

// ---- form <-> connection ---------------------------------------------------
const rawBase = () => $("base").value.trim() || provider.defaultBase;
const baseUrl = () => (provider.hasBaseUrl ? provider.normalizeBase(rawBase()) : "");

function formConnection() {
  const formula = provider.voiceFormulaAllowed ? $("voiceFormula").value.trim() : "";
  return {
    id: provider.id,
    base: baseUrl(),
    model: $("model").value,
    language: $("language").value,
    voice: formula || $("voice").value,
    apiKey: provider.needsApiKey ? $("apiKey").value : "",
  };
}

// Connection stored for `provider` (its own keys; defaults when never saved).
function storedConnection(p) {
  const keys = connectionKeys(p.id);
  const pick = (k, fb) => (typeof settings[k] === "string" && settings[k].trim() ? settings[k] : fb);
  return {
    id: p.id,
    base: pick(keys.base, p.defaultBase),
    model: pick(keys.model, p.defaults.model),
    language: pick(keys.language, p.defaults.language),
    voice: pick(keys.voice, p.defaults.voice),
    apiKey: p.needsApiKey ? secrets.kokoroApiKey || "" : "",
  };
}

function originPattern(base) {
  if (!base) return null; // built-in provider: no server, no origin
  const url = new URL(base);
  return `${url.protocol}//${url.host}/*`;
}

// ---- small UI helpers ------------------------------------------------------
function setStatus(message, className = "", timeout = 1500) {
  const st = $("status");
  st.textContent = message;
  st.className = className;
  if (timeout) {
    setTimeout(() => {
      st.textContent = "";
      st.className = "";
    }, timeout);
  }
}

function fillSelect(sel, items, selected) {
  sel.replaceChildren();
  for (const it of items) {
    const o = document.createElement("option");
    o.value = it.value;
    o.textContent = it.label;
    if (it.value === selected) o.selected = true;
    sel.appendChild(o);
  }
  if (items.length && !items.some((i) => i.value === selected)) sel.selectedIndex = 0;
}

function setConn(ok, msg) {
  const c = $("conn");
  c.textContent = ok ? "Connected ✓" : "Not reachable — " + (msg || `is ${provider.label} running?`);
  c.className = ok ? "ok" : "err";
}

// Chrome only lets the extension reach origins it holds a host permission for. Only OpenVox's
// default is granted at install, so any other server (including Kokoro Web's default
// 127.0.0.1:3000) must be requested — before Test as well as before Save, or a perfectly
// healthy server reads as "Not reachable" because the fetch itself is blocked.
async function ensureOriginPermission(pattern) {
  if (!pattern || pattern === OPENVOX_DEFAULT_PATTERN) return true;
  if (await chrome.permissions.contains({ origins: [pattern] })) return true;
  return chrome.permissions.request({ origins: [pattern] });
}

function connectionProblem(err) {
  if (err?.status === 401 || err?.status === 403) return "the server rejected the API key (check the API key field)";
  if (err?.status) return `server answered ${err.status}`;
  return err?.message || "no response";
}

const PROVIDER_HELP = {
  builtin:
    "Kokoro-82M running inside the browser. Nothing to install and no server: the text never leaves your computer. " +
    "On first use the voice model is downloaded once from huggingface.co and cached.",
  openvox: "The OpenVox desktop app with its Local API enabled. Default http://127.0.0.1:8005/v1.",
  "kokoro-web":
    "A self-hosted Kokoro Web container (ghcr.io/eduardolat/kokoro-web). Default http://127.0.0.1:3000/api/v1. " +
    "The first sentence after a model change can take a while: the server downloads the model on first use.",
};

function applyProviderUi() {
  $("providerHelp").textContent = PROVIDER_HELP[provider.id] || "";
  $("serverRows").hidden = !provider.hasBaseUrl;
  $("deviceRow").hidden = provider.id !== "builtin";
  $("apiKeyRow").hidden = !provider.needsApiKey;
  $("voiceFormulaRow").hidden = !provider.voiceFormulaAllowed;
}

// ---- live pickers ----------------------------------------------------------
// Each populate* takes the connection to select from, so a change in one picker cascades.
async function populateModels(conn) {
  try {
    const models = await provider.listModels(conn);
    fillSelect($("model"), models.map((m) => ({ value: m.id, label: m.label })), conn.model);
    setConn(true);
  } catch (e) {
    fillSelect($("model"), [{ value: conn.model, label: conn.model }], conn.model);
    setConn(false, e.message);
    // Still show the stored language/voice so Save keeps them.
    fillSelect($("language"), [{ value: conn.language, label: conn.language }], conn.language);
    fillSelect($("voice"), [{ value: conn.voice, label: conn.voice }], conn.voice);
    return;
  }
  await populateLanguages({ ...conn, model: $("model").value });
}

async function populateLanguages(conn) {
  try {
    const langs = await provider.listLanguages(conn);
    fillSelect($("language"), langs.map((l) => ({ value: l.code, label: l.name })), conn.language);
  } catch {
    fillSelect($("language"), [{ value: conn.language, label: conn.language }], conn.language);
  }
  await populateVoices({ ...conn, language: $("language").value });
}

async function populateVoices(conn) {
  try {
    const voices = await provider.listVoices(conn);
    fillSelect(
      $("voice"),
      voices.map((v) => ({ value: v.id, label: voiceLabel(v) })),
      conn.voice,
    );
  } catch {
    fillSelect($("voice"), [{ value: conn.voice, label: conn.voice }], conn.voice);
  }
}

// Switch the form to a provider, loading that provider's stored connection.
async function showProvider(id) {
  provider = getProvider(id);
  $("provider").value = provider.id;
  applyProviderUi();
  const conn = storedConnection(provider);
  $("base").value = conn.base;
  $("apiKey").value = conn.apiKey;
  // A voice containing an operator is a formula: show it in the formula box, not the picker.
  const isFormula = provider.voiceFormulaAllowed && /[*+]/.test(conn.voice);
  $("voiceFormula").value = isFormula ? conn.voice : "";
  await populateModels(isFormula ? { ...conn, voice: provider.defaults.voice } : conn);
}

// ---- load / save -----------------------------------------------------------
async function load() {
  [settings, secrets] = await Promise.all([getSettings(), getLocalSecrets()]);
  fillSelect(
    $("provider"),
    listProviders().map((p) => ({ value: p.id, label: p.label })),
    settings.provider,
  );
  fillSelect(
    $("speed"),
    SPEED_PRESETS.map(([value, label]) => ({ value: String(value), label })),
    String(clampSpeed(settings.speed)),
  );
  fillSelect(
    $("codeBlocks"),
    [
      { value: CODE_BLOCKS.ANNOUNCE, label: "Announce — “Python code block, 12 lines.” (recommended)" },
      { value: CODE_BLOCKS.SKIP, label: "Skip — don't mention code blocks at all" },
      { value: CODE_BLOCKS.VERBATIM, label: "Read verbatim — speak the code as text" },
    ],
    settings.codeBlocks,
  );
  fillSelect(
    $("builtinDevice"),
    [
      { value: BUILTIN_DEVICE_PREFS.AUTO, label: "Automatic — GPU when available, otherwise CPU (recommended)" },
      { value: BUILTIN_DEVICE_PREFS.WEBGPU, label: "GPU (WebGPU) — 326 MB model, fastest" },
      { value: BUILTIN_DEVICE_PREFS.WASM, label: "CPU — 92 MB model, slower" },
    ],
    secrets.builtinDevice,
  );
  $("highlightEnabled").checked = settings.highlightEnabled;
  $("highlightColor").value = settings.highlightColor;
  $("highlightOpacity").value = settings.highlightOpacity;
  $("autoScroll").checked = settings.autoScroll;
  $("chunkTargetChars").value = settings.chunkTargetChars;
  $("chunkMaxChars").value = settings.chunkMaxChars;
  renderConsentStatus();
  await showProvider(settings.provider);
}

$("provider").addEventListener("change", () => showProvider($("provider").value));
$("model").addEventListener("change", () => populateLanguages(formConnection()));
$("language").addEventListener("change", () => populateVoices(formConnection()));
$("test").addEventListener("click", async () => {
  try {
    const conn = formConnection();
    if (!(await ensureOriginPermission(originPattern(conn.base)))) {
      setConn(false, "permission to connect to that origin was declined");
      return;
    }
    // listLanguages rather than ping: ping swallows the status, and a 401 must read differently
    // from a server that is down.
    await provider.listLanguages(conn);
    setConn(true);
    await populateModels(conn);
  } catch (e) {
    setConn(false, connectionProblem(e));
  }
});

// ---- voice preview --------------------------------------------------------------
// Synthesised by the offscreen document (where the built-in model lives and the one-job lock is),
// with the connection the form holds right now, saved or not.
const PREVIEW_TEXT = "Hello! This is how I sound when reading your pages aloud.";
let previewId = null;
let previewTimer = null;
let previewStartedAt = 0;

function mmss(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function setPreviewStatus(text, className = "") {
  const el = $("previewStatus");
  el.textContent = text;
  el.className = `muted ${className}`.trim();
}

function stopPreviewTimer() {
  if (previewTimer) clearInterval(previewTimer);
  previewTimer = null;
}

function previewLoadingText(msg) {
  const elapsed = previewStartedAt ? ` · ${mmss(Date.now() - previewStartedAt)}` : "";
  if (msg.phase === "download" && msg.progress?.total >= 1e6) {
    const pct = Math.min(100, Math.floor((msg.progress.loaded / msg.progress.total) * 100));
    return `Downloading the voice model… ${pct}% (one time only)${elapsed}`;
  }
  if (msg.phase === "synth") return `Generating…${elapsed}`;
  return `Loading the voice model… (first load can take a while)${elapsed}`;
}

function renderPreview(msg) {
  if (!previewId || msg.previewId !== previewId) return;
  const btn = $("preview");
  switch (msg.state) {
    case "loading":
      if (msg.startedAt) previewStartedAt = msg.startedAt;
      btn.textContent = "■ Stop";
      stopPreviewTimer();
      previewTimer = setInterval(() => setPreviewStatus(previewLoadingText(msg)), 1000);
      setPreviewStatus(previewLoadingText(msg));
      break;
    case "playing":
      stopPreviewTimer();
      btn.textContent = "■ Stop";
      setPreviewStatus(`Playing${msg.engine ? " " + msg.engine : ""}…`);
      break;
    case "error":
      stopPreviewTimer();
      previewId = null;
      btn.textContent = "▶ Preview";
      setPreviewStatus(msg.message || "Preview failed.", "err");
      break;
    case CONSENT_STATE:
      // The service worker will not start the built-in model's first download unasked.
      stopPreviewTimer();
      previewId = null;
      btn.textContent = "▶ Preview";
      setPreviewStatus("Allow the one-time voice model download first (“Allow and preview” above).", "err");
      if (secrets) secrets = { ...secrets, builtinConsent: false };
      renderConsentStatus().then(() => $("allowPreview").focus());
      break;
    case "done":
    default:
      stopPreviewTimer();
      previewId = null;
      btn.textContent = "▶ Preview";
      setPreviewStatus("");
  }
}

$("preview").addEventListener("click", async () => {
  if (previewId) {
    chrome.runtime.sendMessage({ target: MSG.TARGET_SW, type: MSG.PREVIEW_STOP }).catch(() => {});
    renderPreview({ previewId, state: "done" });
    return;
  }
  sendPreview(MSG.PREVIEW_VOICE);
});

// PREVIEW_VOICE, or GRANT_BUILTIN_CONSENT with pending "preview" (same payload plus the device),
// which stores the download consent and then previews in one click.
async function sendPreview(type) {
  let conn;
  try {
    conn = formConnection();
    if (!(await ensureOriginPermission(originPattern(conn.base)))) {
      setPreviewStatus("Permission to connect to that origin was declined.", "err");
      return;
    }
  } catch (e) {
    setPreviewStatus(e.message, "err");
    return;
  }
  if (provider.id === "builtin") conn.device = $("builtinDevice").value;
  const extra = type === MSG.GRANT_BUILTIN_CONSENT ? { device: $("builtinDevice").value, pending: CONSENT_PENDING.PREVIEW } : {};
  previewId = `p${Date.now()}`;
  previewStartedAt = Date.now();
  renderPreview({ previewId, state: "loading", phase: "model", startedAt: previewStartedAt });
  chrome.runtime
    .sendMessage({ target: MSG.TARGET_SW, type, connection: conn, text: PREVIEW_TEXT, previewId, ...extra })
    .catch((e) => renderPreview({ previewId, state: "error", message: e.message }));
}

// ---- built-in download consent ---------------------------------------------------
// The popup asks on first read; this line says where things stand and lets the user agree here.
let gpuEnv = null;

async function probeEnv() {
  if (gpuEnv) return gpuEnv;
  let adapter = null;
  try {
    adapter = navigator.gpu ? await navigator.gpu.requestAdapter() : null;
  } catch {
    /* no WebGPU here */
  }
  gpuEnv = {
    hasAdapter: !!adapter,
    isFallbackAdapter: adapter?.info?.isFallbackAdapter === true || adapter?.isFallbackAdapter === true,
    crossOriginIsolated: self.crossOriginIsolated === true,
    hardwareConcurrency: navigator.hardwareConcurrency,
  };
  return gpuEnv;
}

async function renderConsentStatus() {
  const allowed = secrets?.builtinConsent === true;
  const { sizeLabel } = consentCopy($("builtinDevice").value, await probeEnv());
  $("consentStatus").textContent = allowed ? `Model download: allowed (about ${sizeLabel})` : "Model download: not yet allowed";
  $("allowPreview").hidden = allowed;
}

$("builtinDevice").addEventListener("change", () => renderConsentStatus());
$("allowPreview").addEventListener("click", () => {
  if (previewId) {
    chrome.runtime.sendMessage({ target: MSG.TARGET_SW, type: MSG.PREVIEW_STOP }).catch(() => {});
    renderPreview({ previewId, state: "done" });
  }
  sendPreview(MSG.GRANT_BUILTIN_CONSENT);
});

// Consent may be granted from the popup while this page is open, or by Allow and preview.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !secrets) return;
  if ("builtinConsent" in changes) {
    secrets = { ...secrets, builtinConsent: changes.builtinConsent.newValue === true };
    renderConsentStatus();
  }
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.target === MSG.TARGET_OPTIONS && msg.type === MSG.PREVIEW_STATE) renderPreview(msg);
});

// Changing the voice while a preview plays: stop it, so the next click previews the new voice.
$("voice").addEventListener("change", () => {
  if (previewId) $("preview").click();
});

$("save").addEventListener("click", async () => {
  let conn;
  let pattern;
  try {
    conn = formConnection();
    pattern = originPattern(conn.base);
  } catch (e) {
    setStatus(e.message, "err", 2500);
    return;
  }

  // Host permission: only the OpenVox default origin is granted at install. Anything else
  // (including Kokoro's default 127.0.0.1:3000) is requested for that one origin on save.
  // The built-in provider has no origin (pattern === null) and skips this entirely.
  // permissions.request rejects (rather than resolving false) for a pattern Chrome cannot
  // grant, so catch it like Test/Preview do or the click fails with no status at all.
  let granted;
  try {
    granted = await ensureOriginPermission(pattern);
  } catch (e) {
    setStatus(e.message, "err", 2500);
    return;
  }
  if (!granted) {
    setStatus("Permission denied — cannot reach that endpoint", "err", 2500);
    return; // do not save
  }

  // Revoke the previously saved origin for THIS provider if it changed (and isn't the install default).
  const prev = storedConnection(provider);
  let prevPattern = null;
  try {
    prevPattern = originPattern(prev.base);
  } catch {
    /* unparseable legacy value */
  }

  let target = parseInt($("chunkTargetChars").value, 10) || 180;
  let max = parseInt($("chunkMaxChars").value, 10) || 260;
  if (target < 40) target = 40;
  if (max < target) max = target;

  const keys = connectionKeys(provider.id);
  const data = {
    provider: provider.id,
    [keys.base]: conn.base,
    [keys.model]: conn.model,
    [keys.language]: conn.language,
    [keys.voice]: conn.voice,
    speed: clampSpeed($("speed").value),
    codeBlocks: $("codeBlocks").value,
    highlightEnabled: $("highlightEnabled").checked,
    highlightColor: $("highlightColor").value,
    highlightOpacity: parseFloat($("highlightOpacity").value),
    autoScroll: $("autoScroll").checked,
    chunkTargetChars: target,
    chunkMaxChars: max,
  };
  if (provider.id === "builtin") await setBuiltinDevice($("builtinDevice").value);
  await chrome.storage.sync.set(data);
  if (provider.needsApiKey) {
    // Only the key: storage.local also holds the built-in consent and device, which spreading
    // LOCAL_DEFAULTS here would silently reset.
    await chrome.storage.local.set({ kokoroApiKey: conn.apiKey });
  }

  if (prevPattern && prevPattern !== pattern && prevPattern !== OPENVOX_DEFAULT_PATTERN) {
    // Only drop it if no other provider still points at that origin.
    const others = listProviders()
      .filter((p) => p.id !== provider.id)
      .map((p) => {
        try {
          return originPattern(storedConnection(p).base);
        } catch {
          return null;
        }
      });
    if (!others.includes(prevPattern)) chrome.permissions.remove({ origins: [prevPattern] }).catch(() => {});
  }

  [settings, secrets] = await Promise.all([getSettings(), getLocalSecrets()]);
  revokeUnsavedOrigins().catch(() => {});
  setStatus("Saved ✓", "ok");
});

// Test and Preview request an origin before anything is saved, so trying a server and then
// not saving it would leave that grant forever. On Save, keep only the origins some provider
// actually has saved (plus the install-time host_permissions) and drop every other optional grant.
async function revokeUnsavedOrigins() {
  const kept = new Set(chrome.runtime.getManifest().host_permissions || []);
  kept.add(OPENVOX_DEFAULT_PATTERN);
  const withBase = listProviders().filter((p) => p.hasBaseUrl);
  // Raw read, not getSettings(): that merges DEFAULTS, which would make Kokoro's default base
  // look saved and keep a 127.0.0.1:3000 grant the user only ever tested.
  const stored = await chrome.storage.sync.get(withBase.map((p) => connectionKeys(p.id).base));
  for (const p of withBase) {
    const saved = stored[connectionKeys(p.id).base];
    if (typeof saved !== "string" || !saved.trim()) continue; // never saved: nothing to keep
    try {
      kept.add(originPattern(saved));
    } catch {
      /* unparseable legacy value */
    }
  }
  const { origins = [] } = await chrome.permissions.getAll();
  // Only http(s) patterns: that is all optional_host_permissions can grant.
  const stale = origins.filter((o) => /^https?:\/\//.test(o) && !kept.has(o));
  if (stale.length) await chrome.permissions.remove({ origins: stale });
}

load();
