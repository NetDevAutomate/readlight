// lib/tts-providers.js — the one place that knows which TTS backends exist.
// offscreen.js, options.js and the service worker talk to a provider object only; nothing
// outside this file imports a concrete client. DOM-free.
//
// Provider interface (all async methods take a `conn` = { base, model, language, voice, apiKey }):
//   id, label, defaultBase, defaultPath, defaults: { model, language, voice }
//   hasBaseUrl            false for the built-in provider: no server, no URL, no host permission
//   needsApiKey           show an API-key field in options; key travels in-memory only
//   languageInRequest     whether `language` is sent on synth (OpenVox) or only filters voices (Kokoro)
//   voiceFormulaAllowed   free-text voice blends such as "af_bella*0.5+af_heart*0.5"
//   normalizeBase(raw)    -> canonical base URL (throws on a non-http(s) URL)
//   listModels(conn)      -> [{ id, label }]
//   listLanguages(conn)   -> [{ code, name }]
//   listVoices(conn)      -> [{ id, name, gender, region, tags }]  region: "US" | "British" | ""; tags: descriptive words
//   ensureReady(conn, { signal, onProgress })   warm the model / validate credentials; throws TtsError.
//                         Resolves to an optional { label } describing where synthesis runs.
//   synthesize({ conn, input, speed, signal }) -> { bytes: ArrayBuffer, mime: string }
//   ping(conn)            -> boolean

import * as openvox from "./openvox-client.js";
import * as kokoro from "./kokoro-client.js";
import * as builtin from "./kokoro-builtin-client.js";
import {
  KOKORO_BUILTIN_LANGUAGES,
  KOKORO_BUILTIN_DEFAULT_LANGUAGE,
  KOKORO_BUILTIN_DEFAULT_VOICE,
  listBuiltinVoices,
} from "./kokoro-voices.js";
import { regionFromLanguage } from "./voice-label.js";

export const PROVIDER_IDS = Object.freeze({ BUILTIN: "builtin", OPENVOX: "openvox", KOKORO_WEB: "kokoro-web" });

/**
 * OpenVox voice payload -> picker record, or null when the entry has no usable id. Region
 * comes from `language` ("British English"), never from `tags` (OpenVox's own data tags some
 * British voices "American"). Exported for tests.
 */
export function openvoxVoiceRecord(v) {
  if (!v || !isId(v.id)) return null;
  return {
    id: v.id,
    name: isId(v.name) ? v.name : v.id,
    gender: typeof v.gender === "string" ? v.gender : "",
    region: regionFromLanguage(typeof v.language === "string" ? v.language : ""),
    tags: Array.isArray(v.tags) ? v.tags.filter((t) => typeof t === "string") : [],
  };
}

// The OpenVox server is user-configured (possibly remote), so its list payloads are typed the
// same way Kokoro's are: non-arrays become [], id-less entries are dropped, and a list is
// capped so a runaway response cannot flood the options page's <select>s.
const MAX_LIST = 500;
const isId = (x) => typeof x === "string" && x.length > 0;

function cappedList(data, toRecord) {
  if (!Array.isArray(data)) return [];
  const out = [];
  for (const entry of data) {
    const rec = toRecord(entry);
    if (rec) out.push(rec);
    if (out.length >= MAX_LIST) break;
  }
  return out;
}

const openvoxModelRecord = (m) =>
  m && isId(m.id) ? { id: m.id, label: isId(m.display_name) ? m.display_name : m.id } : null;

function openvoxLanguageRecord(l) {
  if (!l) return null;
  const code = isId(l.code) ? l.code : isId(l.id) ? l.id : "";
  return code ? { code, name: isId(l.name) ? l.name : code } : null;
}

/** Canonicalise a user-entered base URL; an empty path becomes the provider's default path. */
export function normalizeBaseFor(raw, defaultBase, defaultPath) {
  const url = new URL((raw || defaultBase).trim());
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("API URL must start with http:// or https://");
  }
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/\/+$/, "") || defaultPath;
  return url.toString().replace(/\/$/, "");
}

/**
 * True for hosts that never leave the machine: 127.0.0.0/8, ::1 (URL.hostname keeps the
 * brackets, so both spellings are accepted) and `localhost`. Used to decide whether a
 * secret sent over plain http: is exposed to the network.
 */
export function isLoopbackHost(hostname) {
  if (typeof hostname !== "string") return false;
  const h = hostname.toLowerCase();
  if (h === "localhost" || h === "::1" || h === "[::1]") return true;
  const m = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  return !!m && m.slice(1).every((o) => Number(o) <= 255);
}

const BUILTIN = Object.freeze({
  id: PROVIDER_IDS.BUILTIN,
  label: "Built-in voice (runs in your browser)",
  defaultBase: "",
  defaultPath: "",
  defaults: Object.freeze({
    model: builtin.KOKORO_BUILTIN_MODEL_ID,
    language: KOKORO_BUILTIN_DEFAULT_LANGUAGE,
    voice: KOKORO_BUILTIN_DEFAULT_VOICE,
  }),
  hasBaseUrl: false,
  needsApiKey: false,
  languageInRequest: false,
  voiceFormulaAllowed: false,
  normalizeBase: () => "",
  async listModels() {
    return [{ id: builtin.KOKORO_BUILTIN_MODEL_ID, label: "Kokoro 82M (in-browser)" }];
  },
  async listLanguages() {
    return [...KOKORO_BUILTIN_LANGUAGES];
  },
  async listVoices(conn) {
    return listBuiltinVoices(conn?.language).map((v) => ({
      id: v.id,
      name: v.name,
      gender: v.gender,
      region: regionFromLanguage(v.language),
      tags: [],
    }));
  },
  // Downloads the weights on first use (326 MB GPU / 92 MB CPU, then cached) and loads the model.
  ensureReady: (conn, { signal, onProgress } = {}) =>
    builtin.ensureBuiltinLoaded({ devicePref: conn?.device, signal, onProgress }),
  async synthesize({ conn, input, speed, signal }) {
    const bytes = await builtin.synthesizeBuiltinWav({ input, voice: conn.voice, speed, signal });
    return { bytes, mime: "audio/wav" };
  },
  ping: async () => true,
});

const OPENVOX = Object.freeze({
  id: PROVIDER_IDS.OPENVOX,
  label: "OpenVox (local app)",
  defaultBase: openvox.DEFAULT_BASE,
  defaultPath: "/v1",
  defaults: Object.freeze({ model: "kokoro", language: "en", voice: "af_bella" }),
  hasBaseUrl: true,
  needsApiKey: false,
  languageInRequest: true,
  voiceFormulaAllowed: false,
  normalizeBase: (raw) => normalizeBaseFor(raw, openvox.DEFAULT_BASE, "/v1"),
  async listModels(conn) {
    return cappedList(await openvox.listModels(conn.base), openvoxModelRecord);
  },
  async listLanguages(conn) {
    return cappedList(await openvox.listLanguages(conn.model, conn.base), openvoxLanguageRecord);
  },
  async listVoices(conn) {
    return cappedList(await openvox.listVoices(conn.model, conn.language, conn.base), openvoxVoiceRecord);
  },
  ensureReady: (conn, { signal } = {}) => openvox.loadModel(conn.model, conn.base, { signal }),
  async synthesize({ conn, input, speed, signal }) {
    const bytes = await openvox.synthesizeWav({
      base: conn.base,
      model: conn.model,
      input,
      language: conn.language,
      voice: conn.voice,
      speed,
      signal,
    });
    return { bytes, mime: "audio/wav" };
  },
  ping: (conn) => openvox.ping(conn.base),
});

const KOKORO_WEB = Object.freeze({
  id: PROVIDER_IDS.KOKORO_WEB,
  label: "Kokoro Web (self-hosted)",
  defaultBase: kokoro.KOKORO_DEFAULT_BASE,
  defaultPath: "/api/v1",
  defaults: Object.freeze({
    model: kokoro.KOKORO_DEFAULT_MODEL,
    language: kokoro.KOKORO_DEFAULT_LANGUAGE,
    voice: kokoro.KOKORO_DEFAULT_VOICE,
  }),
  hasBaseUrl: true,
  needsApiKey: true,
  languageInRequest: false,
  voiceFormulaAllowed: true,
  normalizeBase: (raw) => normalizeBaseFor(raw, kokoro.KOKORO_DEFAULT_BASE, "/api/v1"),
  listModels: (conn) => kokoro.listModels(conn.base, { apiKey: conn.apiKey }),
  listLanguages: (conn) => kokoro.listLanguages(conn.base, { apiKey: conn.apiKey }),
  listVoices: (conn) => kokoro.listVoices(conn.base, { apiKey: conn.apiKey, language: conn.language }),
  // No load endpoint: a tiny warm-up synth downloads the model on first use and surfaces a bad
  // key / URL / voice before the real first sentence.
  async ensureReady(conn, { signal } = {}) {
    await kokoro.synthesizeKokoroWav({
      base: conn.base,
      apiKey: conn.apiKey,
      model: conn.model,
      voice: conn.voice,
      input: "Ready.",
      signal,
    });
    return true;
  },
  async synthesize({ conn, input, speed, signal }) {
    const bytes = await kokoro.synthesizeKokoroWav({
      base: conn.base,
      apiKey: conn.apiKey,
      model: conn.model,
      voice: conn.voice,
      input,
      speed,
      signal,
    });
    return { bytes, mime: "audio/wav" };
  },
  ping: (conn) => kokoro.ping(conn.base, { apiKey: conn.apiKey }),
});

const PROVIDERS = Object.freeze({
  [PROVIDER_IDS.BUILTIN]: BUILTIN,
  [PROVIDER_IDS.OPENVOX]: OPENVOX,
  [PROVIDER_IDS.KOKORO_WEB]: KOKORO_WEB,
});

export function listProviders() {
  return Object.values(PROVIDERS);
}

/** Unknown/garbage ids fall back to the built-in provider (needs no setup) so a corrupt setting never bricks the extension. */
export function getProvider(id) {
  return PROVIDERS[id] || BUILTIN;
}
