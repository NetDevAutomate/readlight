// test/packaging.test.mjs — guards on what a store reviewer receives: the store-zip entry list
// in scripts/package.mjs and the reproducibility of the vendor/ build stamp. Pure: reads files.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PACKAGE_ENTRIES } from "../scripts/package.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFileSync(path.join(root, file), "utf8");

test("build-vendor writes no timestamp, so two builds of one commit give identical BUILD.json", () => {
  const source = read("scripts/build-vendor.mjs");
  assert.doesNotMatch(source, /builtAt/);
  assert.doesNotMatch(source, /new Date\(/);
  assert.match(source, /sourceCommit/);
});

// The entry list is the package manifest. A glob there would match *.js in every directory.
test("package entries name files explicitly: no globs", () => {
  for (const entry of PACKAGE_ENTRIES) assert.doesNotMatch(entry, /\*/, entry);
});

test("package entries include manifest.json, lib, icons, LICENSE and the privacy policy", () => {
  for (const name of ["manifest.json", "lib", "icons", "LICENSE", "PRIVACY.md"]) {
    assert.ok(PACKAGE_ENTRIES.includes(name), `${name} not packaged`);
  }
});

test("package entries leave out tests, scripts, source and docs", () => {
  for (const entry of PACKAGE_ENTRIES) {
    assert.doesNotMatch(entry, /^(test|scripts|src|docs|proto|node_modules)(\/|$)/, entry);
  }
});

// validate-package cross-checks the entries against what the manifest needs, so a new top-level
// file cannot be added to the extension and silently left out of the store zip.
const { checkPackagingList } = await import("../scripts/validate-package.mjs");

test("validate-package: the real entry list covers a representative required set", () => {
  const required = new Set(["manifest.json", "popup.html", "popup.js", "offscreen.js", "lib/chunker.js", "icons/icon16.png"]);
  assert.deepEqual(checkPackagingList(PACKAGE_ENTRIES, required), []);
});

test("validate-package: a required file missing from the list fails with its name", () => {
  const failures = checkPackagingList(["manifest.json", "lib", "icons"], new Set(["manifest.json", "popup.js"]));
  assert.equal(failures.length, 1);
  assert.match(failures[0], /popup\.js/);
});

test("validate-package: a path outside top level / lib / icons fails", () => {
  const failures = checkPackagingList(["manifest.json", "lib", "icons", "proto/ext/background.js", "src"], new Set(["manifest.json"]));
  assert.equal(failures.length, 2);
  assert.match(failures.join("\n"), /proto\/ext\/background\.js/);
  assert.match(failures.join("\n"), /\bsrc\b/);
});

test("validate-package: an empty entry list fails", () => {
  assert.equal(checkPackagingList([], new Set(["manifest.json"])).length, 1);
});
