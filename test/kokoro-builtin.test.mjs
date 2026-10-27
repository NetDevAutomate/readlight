// test/kokoro-builtin.test.mjs — built-in Kokoro provider: voice table, device decision, registry.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  KOKORO_BUILTIN_VOICES,
  KOKORO_BUILTIN_LANGUAGES,
  KOKORO_BUILTIN_DEFAULT_VOICE,
  listBuiltinVoices,
  isValidBuiltinVoice,
} from "../lib/kokoro-voices.js";
import {
  chooseBuiltinDevice,
  canReuseBuiltinLoad,
  BUILTIN_DEVICE_PREFS,
  MAX_WASM_THREADS,
  formatBytes,
  isModelFileUrl,
  shouldReleaseAfterPause,
  PAUSE_RELEASE_MS,
  makeLoadAbortingFetch,
  LoadWaiters,
} from "../lib/kokoro-builtin-device.js";
import { PROVIDER_IDS, getProvider, listProviders } from "../lib/tts-providers.js";
import { DEFAULTS, resolveConnection, connectionKeys } from "../lib/settings.js";

// ---- voices ------------------------------------------------------------------
test("voice table: 28 voices, ids match the a/b f/m prefix convention, default exists", () => {
  assert.equal(KOKORO_BUILTIN_VOICES.length, 28);
  for (const v of KOKORO_BUILTIN_VOICES) {
    assert.match(v.id, /^[ab][fm]_[a-z]+$/, v.id);
    assert.equal(v.language, v.id[0] === "a" ? "en-us" : "en-gb", v.id);
    assert.equal(v.gender, v.id[1] === "f" ? "Female" : "Male", v.id);
  }
  assert.ok(isValidBuiltinVoice(KOKORO_BUILTIN_DEFAULT_VOICE));
  assert.equal(new Set(KOKORO_BUILTIN_VOICES.map((v) => v.id)).size, 28, "duplicate voice id");
});

test("listBuiltinVoices filters by language and falls back to all for unknown codes", () => {
  assert.ok(listBuiltinVoices("en-gb").every((v) => v.language === "en-gb"));
  assert.equal(listBuiltinVoices("en-gb").length, 8);
  assert.equal(listBuiltinVoices("en-us").length, 20);
  assert.equal(listBuiltinVoices("xx").length, 28);
  assert.deepEqual(
    KOKORO_BUILTIN_LANGUAGES.map((l) => l.code),
    ["en-us", "en-gb"],
  );
});

test("isValidBuiltinVoice rejects formulas, unknown ids and non-strings", () => {
  assert.equal(isValidBuiltinVoice("af_bella*0.5+af_heart*0.5"), false);
  assert.equal(isValidBuiltinVoice("af_nobody"), false);
  assert.equal(isValidBuiltinVoice(""), false);
  assert.equal(isValidBuiltinVoice(undefined), false);
});

// ---- device decision ---------------------------------------------------------
const GPU_ENV = { hasAdapter: true, isFallbackAdapter: false, crossOriginIsolated: true, hardwareConcurrency: 16 };
const CPU_ENV = { hasAdapter: false, crossOriginIsolated: true, hardwareConcurrency: 16 };

test("auto picks WebGPU fp32 when a real adapter exists", () => {
  const d = chooseBuiltinDevice(GPU_ENV);
  assert.equal(d.device, "webgpu");
  assert.equal(d.dtype, "fp32"); // never fp16 (garbled) or q8 (CPU fallback) on WebGPU
  assert.match(d.label, /GPU/);
});

test("auto falls back to WASM q8 with min(8, cores) threads when isolated", () => {
  const d = chooseBuiltinDevice(CPU_ENV);
  assert.deepEqual([d.device, d.dtype, d.numThreads], ["wasm", "q8", MAX_WASM_THREADS]);
  assert.equal(chooseBuiltinDevice({ ...CPU_ENV, hardwareConcurrency: 4 }).numThreads, 4);
});

test("a fallback (software) adapter does not count as a GPU", () => {
  assert.equal(chooseBuiltinDevice({ ...GPU_ENV, isFallbackAdapter: true }).device, "wasm");
});

test("without crossOriginIsolated WASM is single-threaded and says so", () => {
  const d = chooseBuiltinDevice({ ...CPU_ENV, crossOriginIsolated: false });
  assert.equal(d.numThreads, 1);
  assert.match(d.label, /slow/);
});

test("explicit prefs: wasm forces CPU even with a GPU; webgpu without an adapter degrades to wasm", () => {
  assert.equal(chooseBuiltinDevice(GPU_ENV, BUILTIN_DEVICE_PREFS.WASM).device, "wasm");
  assert.equal(chooseBuiltinDevice(CPU_ENV, BUILTIN_DEVICE_PREFS.WEBGPU).device, "wasm");
  assert.equal(chooseBuiltinDevice(GPU_ENV, BUILTIN_DEVICE_PREFS.WEBGPU).device, "webgpu");
});

test("download sizes are disclosed per path", () => {
  assert.equal(formatBytes(chooseBuiltinDevice(GPU_ENV).downloadBytes), "326 MB");
  assert.equal(formatBytes(chooseBuiltinDevice(CPU_ENV).downloadBytes), "92 MB");
  assert.equal(formatBytes(0), "");
});

test("canReuseBuiltinLoad: auto reuses anything; a webgpu pref that fell back to wasm is not reloaded", () => {
  const gpu = { requestedPref: "auto", device: "webgpu" };
  const fellBack = { requestedPref: "webgpu", device: "wasm" };
  const forcedCpu = { requestedPref: "wasm", device: "wasm" };
  assert.equal(canReuseBuiltinLoad(forcedCpu, undefined), true);
  assert.equal(canReuseBuiltinLoad(forcedCpu, "auto"), true);
  assert.equal(canReuseBuiltinLoad(gpu, "webgpu"), true);
  assert.equal(canReuseBuiltinLoad(fellBack, "webgpu"), true, "same pref, same env: a reload chooses wasm again");
  assert.equal(canReuseBuiltinLoad({ requestedPref: "auto", device: "wasm" }, "webgpu"), true, "auto only picks wasm without a usable GPU");
  assert.equal(canReuseBuiltinLoad(forcedCpu, "webgpu"), false, "a forced-CPU load says nothing about the GPU");
  assert.equal(canReuseBuiltinLoad(gpu, "wasm"), false);
  assert.equal(canReuseBuiltinLoad(fellBack, "wasm"), true);
  // An in-flight load has no device yet: only the pref decides whether a caller may join it.
  assert.equal(canReuseBuiltinLoad({ requestedPref: "wasm" }, "webgpu"), false);
  assert.equal(canReuseBuiltinLoad({ requestedPref: "wasm" }, "wasm"), true);
});

// ---- load coordination helpers -----------------------------------------------
test("isModelFileUrl: Hugging Face hosts and subdomains over https only", () => {
  assert.equal(isModelFileUrl("https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/config.json"), true);
  assert.equal(isModelFileUrl("https://cdn-lfs.hf.co/repos/ab/cd/x"), true);
  assert.equal(isModelFileUrl(new URL("https://HuggingFace.co/x")), true);
  assert.equal(isModelFileUrl(new Request("https://hf.co/x")), true);
  assert.equal(isModelFileUrl("https://evilhuggingface.co/x"), false, "suffix without a dot is another domain");
  assert.equal(isModelFileUrl("https://huggingface.co.example.com/x"), false);
  assert.equal(isModelFileUrl("http://huggingface.co/x"), false);
  assert.equal(isModelFileUrl("http://127.0.0.1:8880/v1/audio/speech"), false);
  assert.equal(isModelFileUrl("chrome-extension://abc/vendor/ort/ort.wasm"), false);
  assert.equal(isModelFileUrl("not a url"), false);
});

test("shouldReleaseAfterPause: at or past the limit, default 15 minutes", () => {
  assert.equal(PAUSE_RELEASE_MS, 15 * 60 * 1000);
  assert.equal(shouldReleaseAfterPause(PAUSE_RELEASE_MS - 1), false);
  assert.equal(shouldReleaseAfterPause(PAUSE_RELEASE_MS), true);
  assert.equal(shouldReleaseAfterPause(10, 5), true);
  assert.equal(shouldReleaseAfterPause(NaN), false);
});

test("makeLoadAbortingFetch: model URLs carry the load signal; others pass through untouched", async () => {
  const seen = [];
  const base = async (input, init) => (seen.push({ input, init }), "ok");
  let active = null;
  const f = makeLoadAbortingFetch(base, () => active);
  await f("https://huggingface.co/a");
  assert.equal(seen.at(-1).init, undefined, "no active load: request untouched");
  const ctl = new AbortController();
  active = ctl.signal;
  await f("https://huggingface.co/a", { headers: { x: "1" } });
  assert.equal(seen.at(-1).init.signal, ctl.signal);
  assert.deepEqual(seen.at(-1).init.headers, { x: "1" });
  const other = { method: "POST" };
  await f("http://127.0.0.1:8880/v1/audio/speech", other);
  assert.equal(seen.at(-1).init, other, "non-model request is not touched during a load");
  const own = new AbortController();
  await f("https://hf.co/b", { signal: own.signal });
  const merged = seen.at(-1).init.signal;
  assert.equal(merged.aborted, false);
  own.abort();
  assert.equal(merged.aborted, true, "caller's own signal still aborts the request");
  const own2 = new AbortController();
  await f("https://hf.co/c", { signal: own2.signal });
  ctl.abort();
  assert.equal(seen.at(-1).init.signal.aborted, true, "the load signal aborts it too");
});

test("LoadWaiters: onEmpty fires once, when the last cancellable waiter aborts", () => {
  let fired = 0;
  const w = new LoadWaiters(() => fired++);
  const a = new AbortController();
  const b = new AbortController();
  w.add(a.signal);
  w.add(b.signal);
  assert.equal(w.size, 2);
  a.abort();
  assert.equal(fired, 0, "one waiter still wants the model");
  b.abort();
  assert.equal(fired, 1);
  assert.equal(w.size, 0);
});

test("LoadWaiters: a waiter without a signal pins the load; close() silences it", () => {
  let fired = 0;
  const w = new LoadWaiters(() => fired++);
  const a = new AbortController();
  w.add(a.signal);
  w.add(undefined);
  a.abort();
  assert.equal(fired, 0, "a non-cancellable waiter keeps the download going");
  const c = new LoadWaiters(() => fired++);
  const d = new AbortController();
  c.add(d.signal);
  c.close();
  d.abort();
  assert.equal(fired, 0, "a settled load is never aborted");
  c.add(new AbortController().signal);
  assert.equal(c.size, 0, "a closed set accepts no new waiters");
});

test("LoadWaiters: joining with an already-aborted signal adds nothing", () => {
  let fired = 0;
  const w = new LoadWaiters(() => fired++);
  const a = new AbortController();
  a.abort();
  w.add(a.signal);
  assert.equal(w.size, 0);
  assert.equal(fired, 1, "nobody wants this load");
  const keep = new LoadWaiters(() => fired++);
  keep.add(new AbortController().signal);
  keep.add(a.signal);
  assert.equal(keep.size, 1);
  assert.equal(fired, 1, "a live waiter keeps it");
});

// ---- ensureBuiltinLoaded (browser module, driven in Node through a fake bundle) ----------------
// chrome.runtime.getURL returns a data: URL whose module forwards from_pretrained to a per-test
// hook, so the real load/reuse/join logic runs. Each test imports a fresh module instance (query
// string) because the client keeps the loaded runtime in module state.
const FAKE_BUNDLE =
  "export const env = { backends: { onnx: { wasm: {} } } };" +
  "export const KokoroTTS = { from_pretrained: (id, opts) => globalThis.__fakeKokoro(id, opts) };";
globalThis.chrome = {
  runtime: {
    getURL: (p) => (p.endsWith(".js") ? "data:text/javascript," + encodeURIComponent(FAKE_BUNDLE) : "/" + p),
  },
};
let freshCount = 0;
async function freshClient({ gpu = false, load } = {}) {
  Object.defineProperty(globalThis.navigator, "gpu", {
    configurable: true,
    value: gpu ? { requestAdapter: async () => ({ isFallbackAdapter: false }) } : undefined,
  });
  if (!gpu) delete globalThis.navigator.gpu;
  const calls = [];
  const disposed = [];
  globalThis.__fakeKokoro = async (id, opts) => {
    calls.push(opts.device);
    const n = calls.length;
    if (load) await load(opts);
    return {
      generate: async () => ({ toWav: () => new ArrayBuffer(0) }),
      model: { dispose: async () => disposed.push(n) },
    };
  };
  const mod = await import(`../lib/kokoro-builtin-client.js?fresh=${++freshCount}`);
  return { mod, calls, disposed };
}

// A stand-in for the network: every request hangs until its signal aborts, like a 300 MB transfer.
function hangingFetch() {
  const requests = [];
  globalThis.fetch = (input, init) => {
    const req = { url: String(input), signal: init?.signal };
    requests.push(req);
    return new Promise((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    });
  };
  return requests;
}
const tick = () => new Promise((r) => setTimeout(r, 0));
const MODEL_URL = "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/onnx/model.onnx";

test("ensureBuiltinLoaded: Stop during the download aborts the HTTP transfer, and the next load starts fresh", async () => {
  const requests = hangingFetch();
  const { mod, calls } = await freshClient({ load: () => globalThis.fetch(MODEL_URL) });
  const stop = new AbortController();
  const pending = mod.ensureBuiltinLoaded({ devicePref: "wasm", signal: stop.signal });
  await tick();
  assert.equal(requests.length, 1);
  assert.ok(requests[0].signal, "model request carries the load's signal");
  stop.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(requests[0].signal.aborted, true, "the transfer itself was cancelled, not just our wait");
  assert.equal(mod.builtinDecision(), null, "no runtime for a session that no longer exists");
  globalThis.fetch = async () => new Response("");
  const again = mod.ensureBuiltinLoaded({ devicePref: "wasm" });
  assert.equal((await again).device, "wasm");
  assert.deepEqual(calls, ["wasm", "wasm"], "a fresh load, not the aborted one");
});

test("ensureBuiltinLoaded: a session started right after Stop does not join the load being cancelled", async () => {
  hangingFetch();
  let n = 0;
  const { mod, calls } = await freshClient({ load: () => (++n === 1 ? globalThis.fetch(MODEL_URL) : undefined) });
  const stop = new AbortController();
  const first = mod.ensureBuiltinLoaded({ devicePref: "wasm", signal: stop.signal });
  await tick();
  stop.abort();
  const next = mod.ensureBuiltinLoaded({ devicePref: "wasm" }); // same tick: the old load has not settled
  await assert.rejects(first, { name: "AbortError" });
  assert.equal((await next).device, "wasm", "the new session got a model, not the old session's AbortError");
  assert.deepEqual(calls, ["wasm", "wasm"]);
});

test("ensureBuiltinLoaded: one waiter stopping does not cancel a download another waiter still wants", async () => {
  const requests = hangingFetch();
  let release;
  const gate = new Promise((r) => (release = r));
  const { mod } = await freshClient({ load: () => Promise.race([globalThis.fetch(MODEL_URL), gate]) });
  const a = new AbortController();
  const b = new AbortController();
  const first = mod.ensureBuiltinLoaded({ devicePref: "wasm", signal: a.signal });
  const second = mod.ensureBuiltinLoaded({ devicePref: "wasm", signal: b.signal });
  await tick();
  a.abort();
  await assert.rejects(first, { name: "AbortError" });
  assert.equal(requests[0].signal.aborted, false, "the second session still needs the model");
  release();
  assert.equal((await second).device, "wasm");
});

test("ensureBuiltinLoaded: a load that finishes after everyone left is disposed, not kept", async () => {
  // Cache hit: no fetch to cancel, so from_pretrained resolves anyway; the model must not stay resident.
  let release;
  const gate = new Promise((r) => (release = r));
  const { mod, disposed } = await freshClient({ load: () => gate });
  const stop = new AbortController();
  const pending = mod.ensureBuiltinLoaded({ devicePref: "wasm", signal: stop.signal });
  await tick();
  stop.abort();
  await assert.rejects(pending, { name: "AbortError" });
  release();
  await tick();
  await tick();
  assert.deepEqual(disposed, [1]);
  assert.equal(mod.builtinDecision(), null);
});

test("releaseBuiltin: disposes the loaded model, tolerates none, and the next call reloads", async () => {
  const { mod, calls, disposed } = await freshClient();
  await mod.releaseBuiltin(); // nothing loaded yet: no throw
  await mod.ensureBuiltinLoaded({ devicePref: "wasm" });
  await mod.releaseBuiltin();
  assert.deepEqual(disposed, [1]);
  assert.equal(mod.builtinDecision(), null);
  await assert.rejects(mod.synthesizeBuiltinWav({ input: "hi", voice: "af_heart" }), /not loaded/);
  await mod.ensureBuiltinLoaded({ devicePref: "wasm" });
  assert.deepEqual(calls, ["wasm", "wasm"]);
});

test("releaseBuiltin: waits for an in-flight synthesis before disposing the model under it", async () => {
  let finishGen;
  const order = [];
  await freshClient(); // resets navigator.gpu; the slow model below replaces its fake
  globalThis.__fakeKokoro = async () => ({
    generate: () => new Promise((r) => (finishGen = () => (order.push("gen"), r({ toWav: () => new ArrayBuffer(0) })))),
    model: { dispose: async () => order.push("dispose") },
  });
  const slow = await import(`../lib/kokoro-builtin-client.js?fresh=${++freshCount}`);
  await slow.ensureBuiltinLoaded({ devicePref: "wasm" });
  const stop = new AbortController();
  const synth = slow.synthesizeBuiltinWav({ input: "hi", voice: "af_heart", signal: stop.signal });
  stop.abort(); // the session went away; the abandoned generate keeps running on the model
  await assert.rejects(synth, { name: "AbortError" });
  const released = slow.releaseBuiltin();
  await tick();
  assert.deepEqual(order, [], "must not dispose while generate is still running");
  finishGen();
  await released;
  assert.deepEqual(order, ["gen", "dispose"]);
});

test("ensureBuiltinLoaded: webgpu pref that fell back to wasm loads once, not every session", async () => {
  const { mod, calls } = await freshClient({ gpu: false });
  assert.equal((await mod.ensureBuiltinLoaded({ devicePref: "webgpu" })).device, "wasm");
  assert.equal((await mod.ensureBuiltinLoaded({ devicePref: "webgpu" })).device, "wasm");
  assert.deepEqual(calls, ["wasm"]);
});

test("ensureBuiltinLoaded: a caller with a different pref does not join the in-flight load", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const { mod, calls } = await freshClient({ gpu: true, load: () => gate });
  const first = mod.ensureBuiltinLoaded({ devicePref: "wasm" });
  const second = mod.ensureBuiltinLoaded({ devicePref: "webgpu" });
  const same = mod.ensureBuiltinLoaded({ devicePref: "wasm" });
  release();
  assert.equal((await first).device, "wasm");
  assert.equal((await same).device, "wasm");
  assert.equal((await second).device, "webgpu", "second caller got the first caller's device");
  assert.deepEqual(calls, ["wasm", "webgpu"]);
});

test("ensureBuiltinLoaded: a provider error message is capped before it reaches the UI", async () => {
  const { mod } = await freshClient({
    load: () => {
      throw new Error("x".repeat(5000));
    },
  });
  await assert.rejects(mod.ensureBuiltinLoaded({ devicePref: "wasm" }), (err) => {
    assert.ok(err.message.length <= 300, `message is ${err.message.length} chars`);
    assert.match(err.message, /^Couldn't start the built-in voice: x+…$/);
    return true;
  });
});

// ---- registry + settings -----------------------------------------------------
test("built-in provider is registered, is the default, and needs no server", () => {
  const p = getProvider(PROVIDER_IDS.BUILTIN);
  assert.equal(p.id, "builtin");
  assert.equal(p.hasBaseUrl, false);
  assert.equal(p.needsApiKey, false);
  assert.equal(p.voiceFormulaAllowed, false);
  assert.equal(p.languageInRequest, false);
  assert.equal(DEFAULTS.provider, PROVIDER_IDS.BUILTIN);
  assert.ok(listProviders().some((x) => x.id === "builtin"));
  assert.equal(getProvider("nonsense").id, "builtin", "corrupt provider id falls back to the zero-setup provider");
});

test("built-in provider lists voices and languages without a connection", async () => {
  const p = getProvider(PROVIDER_IDS.BUILTIN);
  assert.equal((await p.listModels({})).length, 1);
  assert.deepEqual((await p.listLanguages({})).map((l) => l.code), ["en-us", "en-gb"]);
  assert.equal((await p.listVoices({ language: "en-gb" })).length, 8);
  assert.equal(await p.ping({}), true);
});

test("settings: built-in connection keys and resolution (device pref travels with the connection)", () => {
  assert.deepEqual(connectionKeys("builtin"), {
    base: "builtinBase",
    model: "builtinModel",
    language: "builtinLanguage",
    voice: "builtinVoice",
  });
  const conn = resolveConnection({ provider: "builtin", builtinVoice: "bm_george", builtinDevice: "wasm" });
  assert.equal(conn.id, "builtin");
  assert.equal(conn.voice, "bm_george");
  assert.equal(conn.device, "wasm");
  assert.equal(conn.apiKey, "");
  // An OpenVox user's flat keys are untouched by the new provider.
  const ov = resolveConnection({ provider: "openvox", voice: "af_sky" });
  assert.equal(ov.voice, "af_sky");
  assert.equal(ov.device, undefined);
});
