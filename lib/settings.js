// lib/settings.js — single source of truth for user settings (chrome.storage.sync).
// Imported by the service worker, popup and options page. DOM-free.
import { PROVIDER_IDS, getProvider, isLoopbackHost } from "./tts-providers.js";
import { BUILTIN_DEVICE_PREFS } from "./kokoro-builtin-device.js";
import { isBuiltinDevicePref } from "./builtin-consent.js";

export const CODE_BLOCKS = Object.freeze({
  ANNOUNCE: "announce", // "Python code block, 12 lines." — default; keeps place without reading syntax
  SKIP: "skip", // omit code blocks entirely
  VERBATIM: "verbatim", // read the code as text (legacy behaviour)
});

// Connection settings are stored per provider so switching back and forth loses nothing.
// OpenVox keeps the original flat keys (base/model/language/voice) for backwards compatibility
// with settings saved before providers existed; Kokoro Web uses a `kokoro` prefix, the built-in
// voice `builtin`. New installs default to the built-in provider (zero setup). Earlier installs
// that never stored a `provider` key are pinned to OpenVox by the service worker's onInstalled
// handler, so an existing OpenVox user is never switched to a 326 MB download.
const BUILTIN_DEFAULTS = getProvider(PROVIDER_IDS.BUILTIN);
const OPENVOX_DEFAULTS = getProvider(PROVIDER_IDS.OPENVOX);
const KOKORO_DEFAULTS = getProvider(PROVIDER_IDS.KOKORO_WEB);

export const DEFAULTS = Object.freeze({
  provider: PROVIDER_IDS.BUILTIN,
  base: OPENVOX_DEFAULTS.defaultBase,
  model: OPENVOX_DEFAULTS.defaults.model,
  language: OPENVOX_DEFAULTS.defaults.language,
  voice: OPENVOX_DEFAULTS.defaults.voice,
  kokoroBase: KOKORO_DEFAULTS.defaultBase,
  kokoroModel: KOKORO_DEFAULTS.defaults.model,
  kokoroLanguage: KOKORO_DEFAULTS.defaults.language,
  kokoroVoice: KOKORO_DEFAULTS.defaults.voice,
  builtinBase: "",
  builtinModel: BUILTIN_DEFAULTS.defaults.model,
  builtinLanguage: BUILTIN_DEFAULTS.defaults.language,
  builtinVoice: BUILTIN_DEFAULTS.defaults.voice,
  speed: 1.0,
  codeBlocks: CODE_BLOCKS.ANNOUNCE,
  highlightEnabled: true,
  highlightColor: "#ffd60a",
  highlightOpacity: 0.55,
  autoScroll: true,
  chunkTargetChars: 180,
  chunkMaxChars: 260,
});

// Secrets live in storage.local only — never synced to the browser account. So do per-machine
// facts: which device runs the built-in model (a laptop's GPU says nothing about a desktop's),
// and whether the user agreed to that machine's one-time model download.
export const LOCAL_DEFAULTS = Object.freeze({
  kokoroApiKey: "",
  builtinConsent: false, // first-run download consent; see lib/builtin-consent.js
  builtinDevice: BUILTIN_DEVICE_PREFS.AUTO, // auto | webgpu | wasm — see lib/kokoro-builtin-device.js
});

/** Speed presets shown in the popup and options page (value → label). */
export const SPEED_PRESETS = Object.freeze([
  [0.75, "0.75×"],
  [0.9, "0.9×"],
  [1.0, "1×"],
  [1.1, "1.1×"],
  [1.25, "1.25×"],
  [1.5, "1.5×"],
  [1.75, "1.75×"],
  [2.0, "2×"],
]);

/** Storage key names for a provider's connection fields. */
export function connectionKeys(providerId) {
  if (providerId === PROVIDER_IDS.KOKORO_WEB) {
    return { base: "kokoroBase", model: "kokoroModel", language: "kokoroLanguage", voice: "kokoroVoice" };
  }
  if (providerId === PROVIDER_IDS.BUILTIN) {
    return { base: "builtinBase", model: "builtinModel", language: "builtinLanguage", voice: "builtinVoice" };
  }
  return { base: "base", model: "model", language: "language", voice: "voice" };
}

/**
 * Re-run the provider's URL validator on a stored base. Storage is only validated on save by
 * the options page, so a hand-edited or corrupted value (javascript:, ftp:, garbage) must not
 * reach fetch(); it falls back to the provider default instead of throwing on every read.
 */
function safeBase(provider, raw) {
  try {
    return provider.normalizeBase(raw);
  } catch {
    return provider.defaultBase;
  }
}

/**
 * Resolve the active provider's connection from flat sync settings + storage.local settings
 * (secrets and the per-machine built-in device). Pure: safe to unit-test without chrome.*.
 * @returns {{ id: string, base: string, model: string, language: string, voice: string, apiKey: string, device?: string }}
 */
export function resolveConnection(settings, local = {}) {
  const provider = getProvider(settings?.provider);
  const keys = connectionKeys(provider.id);
  const pick = (key, fallback) => {
    const v = settings?.[key];
    return typeof v === "string" && v.trim() ? v : fallback;
  };
  const conn = {
    id: provider.id,
    base: safeBase(provider, pick(keys.base, provider.defaultBase)),
    model: pick(keys.model, provider.defaults.model),
    language: pick(keys.language, provider.defaults.language),
    voice: pick(keys.voice, provider.defaults.voice),
    apiKey: provider.needsApiKey && typeof local?.kokoroApiKey === "string" ? local.kokoroApiKey : "", // pragma: allowlist secret
  };
  if (provider.id === PROVIDER_IDS.BUILTIN) {
    // Local first. The synced key is only a fallback for a profile the service worker's
    // onInstalled migration has not reached yet; an invalid value never reaches the loader.
    const device = [local?.builtinDevice, settings?.builtinDevice].find(isBuiltinDevicePref);
    conn.device = device || LOCAL_DEFAULTS.builtinDevice;
  }
  return conn;
}

/**
 * Upgrade step for the device pref moving from storage.sync to storage.local. Returns the value
 * to write to local, or null when there is nothing to copy (local already chose, or the synced
 * value is missing/invalid). The caller removes the sync key either way.
 */
export function migrateBuiltinDevice(syncValue, localValue) {
  if (localValue !== undefined) return null;
  return isBuiltinDevicePref(syncValue) ? syncValue : null;
}

/**
 * Provider-neutral warning for a connection that would send its API key in clear text across
 * the network (plain http: to anything but loopback). Returns "" when there is nothing to say,
 * including for an unparsable base (the URL validator reports that, not this).
 */
export function connectionWarning(conn) {
  const key = typeof conn?.apiKey === "string" ? conn.apiKey.trim() : ""; // pragma: allowlist secret
  if (!key || typeof conn.base !== "string") return "";
  let url;
  try {
    url = new URL(conn.base);
  } catch {
    return "";
  }
  if (url.protocol !== "http:" || isLoopbackHost(url.hostname)) return "";
  return `The API key will be sent unencrypted over http:// to ${url.hostname}. Use https:// for a server on another machine.`;
}

export async function getSettings() {
  const stored = await chrome.storage.sync.get(DEFAULTS);
  return { ...DEFAULTS, ...stored };
}

export async function getLocalSecrets() {
  const stored = await chrome.storage.local.get(LOCAL_DEFAULTS);
  return { ...LOCAL_DEFAULTS, ...stored };
}

/** storage.local settings (secrets, built-in consent and device). Same read as getLocalSecrets. */
export const getLocalSettings = getLocalSecrets;

/** Store which device runs the built-in model on this machine (storage.local, never synced). */
export async function setBuiltinDevice(device) {
  if (!isBuiltinDevicePref(device)) return;
  await chrome.storage.local.set({ builtinDevice: device });
}

/** Store the one-time download consent together with the device it was given for. */
export async function grantBuiltinConsent(device) {
  const builtinDevice = isBuiltinDevicePref(device) ? device : LOCAL_DEFAULTS.builtinDevice;
  await chrome.storage.local.set({ builtinConsent: true, builtinDevice });
}

/** Settings plus the resolved `connection` for the active provider — what a session needs. */
export async function getSessionOptions() {
  const [settings, local] = await Promise.all([getSettings(), getLocalSecrets()]);
  return { ...settings, connection: resolveConnection(settings, local) };
}
