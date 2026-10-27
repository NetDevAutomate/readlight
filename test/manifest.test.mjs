// test/manifest.test.mjs — store-readiness guards. Each assertion maps to a known
// Chrome Web Store / AMO review flag; a failure here means the package will be queried.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(path.join(root, "manifest.json"), "utf8"));
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));

test("version is semver and matches package.json", () => {
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.version, pkg.version);
});

test("icons exist for 16/32/48/128 and are wired to the action", () => {
  for (const size of ["16", "32", "48", "128"]) {
    assert.ok(manifest.icons?.[size], `icons.${size} missing`);
    assert.ok(existsSync(path.join(root, manifest.icons[size])), `${manifest.icons[size]} missing on disk`);
    assert.equal(manifest.action?.default_icon?.[size], manifest.icons[size]);
  }
});

test("CSP has no connect-src (host permissions gate fetches, not CSP); wasm-unsafe-eval for ONNX Runtime only", () => {
  const csp = manifest.content_security_policy?.extension_pages || "";
  assert.doesNotMatch(csp, /connect-src/);
  assert.match(csp, /script-src 'self' 'wasm-unsafe-eval'/);
  assert.doesNotMatch(csp, /unsafe-eval(?!')|'unsafe-eval'|unsafe-inline/, "only wasm-unsafe-eval is acceptable");
  assert.match(csp, /object-src 'self'/);
});

test("COOP/COEP are set (crossOriginIsolated → multi-threaded WASM for the built-in voice)", () => {
  assert.equal(manifest.cross_origin_embedder_policy?.value, "require-corp");
  assert.equal(manifest.cross_origin_opener_policy?.value, "same-origin");
});

test("keyboard commands: ≤4 suggested keys, every key has a modifier, descriptions present", () => {
  const cmds = Object.entries(manifest.commands || {});
  assert.ok(cmds.length > 0, "no commands declared");
  const suggested = cmds.filter(([, c]) => c.suggested_key);
  assert.ok(suggested.length <= 4, "Chrome allows at most 4 suggested_key bindings");
  for (const [name, c] of cmds) {
    assert.ok(c.description, `${name} needs a description`);
    const key = c.suggested_key?.default;
    if (key) assert.match(key, /^(Ctrl|Alt|Command|MacCtrl)\+/, `${name}: ${key} needs a modifier`);
  }
});

test("package is publishable: not private, has a licence file", () => {
  assert.notEqual(pkg.private, true, "package.json still says private");
  assert.ok(existsSync(path.join(root, "LICENSE")), "LICENSE missing");
  assert.ok(existsSync(path.join(root, "PRIVACY.md")), "PRIVACY.md missing");
});

test("host permissions: OpenVox default origin + the model-weight hosts only; optional patterns declared", () => {
  assert.deepEqual(manifest.optional_host_permissions, ["http://*/*", "https://*/*"]);
  assert.deepEqual(manifest.host_permissions, [
    "http://127.0.0.1:8005/*",
    "https://huggingface.co/*",
    "https://*.huggingface.co/*",
    "https://*.hf.co/*",
  ]);
});

test("no remote code: the only script sources are files inside the package", () => {
  // kokoro-js, transformers.js and ONNX Runtime are bundled into vendor/ by `npm run build`;
  // nothing may import from a CDN. Model WEIGHTS are data and may be fetched.
  const files = ["offscreen.js", "lib/kokoro-builtin-client.js", "src/kokoro-entry.js"];
  for (const f of files) {
    const src = readFileSync(path.join(root, f), "utf8");
    assert.doesNotMatch(src, /import\((["'`])https?:/, `${f} imports remote code`);
    assert.doesNotMatch(src, /from\s+["']https?:/, `${f} imports remote code`);
  }
});
