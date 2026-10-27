// test/kokoro-client.test.mjs — Kokoro Web client. The normaliser tests run against
// fixtures captured from a real kokoro-web container (test/fixtures/kokoro/*.json);
// the live tests auto-skip unless a Kokoro Web instance answers at KOKORO_BASE.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  KOKORO_DEFAULT_BASE,
  normalizeVoices,
  normalizeModels,
  normalizeLanguages,
  buildKokoroSpeechBody,
  authHeaders,
  errorMessageFrom,
  requestInit,
  listVoices,
  synthesizeKokoroWav,
  ping,
} from "../lib/kokoro-client.js";
import { TtsError } from "../lib/tts-error.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => JSON.parse(readFileSync(path.join(here, "fixtures/kokoro", name), "utf8"));

test("normalizeVoices keeps id/name/gender and flattens lang", () => {
  const voices = normalizeVoices(fixture("voices.json"));
  assert.equal(voices.length, 53);
  const bella = voices.find((v) => v.id === "af_bella");
  assert.deepEqual(bella, { id: "af_bella", name: "Bella", gender: "Female", language: "en-us", region: "US", tags: [], grade: "A-" });
});

test("normalizeVoices filters by language when asked", () => {
  const all = fixture("voices.json");
  const en = normalizeVoices(all, "en-us");
  assert.ok(en.length > 0 && en.length < 53);
  assert.ok(en.every((v) => v.language === "en-us"));
  assert.equal(normalizeVoices(all, "xx-nope").length, 0);
});

test("normalizeModels labels with quantization and size", () => {
  const models = normalizeModels(fixture("models.json"));
  assert.equal(models.length, 8);
  const q8 = models.find((m) => m.id === "model_q8f16");
  assert.equal(q8.label, "model_q8f16 — Mixed precision, 86 MB");
});

test("normalizeLanguages maps id/name to code/name", () => {
  const langs = normalizeLanguages(fixture("langs.json"));
  assert.equal(langs.length, 8);
  assert.deepEqual(langs[0], { code: "en-us", name: "English (US)" });
});

test("normalizers tolerate garbage without throwing", () => {
  assert.deepEqual(normalizeVoices(null), []);
  assert.deepEqual(normalizeVoices({ data: "nope" }), []);
  assert.deepEqual(normalizeModels(undefined), []);
  assert.deepEqual(normalizeLanguages(42), []);
});

test("buildKokoroSpeechBody: wav, speed clamped, no language key", () => {
  const body = buildKokoroSpeechBody({ model: "model_q8f16", voice: "af_heart", input: "Hi.", speed: 1.5 });
  assert.deepEqual(body, { model: "model_q8f16", voice: "af_heart", input: "Hi.", response_format: "wav", speed: 1.5 });
  assert.equal("language" in body, false);
  assert.equal(buildKokoroSpeechBody({ model: "m", voice: "v", input: "x" }).speed, undefined);
  assert.equal(buildKokoroSpeechBody({ model: "m", voice: "v", input: "x", speed: 99 }).speed, 2.5);
});

test("voice formulas (blends) pass through untouched", () => {
  const body = buildKokoroSpeechBody({ model: "m", voice: "af_bella*0.5+af_heart*0.5", input: "x" });
  assert.equal(body.voice, "af_bella*0.5+af_heart*0.5");
});

test("authHeaders adds a bearer token only when a key is present", () => {
  assert.deepEqual(authHeaders("abc"), { Authorization: "Bearer abc" });
  assert.deepEqual(authHeaders(""), {});
  assert.deepEqual(authHeaders(undefined), {});
  assert.deepEqual(authHeaders("  spaced  "), { Authorization: "Bearer spaced" });
});

test("requestInit refuses redirects so the bearer key never follows one", () => {
  const withKey = requestInit({ method: "POST", body: { a: 1 }, accept: "audio/wav", apiKey: "k3y" });
  assert.equal(withKey.redirect, "error");
  assert.equal(withKey.headers.Authorization, "Bearer k3y");
  assert.equal(withKey.headers["Content-Type"], "application/json");
  assert.equal(withKey.headers.Accept, "audio/wav");
  assert.equal(withKey.body, '{"a":1}');
  const keyless = requestInit({});
  assert.equal(keyless.redirect, "error");
  assert.equal(keyless.method, "GET");
  assert.equal("Authorization" in keyless.headers, false);
  assert.equal(keyless.body, undefined);
});

test("errorMessageFrom surfaces the server's validation message", () => {
  const msg = errorMessageFrom(JSON.stringify(fixture("error-400.json")));
  assert.match(msg, /^Validation error: Invalid voice formula/);
  assert.equal(errorMessageFrom("not json"), "not json");
  assert.equal(errorMessageFrom(""), "");
});

test("KOKORO_DEFAULT_BASE is the documented self-host path", () => {
  assert.equal(KOKORO_DEFAULT_BASE, "http://127.0.0.1:3000/api/v1");
});

// ---- offline: server-supplied data is capped (fetch stubbed, restored after each test) ----
const RIFF_WAV = () => new Uint8Array([..."RIFF"].map((c) => c.charCodeAt(0)).concat([0, 0, 0, 0], [..."WAVEfmt "].map((c) => c.charCodeAt(0))));
async function withFetch(fake, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = fake;
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}
const synth = () => synthesizeKokoroWav({ base: "http://127.0.0.1:1/api/v1", input: "Hi.", retries: 0 });

test("errorMessageFrom caps server detail at 300 chars", () => {
  assert.equal(errorMessageFrom("x".repeat(5000)).length, 300);
  assert.equal(errorMessageFrom(JSON.stringify({ message: "y".repeat(5000) })).length, 300);
});

test("a huge error body never reaches the TtsError message whole", async () => {
  await withFetch(
    async () => new Response("z".repeat(100000), { status: 500 }),
    () => assert.rejects(synth(), (err) => err instanceof TtsError && err.status === 500 && err.message.length < 400),
  );
  await withFetch(
    async () => new Response("z".repeat(100000), { status: 500 }),
    () => assert.rejects(listVoices("http://127.0.0.1:1/api/v1"), (err) => err instanceof TtsError && err.message.length < 400),
  );
});

test("synthesizeKokoroWav returns a RIFF/WAVE body", async () => {
  const buf = await withFetch(async () => new Response(RIFF_WAV(), { status: 200 }), synth);
  assert.equal(buf.byteLength, 16);
});

test("synthesizeKokoroWav rejects a body that is not a WAV", async () => {
  for (const body of ["<html>login</html>", new Uint8Array([..."RIFF"].map((c) => c.charCodeAt(0))), ""]) {
    await withFetch(
      async () => new Response(body, { status: 200 }),
      () => assert.rejects(synth(), (err) => err instanceof TtsError && /did not return a WAV/.test(err.message)),
    );
  }
});

test("synthesizeKokoroWav refuses audio over 16 MiB (by Content-Length, then by size read)", async () => {
  let readCalled = false;
  const declared = {
    ok: true,
    status: 200,
    headers: new Headers({ "content-length": String(16 * 1024 * 1024 + 1) }),
    arrayBuffer: async () => {
      readCalled = true;
      return new ArrayBuffer(0);
    },
  };
  await withFetch(async () => declared, () => assert.rejects(synth(), (err) => err instanceof TtsError && /too large/.test(err.message)));
  assert.equal(readCalled, false, "an over-declared body must not be read");
  const big = new Uint8Array(16 * 1024 * 1024 + 1);
  big.set(RIFF_WAV());
  await withFetch(
    async () => new Response(big, { status: 200 }),
    () => assert.rejects(synth(), (err) => err instanceof TtsError && /too large/.test(err.message)),
  );
});

// ---- live (auto-skip) -------------------------------------------------------
const BASE = process.env.KOKORO_BASE || KOKORO_DEFAULT_BASE;
const KEY = process.env.KOKORO_API_KEY || "";
const LIVE = await ping(BASE, { apiKey: KEY });
const skip = LIVE ? false : `Kokoro Web not reachable at ${BASE}`;

test("live: voices list includes af_heart", { skip }, async () => {
  const voices = await listVoices(BASE, { apiKey: KEY });
  assert.ok(voices.some((v) => v.id === "af_heart"));
});

test("live: speech returns WAV and honours speed", { skip, timeout: 300000 }, async () => {
  const common = { base: BASE, apiKey: KEY, model: "model_q8f16", voice: "af_bella", input: "The quick brown fox jumps over the lazy dog, again and again." };
  const normal = await synthesizeKokoroWav({ ...common, speed: 1.0 });
  const fast = await synthesizeKokoroWav({ ...common, speed: 1.5 });
  const head = (buf) => String.fromCharCode(...new Uint8Array(buf.slice(0, 4)));
  assert.equal(head(normal), "RIFF");
  assert.ok(fast.byteLength < normal.byteLength * 0.85, `${fast.byteLength} vs ${normal.byteLength}`);
});

test("live: a bad voice yields a TtsError carrying the server message", { skip, timeout: 60000 }, async () => {
  await assert.rejects(
    synthesizeKokoroWav({ base: BASE, apiKey: KEY, model: "model_q8f16", voice: "nope_voice", input: "x" }),
    (err) => err instanceof TtsError && err.status === 400 && /Invalid voice formula/.test(err.message),
  );
});
