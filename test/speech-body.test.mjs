// test/speech-body.test.mjs — offline tests for the /audio/speech request body.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildSpeechBody,
  clampSpeed,
  synthesizeWav,
  OpenVoxError,
  MAX_AUDIO_BYTES,
  SPEED_MIN,
  SPEED_MAX,
} from "../lib/openvox-client.js";

const base = { model: "kokoro", input: "Hello.", language: "en", voice: "af_bella" };

test("buildSpeechBody includes speed when it is a finite number", () => {
  const body = buildSpeechBody({ ...base, speed: 1.5 });
  assert.equal(body.speed, 1.5);
  assert.equal(body.response_format, "wav");
  assert.equal(body.model, "kokoro");
});

test("buildSpeechBody omits speed when undefined or not a number", () => {
  assert.equal("speed" in buildSpeechBody(base), false);
  assert.equal("speed" in buildSpeechBody({ ...base, speed: "fast" }), false);
  assert.equal("speed" in buildSpeechBody({ ...base, speed: NaN }), false);
});

test("buildSpeechBody clamps speed into the supported range", () => {
  assert.equal(buildSpeechBody({ ...base, speed: 0.1 }).speed, SPEED_MIN);
  assert.equal(buildSpeechBody({ ...base, speed: 9 }).speed, SPEED_MAX);
});

test("clampSpeed falls back to 1 for garbage and clamps extremes", () => {
  assert.equal(clampSpeed(undefined), 1);
  assert.equal(clampSpeed("x"), 1);
  assert.equal(clampSpeed(0), SPEED_MIN);
  assert.equal(clampSpeed(100), SPEED_MAX);
  assert.equal(clampSpeed(1.25), 1.25);
});

// ---- synthesizeWav caps server-supplied data (fetch stubbed, restored after each test) ----
const ascii = (s) => [...s].map((c) => c.charCodeAt(0));
const RIFF_WAV = () => new Uint8Array(ascii("RIFF").concat([0, 0, 0, 0], ascii("WAVEfmt ")));
async function withFetch(fake, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = fake;
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}
const synth = () => synthesizeWav({ ...base, base: "http://127.0.0.1:1/v1", retries: 0 });

test("MAX_AUDIO_BYTES is 16 MiB", () => {
  assert.equal(MAX_AUDIO_BYTES, 16 * 1024 * 1024);
});

test("synthesizeWav returns a RIFF/WAVE body unchanged", async () => {
  const buf = await withFetch(async () => new Response(RIFF_WAV(), { status: 200 }), synth);
  assert.deepEqual(new Uint8Array(buf), RIFF_WAV());
});

test("synthesizeWav rejects a 200 body that is not a WAV", async () => {
  for (const body of ['{"ok":true}', new Uint8Array(ascii("RIFF....AVIX")), ""]) {
    await withFetch(
      async () => new Response(body, { status: 200 }),
      () => assert.rejects(synth(), (err) => err instanceof OpenVoxError && /did not return a WAV/.test(err.message)),
    );
  }
});

test("synthesizeWav caps error detail at 300 chars", async () => {
  await withFetch(
    async () => new Response("e".repeat(100000), { status: 500 }),
    () =>
      assert.rejects(synth(), (err) => {
        assert.ok(err instanceof OpenVoxError);
        assert.equal(err.status, 500);
        assert.ok(err.message.length < 400, `message length ${err.message.length}`);
        return true;
      }),
  );
});

test("synthesizeWav refuses audio over 16 MiB (by Content-Length, then by size read)", async () => {
  let readCalled = false;
  const declared = {
    ok: true,
    status: 200,
    headers: new Headers({ "content-length": String(MAX_AUDIO_BYTES + 1) }),
    arrayBuffer: async () => {
      readCalled = true;
      return new ArrayBuffer(0);
    },
  };
  await withFetch(async () => declared, () => assert.rejects(synth(), (err) => err instanceof OpenVoxError && /too large/.test(err.message)));
  assert.equal(readCalled, false, "an over-declared body must not be read");
  const big = new Uint8Array(MAX_AUDIO_BYTES + 1);
  big.set(RIFF_WAV());
  await withFetch(
    async () => new Response(big, { status: 200 }),
    () => assert.rejects(synth(), (err) => err instanceof OpenVoxError && /too large/.test(err.message)),
  );
});
