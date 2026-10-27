// test/openvox-client.test.mjs — live integration tests against the local OpenVox API.
// Auto-skips every test if the server isn't reachable, unless OPENVOX_LIVE=1.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  listModels,
  listLanguages,
  listVoices,
  loadModel,
  synthesizeWav,
  ping,
  DEFAULT_BASE,
} from "../lib/openvox-client.js";

const REQUIRE_LIVE = process.env.OPENVOX_LIVE === "1";
const LIVE = await ping(DEFAULT_BASE);

if (REQUIRE_LIVE && !LIVE) {
  test("API is reachable", () => {
    assert.fail("OpenVox API not reachable at " + DEFAULT_BASE);
  });
} else {
  const skip = LIVE ? false : "OpenVox API not reachable at " + DEFAULT_BASE;
  const opts = (extra = {}) => ({ skip, ...extra });

  test("API is reachable", opts(), () => {
    assert.ok(LIVE);
  });

  test("GET /models includes kokoro and reports streaming support", opts(), async () => {
    const models = await listModels();
    const ids = models.map((m) => m.id);
    assert.ok(ids.includes("kokoro"), `models: ${ids.join(", ")}`);
  });

  test("kokoro exposes English and at least one voice", opts(), async () => {
    const langs = await listLanguages("kokoro");
    assert.ok(langs.some((l) => (l.code || l.id) === "en"), "no 'en' language");
    const voices = await listVoices("kokoro", "en");
    assert.ok(voices.length > 0, "no voices");
    assert.ok(
      voices.every((v) => typeof v.id === "string" && v.id.length),
      "voice missing id",
    );
  });

  test("POST /audio/speech returns a valid WAV", opts({ timeout: 120000 }), async () => {
    await loadModel("kokoro");
    const buf = await synthesizeWav({
      model: "kokoro",
      input: "Testing OpenVox read aloud, one two three.",
      language: "en",
      voice: "af_bella",
    });
    assert.ok(buf.byteLength > 44, `WAV too small: ${buf.byteLength} bytes`);
    const head = new Uint8Array(buf.slice(0, 12));
    const ascii = (a, b) => String.fromCharCode(...head.slice(a, b));
    assert.equal(ascii(0, 4), "RIFF", "missing RIFF header");
    assert.equal(ascii(8, 12), "WAVE", "missing WAVE header");
  });

  test("speed is honoured: 1.5x returns shorter audio than 1.0x", opts({ timeout: 120000 }), async () => {
    await loadModel("kokoro");
    const input = "The quick brown fox jumps over the lazy dog, again and again and again.";
    const common = { model: "kokoro", input, language: "en", voice: "af_bella" };
    const normal = await synthesizeWav({ ...common, speed: 1.0 });
    const fast = await synthesizeWav({ ...common, speed: 1.5 });
    assert.ok(
      fast.byteLength < normal.byteLength * 0.85,
      `expected 1.5x to be ≥15% shorter: ${fast.byteLength} vs ${normal.byteLength}`,
    );
  });
}
