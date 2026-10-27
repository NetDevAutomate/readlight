// scripts/package.mjs — build the store zip: `npm run package` (after `npm run build`).
//
// PACKAGE_ENTRIES is the package manifest: what a store reviewer receives. Every entry is a
// top-level file or one of the directories in PACKAGED_DIRS, never a glob. git pathspecs match
// `*.js` in every directory, which is how prototype and source files once leaked into the zip.
// scripts/validate-package.mjs checks this list covers every file the extension loads.
//
// Tracked files come from `git archive HEAD`, so uncommitted edits are not packaged; the built
// vendor/ bundle (gitignored) is appended from the working tree.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGED_DIRS = ["lib", "icons"];

export const PACKAGE_ENTRIES = [
  "manifest.json",
  "service_worker.js",
  "offscreen.js",
  "offscreen.html",
  "content_script.js",
  "popup.html",
  "popup.js",
  "options.html",
  "options.js",
  "lib",
  "icons",
  "LICENSE",
  "PRIVACY.md",
];

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function main() {
  if (!existsSync(path.join(root, "vendor/kokoro.bundle.js"))) {
    console.error("vendor/ is missing: run `npm run build` first.");
    process.exit(1);
  }
  const dirty = execFileSync("git", ["status", "--porcelain", "--", ...PACKAGE_ENTRIES], { cwd: root, encoding: "utf8" });
  if (dirty.trim()) console.warn("warning: uncommitted changes are NOT packaged (git archive HEAD):\n" + dirty);

  const { version } = JSON.parse(readFileSync(path.join(root, "manifest.json"), "utf8"));
  const outDir = path.join(root, "dist");
  const zip = path.join(outDir, `openvox-read-aloud-${version}.zip`);
  mkdirSync(outDir, { recursive: true });
  rmSync(zip, { force: true });
  execFileSync("git", ["archive", "--format=zip", "-o", zip, "HEAD", "--", ...PACKAGE_ENTRIES], { cwd: root, stdio: "inherit" });
  execFileSync("zip", ["-qr", zip, "vendor"], { cwd: root, stdio: "inherit" });
  console.log(`Wrote ${path.relative(root, zip)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
