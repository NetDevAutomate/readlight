// test/tts-providers.test.mjs — provider registry + settings resolution (pure, no chrome.*).
import { test } from "node:test";
import assert from "node:assert/strict";
import { PROVIDER_IDS, getProvider, listProviders, normalizeBaseFor, isLoopbackHost, openvoxVoiceRecord } from "../lib/tts-providers.js";
import { DEFAULTS, resolveConnection, connectionKeys, connectionWarning } from "../lib/settings.js";

test("isLoopbackHost: 127.0.0.0/8, ::1 (bare or bracketed) and localhost only", () => {
  for (const h of ["127.0.0.1", "127.255.0.9", "::1", "[::1]", "localhost", "LOCALHOST"]) {
    assert.equal(isLoopbackHost(h), true, h);
  }
  for (const h of ["", "10.0.0.5", "128.0.0.1", "127.0.0.256", "127.0.0", "localhost.evil.com", "nas", "::2", undefined, 42]) {
    assert.equal(isLoopbackHost(h), false, String(h));
  }
});

test("connectionWarning: only a key sent over plain http to a non-loopback host warns", () => {
  assert.match(connectionWarning({ base: "http://nas:3000/api/v1", apiKey: "k3y" }), /http/i);
  assert.match(connectionWarning({ base: "http://10.0.0.5:3000/api/v1", apiKey: "k3y" }), /http/i);
  assert.equal(connectionWarning({ base: "https://nas:3000/api/v1", apiKey: "k3y" }), "");
  assert.equal(connectionWarning({ base: "http://127.0.0.1:3000/api/v1", apiKey: "k3y" }), "");
  assert.equal(connectionWarning({ base: "http://[::1]:3000/api/v1", apiKey: "k3y" }), "");
  assert.equal(connectionWarning({ base: "http://localhost:3000/api/v1", apiKey: "k3y" }), "");
  assert.equal(connectionWarning({ base: "http://nas:3000/api/v1", apiKey: "" }), "");
  assert.equal(connectionWarning({ base: "http://nas:3000/api/v1", apiKey: "   " }), "");
  assert.equal(connectionWarning({ base: "not a url", apiKey: "k3y" }), "");
  assert.equal(connectionWarning(undefined), "");
});

test("registry exposes openvox and kokoro-web with the common interface", () => {
  const ids = listProviders().map((p) => p.id);
  assert.deepEqual(ids.sort(), ["builtin", "kokoro-web", "openvox"]);
  for (const p of listProviders()) {
    for (const fn of ["normalizeBase", "listModels", "listLanguages", "listVoices", "ensureReady", "synthesize", "ping"]) {
      assert.equal(typeof p[fn], "function", `${p.id}.${fn}`);
    }
    assert.ok(p.defaults.model && p.defaults.voice);
    assert.equal(typeof p.hasBaseUrl, "boolean", `${p.id}.hasBaseUrl`);
    if (p.hasBaseUrl) assert.ok(p.defaultBase, `${p.id} needs a defaultBase`);
  }
});

test("getProvider falls back to the built-in provider for unknown ids", () => {
  assert.equal(getProvider("kokoro-web").id, "kokoro-web");
  assert.equal(getProvider("openvox").id, "openvox");
  assert.equal(getProvider("nonsense").id, "builtin");
  assert.equal(getProvider(undefined).id, "builtin");
});

test("normalizeBase: empty path takes the provider default path; trailing slash stripped", () => {
  const ov = getProvider(PROVIDER_IDS.OPENVOX);
  const kw = getProvider(PROVIDER_IDS.KOKORO_WEB);
  assert.equal(ov.normalizeBase("http://10.0.0.5:8005"), "http://10.0.0.5:8005/v1");
  assert.equal(ov.normalizeBase("http://10.0.0.5:8005/v1/"), "http://10.0.0.5:8005/v1");
  assert.equal(kw.normalizeBase("https://tts.example.com"), "https://tts.example.com/api/v1");
  assert.equal(kw.normalizeBase("https://tts.example.com/api/v1/?x=1#y"), "https://tts.example.com/api/v1");
  assert.equal(kw.normalizeBase(""), kw.defaultBase);
  assert.throws(() => normalizeBaseFor("ftp://x", "http://a/v1", "/v1"), /http:\/\/ or https:\/\//);
});

test("Kokoro provider does not send language on synth; OpenVox does", () => {
  assert.equal(getProvider(PROVIDER_IDS.KOKORO_WEB).languageInRequest, false);
  assert.equal(getProvider(PROVIDER_IDS.OPENVOX).languageInRequest, true);
});

test("resolveConnection: legacy flat 1.0.x settings resolve to OpenVox unchanged once provider is pinned", () => {
  // onInstalled(update) writes provider:"openvox" for upgrades that never stored a provider key,
  // so the flat keys a 1.0.x user saved still drive the OpenVox connection byte for byte.
  const legacy = { base: "http://127.0.0.1:8005/v1", model: "kokoro", language: "en", voice: "am_adam" };
  const c = resolveConnection({ ...DEFAULTS, provider: "openvox", ...legacy });
  assert.deepEqual(c, { id: "openvox", ...legacy, apiKey: "" });
});

test("resolveConnection: kokoro-web reads its own keys and the local secret", () => {
  const s = { ...DEFAULTS, provider: "kokoro-web", kokoroBase: "http://nas:3000/api/v1", kokoroVoice: "af_bella*0.5+af_heart*0.5" };
  const c = resolveConnection(s, { kokoroApiKey: "k3y" });
  assert.equal(c.id, "kokoro-web");
  assert.equal(c.base, "http://nas:3000/api/v1");
  assert.equal(c.model, "model_q8f16");
  assert.equal(c.language, "en-us");
  assert.equal(c.voice, "af_bella*0.5+af_heart*0.5");
  assert.equal(c.apiKey, "k3y");
});

test("resolveConnection: the api key never leaks into an OpenVox connection", () => {
  const c = resolveConnection({ ...DEFAULTS }, { kokoroApiKey: "k3y" });
  assert.equal(c.apiKey, "");
});

test("resolveConnection: blank strings fall back to provider defaults", () => {
  const c = resolveConnection({ ...DEFAULTS, provider: "kokoro-web", kokoroModel: "  ", kokoroVoice: "" });
  assert.equal(c.model, "model_q8f16");
  assert.equal(c.voice, "af_heart");
});

test("resolveConnection re-normalises a stored base and drops a non-http(s) one", () => {
  // Storage is writable by anything with extension-storage access, so the base is re-validated
  // on every read rather than trusted because options.js validated it once on save.
  for (const bad of ["javascript:alert(1)", "ftp://nas/v1", "not a url"]) {
    assert.equal(resolveConnection({ ...DEFAULTS, provider: "openvox", base: bad }).base, getProvider("openvox").defaultBase, bad);
    assert.equal(
      resolveConnection({ ...DEFAULTS, provider: "kokoro-web", kokoroBase: bad }).base,
      getProvider("kokoro-web").defaultBase,
      bad,
    );
  }
  assert.equal(resolveConnection({ ...DEFAULTS, provider: "openvox", base: "http://host/" }).base, "http://host/v1");
  assert.equal(resolveConnection({ ...DEFAULTS, provider: "kokoro-web", kokoroBase: "http://host/" }).base, "http://host/api/v1");
  assert.equal(resolveConnection({ ...DEFAULTS, provider: "builtin" }).base, "");
});

test("connectionKeys maps each provider to distinct storage keys", () => {
  const a = Object.values(connectionKeys("openvox"));
  const b = Object.values(connectionKeys("kokoro-web"));
  assert.equal(new Set([...a, ...b]).size, 8);
});

// ---- OpenVox normalisers type-check server payloads (fetch stubbed, restored after) ----
async function withJson(payload, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify(payload), { status: 200 });
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}
const ov = getProvider(PROVIDER_IDS.OPENVOX);
const ovConn = { base: "http://127.0.0.1:1/v1", model: "kokoro", language: "en" };

test("OpenVox lists tolerate a non-array `data` instead of throwing", async () => {
  for (const payload of [{ data: "nope" }, { data: { id: "x" } }, {}, null, [1, 2]]) {
    assert.deepEqual(await withJson(payload, () => ov.listModels(ovConn)), [], JSON.stringify(payload));
    assert.deepEqual(await withJson(payload, () => ov.listLanguages(ovConn)), [], JSON.stringify(payload));
    assert.deepEqual(await withJson(payload, () => ov.listVoices(ovConn)), [], JSON.stringify(payload));
  }
});

test("OpenVox lists drop entries without a non-empty string id", async () => {
  const data = [null, "af_x", { id: "" }, { id: 7 }, { name: "no id" }, { id: "kokoro", display_name: "Kokoro" }];
  assert.deepEqual(await withJson({ data }, () => ov.listModels(ovConn)), [{ id: "kokoro", label: "Kokoro" }]);
  const voices = await withJson({ data: [...data.slice(0, 5), { id: "af_bella", name: 5, gender: {}, tags: "x" }] }, () => ov.listVoices(ovConn));
  assert.deepEqual(voices, [{ id: "af_bella", name: "af_bella", gender: "", region: "", tags: [] }]);
  // Languages may be keyed by `code` or `id`; one of them must be a non-empty string.
  const langs = await withJson({ data: [{ code: "" }, { id: 3 }, { code: "en", name: "English" }, { id: "fr" }] }, () => ov.listLanguages(ovConn));
  assert.deepEqual(langs, [{ code: "en", name: "English" }, { code: "fr", name: "fr" }]);
});

test("OpenVox lists are capped at 500 entries", async () => {
  const data = Array.from({ length: 2000 }, (_, i) => ({ id: `v${i}`, code: `l${i}` }));
  assert.equal((await withJson({ data }, () => ov.listModels(ovConn))).length, 500);
  assert.equal((await withJson({ data }, () => ov.listLanguages(ovConn))).length, 500);
  assert.equal((await withJson({ data }, () => ov.listVoices(ovConn))).length, 500);
});

test("openvoxVoiceRecord returns null for an entry without a usable id", () => {
  assert.equal(openvoxVoiceRecord(null), null);
  assert.equal(openvoxVoiceRecord({ id: "" }), null);
  assert.equal(openvoxVoiceRecord({ id: 1 }), null);
});
