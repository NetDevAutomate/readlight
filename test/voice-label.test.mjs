// test/voice-label.test.mjs — voice picker labels: region + gender + descriptive tags, every provider.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { regionFromLanguage, descriptiveTags, voiceLabel } from "../lib/voice-label.js";
import { normalizeVoices } from "../lib/kokoro-client.js";
import { PROVIDER_IDS, getProvider, openvoxVoiceRecord } from "../lib/tts-providers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (f) => JSON.parse(readFileSync(path.join(here, "fixtures/kokoro", f), "utf8"));

test("regionFromLanguage handles codes, 'X English' and 'English (XX)' forms", () => {
  assert.equal(regionFromLanguage("en-us"), "US");
  assert.equal(regionFromLanguage("en-GB"), "British");
  assert.equal(regionFromLanguage("US English"), "US");
  assert.equal(regionFromLanguage("British English"), "British");
  assert.equal(regionFromLanguage("American English"), "US");
  assert.equal(regionFromLanguage("English (US)"), "US");
  assert.equal(regionFromLanguage("English (GB)"), "British");
  assert.equal(regionFromLanguage("Japanese"), "");
  assert.equal(regionFromLanguage(""), "");
  assert.equal(regionFromLanguage(undefined), "");
});

test("descriptiveTags drops region words so the region is shown once, from the language", () => {
  assert.deepEqual(descriptiveTags(["American", "Middle aged", "Story Teller"]), ["Middle aged", "Story Teller"]);
  assert.deepEqual(descriptiveTags(["British"]), []);
  assert.deepEqual(descriptiveTags(undefined), []);
});

test("voiceLabel formats name — region, gender · tags, omitting empty parts", () => {
  assert.equal(
    voiceLabel({ name: "Alice", gender: "Female", region: "British", tags: ["American", "Middle aged", "Professional"] }),
    "Alice — British, Female · Middle aged, Professional",
  );
  assert.equal(voiceLabel({ name: "Heart", gender: "Female", region: "US" }), "Heart — US, Female");
  assert.equal(voiceLabel({ name: "Puck", region: "" }), "Puck");
  assert.equal(voiceLabel({ id: "x_y" }), "x_y");
});

test("OpenVox voice record: region from `language` (not tags), tags kept", () => {
  // Real OpenVox payload for bf_alice: language says British, tags say American. Language wins.
  const raw = {
    gender: "Female", language: "British English", id: "bf_alice", name: "Alice",
    tags: ["American", "Middle aged", "Professional"], has_preview: true,
  };
  const v = openvoxVoiceRecord(raw);
  assert.equal(v.region, "British");
  assert.deepEqual(v.tags, ["American", "Middle aged", "Professional"]);
  assert.equal(voiceLabel(v), "Alice — British, Female · Middle aged, Professional");
});

test("Kokoro Web voices carry a region derived from lang.id", () => {
  const voices = normalizeVoices(fixture("voices.json"));
  const bella = voices.find((v) => v.id === "af_bella");
  assert.equal(bella.region, "US");
  const george = voices.find((v) => v.id === "bm_george");
  assert.equal(george?.region, "British");
});

test("built-in voices carry a region", async () => {
  const voices = await getProvider(PROVIDER_IDS.BUILTIN).listVoices({});
  assert.equal(voices.find((v) => v.id === "bm_george").region, "British");
  assert.equal(voices.find((v) => v.id === "af_heart").region, "US");
  assert.equal(voiceLabel(voices.find((v) => v.id === "bm_george")), "George — British, Male");
});
