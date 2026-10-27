import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = process.cwd();
const required = new Set();
const jsFiles = new Set();

function add(file) {
  if (!file) return;
  required.add(path.posix.normalize(file));
}

function readJson(file) {
  return JSON.parse(readFileSync(path.join(root, file), "utf8"));
}

function read(file) {
  return readFileSync(path.join(root, file), "utf8");
}

function fromHtml(file) {
  const html = read(file);
  for (const match of html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)) add(match[1]);
}

function fromJs(file) {
  const source = read(file);
  for (const match of source.matchAll(/\bimport\s+(?:[^"']+\s+from\s+)?["'](\.\/[^"']+)["']/g)) {
    add(path.posix.normalize(path.posix.join(path.posix.dirname(file), match[1])));
  }
  for (const match of source.matchAll(/files:\s*\[([^\]]+)\]/g)) {
    for (const quoted of match[1].matchAll(/["']([^"']+)["']/g)) add(quoted[1]);
  }
}

function git(args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function isIgnored(file) {
  try {
    const output = git(["check-ignore", "-v", file]).trim();
    const pattern = output.split("\t")[0].split(":").slice(2).join(":");
    return !pattern.startsWith("!");
  } catch {
    return false;
  }
}

// Directories whose whole contents belong in the store zip. Everything else at the top level is
// named file by file: a directory or glob there is how prototype and source files once leaked in.
import { PACKAGE_ENTRIES, PACKAGED_DIRS } from "./package.mjs";

/**
 * Cross-check the store-zip entries (scripts/package.mjs) against the files the manifest needs.
 * Pure apart from the default directory probe, so tests can feed it any list.
 * @param {string[]} entries  pathspecs passed to `git archive`
 * @param {Set<string>} requiredFiles  repo-relative paths the extension loads
 * @param {(p: string) => boolean} [isDirectory]  whether a bare top-level name is a directory
 * @returns {string[]} failure messages; empty when the list is sound
 */
export function checkPackagingList(entries, requiredFiles, isDirectory = defaultIsDirectory) {
  if (!Array.isArray(entries) || entries.length === 0) return ["scripts/package.mjs: PACKAGE_ENTRIES is empty"];
  const listed = entries;
  const failures = [];
  for (const entry of listed) {
    const top = entry.split("/")[0];
    const inPackagedDir = PACKAGED_DIRS.includes(top);
    const plainTopLevelFile = !entry.includes("/") && !entry.includes("*") && !isDirectory(entry);
    if (!inPackagedDir && !plainTopLevelFile) {
      failures.push(`scripts/package.mjs packages ${entry}: only top-level files, lib/ and icons/ may be listed`);
    }
  }
  for (const file of Array.from(requiredFiles).sort()) {
    const covered = listed.some((entry) => file === entry || file.startsWith(`${entry.replace(/\/$/, "")}/`));
    if (!covered) failures.push(`scripts/package.mjs omits ${file}, which the extension loads`);
  }
  return failures;
}

function defaultIsDirectory(entry) {
  try {
    return statSync(path.join(root, entry)).isDirectory();
  } catch {
    return false;
  }
}

function main() {
  const manifest = readJson("manifest.json");

  add(manifest.background?.service_worker);
  if (manifest.content_scripts) {
    for (const script of manifest.content_scripts) {
      for (const file of script.js || []) add(file);
    }
  }
  if (manifest.action?.default_popup) add(manifest.action.default_popup);
  if (manifest.options_page) add(manifest.options_page);
  for (const file of Object.values(manifest.icons || {})) add(file);
  for (const file of Object.values(manifest.action?.default_icon || {})) add(file);

  add("offscreen.html");
  for (const file of Array.from(required)) {
    if (file.endsWith(".html")) fromHtml(file);
  }
  for (const file of Array.from(required)) {
    if (file.endsWith(".js") || file.endsWith(".mjs")) jsFiles.add(file);
  }
  for (const file of jsFiles) {
    fromJs(file);
    for (const requiredFile of required) {
      if ((requiredFile.endsWith(".js") || requiredFile.endsWith(".mjs")) && !jsFiles.has(requiredFile)) {
        jsFiles.add(requiredFile);
      }
    }
  }

  const failures = [];
  for (const file of Array.from(required).sort()) {
    const abs = path.join(root, file);
    if (!existsSync(abs)) {
      failures.push(`${file} is referenced but missing`);
      continue;
    }
    if (isIgnored(file)) {
      failures.push(`${file} is ignored by git`);
    }
    try {
      git(["ls-files", "--error-unmatch", file]);
    } catch {
      failures.push(`${file} is not tracked in git`);
    }
  }

  // The store zip must ship everything found above, and nothing from outside the extension
  // (LICENSE and PRIVACY.md are listed too; they are not in `required`, which is fine).
  failures.push(...checkPackagingList(PACKAGE_ENTRIES, required));

  // Built artefacts: loaded by URL at runtime (chrome.runtime.getURL), so the import scan above
  // cannot see them. They are gitignored by design and must come from `npm run build`.
  const BUILT = [
    "vendor/kokoro.bundle.js",
    "vendor/ort/ort-wasm-simd-threaded.jsep.mjs",
    "vendor/ort/ort-wasm-simd-threaded.jsep.wasm",
    "vendor/ort/ort-wasm-simd-threaded.mjs",
    "vendor/ort/ort-wasm-simd-threaded.wasm",
  ];
  for (const file of BUILT) {
    if (!existsSync(path.join(root, file))) failures.push(`${file} is missing — run \`npm run build\``);
  }
  const source = read("lib/kokoro-builtin-client.js");
  for (const quoted of source.matchAll(/"(vendor\/[^"]+)"/g)) {
    const ref = quoted[1];
    const matches = BUILT.some((f) => f === ref || (ref.endsWith("/") && f.startsWith(ref)));
    if (!matches) failures.push(`${ref} is referenced by lib/kokoro-builtin-client.js but not produced by the build`);
  }

  assert.equal(failures.length, 0, failures.join("\n"));
  console.log(`Validated ${required.size} packaged extension files + ${BUILT.length} built vendor files.`);
}

// Run only as `node scripts/validate-package.mjs`; tests import checkPackagingList without
// triggering the vendor/ checks (vendor/ is absent until `npm run build`).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
