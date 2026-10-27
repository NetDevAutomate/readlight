// First-run download consent for the built-in voice: the copy the popup/options show, and the
// pure settings helpers the service worker uses to gate and migrate. No chrome.* needed.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  consentCopy,
  formatBytes,
  isBuiltinDevicePref,
  needsBuiltinConsent,
  CONSENT_STATE,
  CONSENT_PENDING,
} from "../lib/builtin-consent.js";
import { DEFAULTS, LOCAL_DEFAULTS, resolveConnection, migrateBuiltinDevice } from "../lib/settings.js";

const GPU_ENV = { hasAdapter: true, crossOriginIsolated: true, hardwareConcurrency: 8 };
const CPU_ENV = { hasAdapter: false, crossOriginIsolated: true, hardwareConcurrency: 8 };

const body = (size) =>
  `The built-in voice downloads its model once from huggingface.co (about ${size}) and keeps it in this browser's cache. No page text is sent anywhere. Hugging Face sees only the download request.`;

test("formatBytes: whole megabytes for the two model sizes", () => {
  assert.equal(formatBytes(326e6), "326 MB");
  assert.equal(formatBytes(92e6), "92 MB");
  assert.equal(formatBytes(0), "");
  assert.equal(formatBytes(NaN), "");
});

test("consentCopy: GPU pref with an adapter discloses the 326 MB download", () => {
  const c = consentCopy("webgpu", GPU_ENV);
  assert.equal(c.device, "webgpu");
  assert.equal(c.sizeLabel, "326 MB");
  assert.equal(c.label, "on GPU");
  assert.equal(c.body, body("326 MB"));
});

test("consentCopy: CPU pref discloses 92 MB even when a GPU exists", () => {
  const c = consentCopy("wasm", GPU_ENV);
  assert.equal(c.device, "wasm");
  assert.equal(c.sizeLabel, "92 MB");
  assert.equal(c.body, body("92 MB"));
});

test("consentCopy: auto follows the adapter", () => {
  assert.equal(consentCopy("auto", GPU_ENV).sizeLabel, "326 MB");
  const cpu = consentCopy("auto", CPU_ENV);
  assert.equal(cpu.device, "wasm");
  assert.equal(cpu.sizeLabel, "92 MB");
  assert.equal(cpu.body, body("92 MB"));
  // A software (fallback) adapter is not a usable GPU, so auto discloses the CPU model.
  assert.equal(consentCopy("auto", { ...GPU_ENV, isFallbackAdapter: true }).sizeLabel, "92 MB");
});

test("consentCopy: missing/unknown pref and missing env behave as auto without a GPU", () => {
  assert.equal(consentCopy(undefined, GPU_ENV).device, "webgpu");
  assert.equal(consentCopy("bogus", CPU_ENV).device, "wasm");
  assert.equal(consentCopy("auto").device, "wasm");
});

test("isBuiltinDevicePref accepts exactly auto/webgpu/wasm", () => {
  for (const v of ["auto", "webgpu", "wasm"]) assert.equal(isBuiltinDevicePref(v), true, v);
  for (const v of ["", "gpu", "AUTO", null, undefined, 1, {}]) assert.equal(isBuiltinDevicePref(v), false, String(v));
});

test("needsBuiltinConsent: only the built-in provider without a stored grant is gated", () => {
  assert.equal(needsBuiltinConsent({ id: "builtin" }, {}), true);
  assert.equal(needsBuiltinConsent({ id: "builtin" }, { builtinConsent: false }), true);
  // Only a literal true counts: a corrupted "true" string must not skip the disclosure.
  assert.equal(needsBuiltinConsent({ id: "builtin" }, { builtinConsent: "true" }), true);
  assert.equal(needsBuiltinConsent({ id: "builtin" }, { builtinConsent: true }), false);
  assert.equal(needsBuiltinConsent({ id: "openvox" }, {}), false);
  assert.equal(needsBuiltinConsent({ id: "kokoro-web" }, { builtinConsent: false }), false);
  assert.equal(needsBuiltinConsent(null, {}), false);
});

test("consent state/pending strings are the documented values", () => {
  assert.equal(CONSENT_STATE, "needs-consent");
  assert.deepEqual([...Object.values(CONSENT_PENDING)].sort(), ["pick", "preview", "read", "selection"]);
});

test("settings: device pref and consent live in storage.local, not sync", () => {
  assert.equal("builtinDevice" in DEFAULTS, false);
  assert.equal(LOCAL_DEFAULTS.builtinDevice, "auto");
  assert.equal(LOCAL_DEFAULTS.builtinConsent, false);
});

test("resolveConnection: built-in device comes from local settings", () => {
  const c = resolveConnection({ provider: "builtin" }, { builtinDevice: "webgpu" });
  assert.equal(c.device, "webgpu");
  // Local wins over a not-yet-migrated sync value.
  assert.equal(resolveConnection({ provider: "builtin", builtinDevice: "wasm" }, { builtinDevice: "webgpu" }).device, "webgpu");
  assert.equal(resolveConnection({ provider: "builtin" }, {}).device, "auto");
  // A corrupted local value is not passed through to the model loader.
  assert.equal(resolveConnection({ provider: "builtin" }, { builtinDevice: "gpu!" }).device, "auto");
});

test("migrateBuiltinDevice: copies a valid synced pref only when local has none", () => {
  assert.equal(migrateBuiltinDevice("webgpu", undefined), "webgpu");
  assert.equal(migrateBuiltinDevice("wasm", undefined), "wasm");
  assert.equal(migrateBuiltinDevice("webgpu", "wasm"), null); // local already set: keep it
  assert.equal(migrateBuiltinDevice(undefined, undefined), null);
  assert.equal(migrateBuiltinDevice("garbage", undefined), null);
});
