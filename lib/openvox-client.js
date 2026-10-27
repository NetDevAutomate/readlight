// lib/openvox-client.js
// Pure HTTP client for the local OpenVox API (https://openvoxai.com/support → Local API).
// No DOM dependencies: runs in the offscreen document (browser) AND under Node 18+ (tests).
//
// API surface used:
//   GET  /models
//   GET  /models/{model}/languages
//   GET  /models/{model}/voices?language={code}
//   POST /models/{model}/load
//   POST /audio/speech   { model, input, language, voice, speed?, response_format: "wav" } -> WAV bytes
//
// Hard rule (server-side): only ONE generation/preload job runs at a time; concurrent
// requests get HTTP 429. Callers MUST serialize load/synthesize through a single mutex
// (see offscreen.js). The bounded 429 backoff here is a secondary safety net only.

import { TtsError } from "./tts-error.js";

export const DEFAULT_BASE = "http://127.0.0.1:8005/v1";

// Speech-rate bounds. OpenVox accepts `speed` on /audio/speech (verified live: 1.5 returns
// a shorter WAV than 1.0). Kept to a range that stays intelligible for study use.
export const SPEED_MIN = 0.5;
export const SPEED_MAX = 2.5;

/** Coerce any user/storage value into a usable speed multiplier (1 = normal). */
export function clampSpeed(value) {
  const n = typeof value === "string" ? parseFloat(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n)) return 1;
  return Math.min(SPEED_MAX, Math.max(SPEED_MIN, n));
}

/** Build the JSON body for POST /audio/speech. `speed` is omitted unless it is a finite number. */
export function buildSpeechBody({ model, input, language, voice, speed }) {
  const body = { model, input, language, voice, response_format: "wav" };
  if (typeof speed === "number" && Number.isFinite(speed)) body.speed = clampSpeed(speed);
  return body;
}

export class OpenVoxError extends TtsError {
  constructor(message, opts) {
    super(message, opts);
    this.name = "OpenVoxError";
  }
}

// Ceilings on server-supplied data. The server is user-configured and may be on another
// machine, so a misbehaving or hostile one must not be able to flood the offscreen
// document's memory or push an unbounded string into the UI via an error message.
export const MAX_DETAIL_CHARS = 300;
export const MAX_AUDIO_BYTES = 16 * 1024 * 1024; // a 260-char chunk at 24 kHz mono is ~1 MB

/** Truncate server-supplied error text before it enters an error message. */
export function capDetail(text) {
  const s = typeof text === "string" ? text : "";
  return s.length > MAX_DETAIL_CHARS ? s.slice(0, MAX_DETAIL_CHARS) : s;
}

/**
 * Read a successful speech response as a WAV, enforcing MAX_AUDIO_BYTES and the RIFF/WAVE
 * magic. Shared by both HTTP clients; `ErrorClass` keeps each client's own error type.
 * A declared Content-Length over the cap is refused before the body is read; without one the
 * size is checked after the read (fetch exposes no cheap streaming cap here).
 */
export async function readWavResponse(res, label, ErrorClass = TtsError) {
  const declared = Number(res.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > MAX_AUDIO_BYTES) {
    throw new ErrorClass(`${label} audio too large (${declared} bytes)`, { status: res.status });
  }
  const buf = await res.arrayBuffer();
  if (buf.byteLength > MAX_AUDIO_BYTES) {
    throw new ErrorClass(`${label} audio too large (${buf.byteLength} bytes)`, { status: res.status });
  }
  const b = new Uint8Array(buf, 0, Math.min(12, buf.byteLength));
  const tag = (from, to) => String.fromCharCode(...b.slice(from, to));
  if (b.length < 12 || tag(0, 4) !== "RIFF" || tag(8, 12) !== "WAVE") {
    throw new ErrorClass(`${label} did not return a WAV`, { status: res.status });
  }
  return buf;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function httpRequest(base, path, { method = "GET", body, signal, accept } = {}) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (accept) headers["Accept"] = accept;
  let res;
  try {
    res = await fetch(`${base}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal,
    });
  } catch (err) {
    // Network-level failure (server down, connection refused, aborted).
    if (err && err.name === "AbortError") throw err;
    throw new OpenVoxError(`network error calling ${path}: ${err.message}`, {
      cause: err,
    });
  }
  return res;
}

// `{ data: [...] }` envelope; a JSON `null` (or any non-object) body must not throw a TypeError
// here. Element typing is the provider layer's job (lib/tts-providers.js).
const dataOf = (json) => (json && typeof json === "object" ? json.data ?? [] : []);

export async function listModels(base = DEFAULT_BASE, { signal } = {}) {
  const res = await httpRequest(base, "/models", { signal });
  if (!res.ok) throw new OpenVoxError(`GET /models failed: ${res.status}`, { status: res.status });
  return dataOf(await res.json());
}

export async function listLanguages(model, base = DEFAULT_BASE, { signal } = {}) {
  const res = await httpRequest(base, `/models/${encodeURIComponent(model)}/languages`, { signal });
  if (!res.ok) throw new OpenVoxError(`GET languages failed: ${res.status}`, { status: res.status });
  return dataOf(await res.json());
}

export async function listVoices(model, language, base = DEFAULT_BASE, { signal } = {}) {
  const q = language ? `?language=${encodeURIComponent(language)}` : "";
  const res = await httpRequest(base, `/models/${encodeURIComponent(model)}/voices${q}`, { signal });
  if (!res.ok) throw new OpenVoxError(`GET voices failed: ${res.status}`, { status: res.status });
  return dataOf(await res.json());
}

/** Warm/load a model. Idempotent-ish; safe to call once per session. */
export async function loadModel(model, base = DEFAULT_BASE, { signal, retries = 4 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await httpRequest(base, `/models/${encodeURIComponent(model)}/load`, {
      method: "POST",
      body: {},
      signal,
    });
    if (res.ok) return true;
    if (res.status === 429 && attempt < retries) {
      await sleep(400 * 2 ** attempt);
      continue;
    }
    throw new OpenVoxError(`POST /models/${model}/load failed: ${res.status}`, {
      status: res.status,
    });
  }
}

/**
 * Synthesize one chunk of text to a complete WAV.
 * @returns {Promise<ArrayBuffer>} WAV bytes (decode with AudioContext.decodeAudioData in the browser).
 */
export async function synthesizeWav({
  model,
  input,
  language,
  voice,
  speed,
  base = DEFAULT_BASE,
  signal,
  retries = 4,
}) {
  if (!input || !input.trim()) throw new OpenVoxError("synthesizeWav: empty input");
  const body = buildSpeechBody({ model, input, language, voice, speed });
  for (let attempt = 0; ; attempt++) {
    const res = await httpRequest(base, "/audio/speech", {
      method: "POST",
      body,
      signal,
      accept: "audio/wav",
    });
    if (res.ok) return await readWavResponse(res, "OpenVox", OpenVoxError);
    if (res.status === 429 && attempt < retries) {
      await sleep(400 * 2 ** attempt);
      continue;
    }
    const detail = capDetail(await res.text().catch(() => ""));
    throw new OpenVoxError(`POST /audio/speech failed: ${res.status} ${detail}`.trim(), {
      status: res.status,
    });
  }
}

/** Quick reachability probe used by the popup to show a friendly status. */
export async function ping(base = DEFAULT_BASE, { signal } = {}) {
  try {
    await listModels(base, { signal });
    return true;
  } catch {
    return false;
  }
}
