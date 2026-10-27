// lib/kokoro-client.js
// Pure HTTP client for a self-hosted Kokoro Web instance (https://github.com/eduardolat/kokoro-web).
// No DOM dependencies: runs in the offscreen document (browser) AND under Node 18+ (tests).
//
// API surface (from the live OpenAPI spec at <base>/openapi.json, kokoro-web latest, 2026-10-26):
//   GET  /audio/models   -> [{id, quantization, size}]
//   GET  /audio/langs    -> [{id, name}]
//   GET  /audio/voices   -> [{id, name, lang:{id,name}, gender, targetQuality, overallGrade}]
//   POST /audio/speech   { model, voice, input, response_format: "mp3"|"wav", speed: 0.25..5 } -> audio bytes
//                        400 -> {message}  (e.g. invalid voice formula)
//   Auth: `Authorization: Bearer <KW_SECRET_API_KEY>` when the server has a key configured; 401 otherwise.
//
// Notes vs OpenVox: there is no model-load endpoint (the server downloads the model on first
// use, which can take minutes), language is NOT a request field (voices are filtered by their
// lang.id client-side), and `voice` may be a blend formula such as "af_bella*0.5+af_heart*0.5".

import { TtsError } from "./tts-error.js";
import { clampSpeed, capDetail, readWavResponse } from "./openvox-client.js";
import { regionFromLanguage } from "./voice-label.js";

export const KOKORO_DEFAULT_BASE = "http://127.0.0.1:3000/api/v1";
export const KOKORO_DEFAULT_MODEL = "model_q8f16"; // smallest download; the README's own example
export const KOKORO_DEFAULT_LANGUAGE = "en-us";
export const KOKORO_DEFAULT_VOICE = "af_heart";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Bearer header when a key is configured; empty object otherwise (server may run keyless). */
export function authHeaders(apiKey) {
  const key = typeof apiKey === "string" ? apiKey.trim() : ""; // pragma: allowlist secret
  return key ? { Authorization: `Bearer ${key}` } : {};
}

/** Pull the human message out of a Kokoro error body; falls back to the raw text. Capped (see capDetail). */
export function errorMessageFrom(text) {
  if (!text) return "";
  try {
    const j = JSON.parse(text);
    if (j && typeof j.message === "string") return capDetail(j.message);
  } catch {
    /* not JSON */
  }
  return capDetail(text);
}

export function normalizeVoices(json, language) {
  if (!Array.isArray(json)) return [];
  const out = [];
  for (const v of json) {
    if (!v || typeof v.id !== "string") continue;
    const lang = v.lang && typeof v.lang.id === "string" ? v.lang.id : "";
    if (language && lang !== language) continue;
    out.push({
      id: v.id,
      name: typeof v.name === "string" ? v.name : v.id,
      gender: typeof v.gender === "string" ? v.gender : "",
      language: lang,
      region: regionFromLanguage(lang) || regionFromLanguage(v.lang?.name),
      tags: [],
      grade: typeof v.overallGrade === "string" ? v.overallGrade : "",
    });
  }
  return out;
}

export function normalizeModels(json) {
  if (!Array.isArray(json)) return [];
  return json
    .filter((m) => m && typeof m.id === "string")
    .map((m) => {
      const bits = [m.quantization, m.size].filter((x) => typeof x === "string" && x);
      return { id: m.id, label: bits.length ? `${m.id} — ${bits.join(", ")}` : m.id };
    });
}

export function normalizeLanguages(json) {
  if (!Array.isArray(json)) return [];
  return json
    .filter((l) => l && typeof l.id === "string")
    .map((l) => ({ code: l.id, name: typeof l.name === "string" ? l.name : l.id }));
}

/** JSON body for POST /audio/speech. Language is deliberately absent (not a Kokoro field). */
export function buildKokoroSpeechBody({ model, voice, input, speed }) {
  const body = { model, voice, input, response_format: "wav" };
  if (typeof speed === "number" && Number.isFinite(speed)) body.speed = clampSpeed(speed);
  return body;
}

/**
 * fetch() options for one Kokoro request. `redirect: "error"` because the bearer key rides on
 * every request: a server (or anything in front of it) answering 3xx must not be able to
 * bounce that header to another origin. Exported for tests.
 */
export function requestInit({ method = "GET", body, signal, accept, apiKey } = {}) {
  const headers = { ...authHeaders(apiKey) };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (accept) headers["Accept"] = accept;
  return {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal,
    redirect: "error",
  };
}

async function httpRequest(base, path, opts = {}) {
  try {
    return await fetch(`${base}${path}`, requestInit(opts));
  } catch (err) {
    if (err && err.name === "AbortError") throw err;
    throw new TtsError(`network error calling ${path}: ${err.message}`, { cause: err });
  }
}

async function getJson(base, path, opts) {
  const res = await httpRequest(base, path, opts);
  if (!res.ok) {
    const detail = errorMessageFrom(await res.text().catch(() => ""));
    throw new TtsError(`GET ${path} failed: ${res.status}${detail ? " " + detail : ""}`, { status: res.status });
  }
  return res.json();
}

export async function listModels(base = KOKORO_DEFAULT_BASE, opts = {}) {
  return normalizeModels(await getJson(base, "/audio/models", opts));
}

export async function listLanguages(base = KOKORO_DEFAULT_BASE, opts = {}) {
  return normalizeLanguages(await getJson(base, "/audio/langs", opts));
}

export async function listVoices(base = KOKORO_DEFAULT_BASE, { language, ...opts } = {}) {
  return normalizeVoices(await getJson(base, "/audio/voices", opts), language);
}

/**
 * Synthesize one chunk to a complete WAV.
 * @returns {Promise<ArrayBuffer>}
 */
export async function synthesizeKokoroWav({
  model = KOKORO_DEFAULT_MODEL,
  voice = KOKORO_DEFAULT_VOICE,
  input,
  speed,
  base = KOKORO_DEFAULT_BASE,
  apiKey,
  signal,
  retries = 3,
}) {
  if (!input || !input.trim()) throw new TtsError("synthesizeKokoroWav: empty input");
  const body = buildKokoroSpeechBody({ model, voice, input, speed });
  for (let attempt = 0; ; attempt++) {
    const res = await httpRequest(base, "/audio/speech", { method: "POST", body, signal, accept: "audio/wav", apiKey });
    if (res.ok) return await readWavResponse(res, "Kokoro Web", TtsError);
    // 429/503 = busy or still downloading the model on first use; back off briefly.
    if ((res.status === 429 || res.status === 503) && attempt < retries) {
      await sleep(500 * 2 ** attempt);
      continue;
    }
    const detail = errorMessageFrom(await res.text().catch(() => ""));
    if (res.status === 401) throw new TtsError("Kokoro Web rejected the API key (401).", { status: 401 });
    throw new TtsError(`Kokoro Web error ${res.status}${detail ? ": " + detail : ""}`, { status: res.status });
  }
}

/** Reachability probe. A 401 counts as reachable-but-unauthorised, so it returns false. */
export async function ping(base = KOKORO_DEFAULT_BASE, opts = {}) {
  try {
    await getJson(base, "/audio/langs", opts);
    return true;
  } catch {
    return false;
  }
}
