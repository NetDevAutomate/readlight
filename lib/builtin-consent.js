// lib/builtin-consent.js — first-run download consent for the built-in voice. Pure, DOM-free.
// The built-in voice is the default for new installs, and its first use fetches a 92–326 MB model
// from huggingface.co. The user must see how big it is and where it comes from, and agree once
// per machine, before the service worker lets that download start.
import { BUILTIN_DEVICE_PREFS, chooseBuiltinDevice, formatBytes } from "./kokoro-builtin-device.js";
import { PROVIDER_IDS } from "./tts-providers.js";

// Re-exported so the popup/options need one import for the consent copy and its size label.
export { formatBytes };

/** STATE value the service worker sends the popup instead of starting a gated session. */
export const CONSENT_STATE = "needs-consent";

/** What GRANT_BUILTIN_CONSENT should start once consent is stored (the click that was gated). */
export const CONSENT_PENDING = Object.freeze({
  READ: "read", // popup "Read page" / keyboard toggle
  SELECTION: "selection", // popup "Read selection" (re-running "read" would read the whole page)
  PICK: "pick", // popup "Read a region…"
  PREVIEW: "preview", // options page voice preview
});

const DEVICE_PREF_VALUES = new Set(Object.values(BUILTIN_DEVICE_PREFS));

/** True for exactly the stored device preferences the model loader understands. */
export function isBuiltinDevicePref(v) {
  return typeof v === "string" && DEVICE_PREF_VALUES.has(v);
}

/**
 * Must this connection wait for consent? Only the built-in provider downloads anything, and only
 * a literal `true` counts as consent so a corrupted stored value still shows the disclosure.
 * @param {{ id?: string } | null} conn resolved connection
 * @param {{ builtinConsent?: unknown }} [local] storage.local settings
 */
export function needsBuiltinConsent(conn, local = {}) {
  return conn?.id === PROVIDER_IDS.BUILTIN && local?.builtinConsent !== true;
}

/**
 * Copy for the consent panel. The size is the one chooseBuiltinDevice would actually download for
 * this preference on this machine, so "auto" on a GPU-less machine says 92 MB, not 326 MB.
 * @param {string} [devicePref] one of BUILTIN_DEVICE_PREFS (anything else behaves as auto)
 * @param {{ hasAdapter?: boolean, isFallbackAdapter?: boolean, crossOriginIsolated?: boolean, hardwareConcurrency?: number }} [env]
 * @returns {{ device: "webgpu"|"wasm", label: string, sizeLabel: string, body: string }}
 */
export function consentCopy(devicePref, env = {}) {
  const pref = isBuiltinDevicePref(devicePref) ? devicePref : BUILTIN_DEVICE_PREFS.AUTO;
  const decision = chooseBuiltinDevice(
    {
      hasAdapter: env?.hasAdapter === true,
      isFallbackAdapter: env?.isFallbackAdapter === true,
      crossOriginIsolated: env?.crossOriginIsolated === true,
      hardwareConcurrency: env?.hardwareConcurrency,
    },
    pref,
  );
  const sizeLabel = formatBytes(decision.downloadBytes);
  return {
    device: decision.device,
    label: decision.label,
    sizeLabel,
    body:
      `The built-in voice downloads its model once from huggingface.co (about ${sizeLabel}) and keeps it in this browser's cache. ` +
      "No page text is sent anywhere. Hugging Face sees only the download request.",
  };
}
