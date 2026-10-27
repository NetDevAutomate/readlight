// scripts/build-vendor.mjs — bundle the built-in Kokoro voice into vendor/ so the extension ships
// no remotely hosted code (an MV3 requirement). Output is gitignored and reproducible from
// package-lock.json: `npm ci && npm run build`.
//
//   vendor/kokoro.bundle.js   kokoro-js + @huggingface/transformers + phonemizer (ESM, ~5 MB)
//   vendor/ort/*              ONNX Runtime Web wasm + loader (.jsep = WebGPU-capable flavour)
//   vendor/BUILD.json         source commit, versions and sizes, for the store listing and reviewers
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdir, copyFile, rm, stat, writeFile, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const vendor = path.join(root, "vendor");
const ortOut = path.join(vendor, "ort");
const ortDist = path.join(root, "node_modules/onnxruntime-web/dist");

// kokoro-js imports node's path/fs for its voices-on-disk branch; dead in the browser.
const emptyNodeBuiltins = {
  name: "empty-node-builtins",
  setup(b) {
    b.onResolve({ filter: /^(path|fs\/promises|fs|url|node:.*)$/ }, (args) => ({ path: args.path, namespace: "empty" }));
    b.onLoad({ filter: /.*/, namespace: "empty" }, () => ({
      contents: "export default {}; export const readFile = undefined;",
      loader: "js",
    }));
  },
};

await rm(vendor, { recursive: true, force: true });
await mkdir(ortOut, { recursive: true });

const result = await build({
  entryPoints: [path.join(root, "src/kokoro-entry.js")],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["chrome116"],
  outfile: path.join(vendor, "kokoro.bundle.js"),
  plugins: [emptyNodeBuiltins],
  legalComments: "linked", // third-party licence notices land in kokoro.bundle.js.LEGAL.txt
  minify: false, // readable for store reviewers; size is dominated by the wasm anyway
  sourcemap: false,
  logLevel: "warning",
  external: ["onnxruntime-node", "sharp"],
  define: { "process.env.NODE_ENV": '"production"' },
});
if (result.errors.length) process.exit(1);

// transformers.js picks the ORT file by name at runtime from env.backends.onnx.wasm.wasmPaths.
const ORT_FILES = [
  "ort-wasm-simd-threaded.jsep.mjs",
  "ort-wasm-simd-threaded.jsep.wasm",
  "ort-wasm-simd-threaded.mjs",
  "ort-wasm-simd-threaded.wasm",
];
for (const f of ORT_FILES) await copyFile(path.join(ortDist, f), path.join(ortOut, f));

const version = async (pkg) => JSON.parse(await readFile(path.join(root, "node_modules", pkg, "package.json"), "utf8")).version;
const size = async (p) => (await stat(p)).size;
// The commit, not a timestamp: a wall-clock stamp made every rebuild differ, so a reviewer
// could never reproduce BUILD.json. Building outside a git checkout is legitimate (a source
// tarball), hence the fallback rather than a failed build.
function sourceCommit() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "unknown";
  }
}
const info = {
  sourceCommit: sourceCommit(),
  versions: {
    "kokoro-js": await version("kokoro-js"),
    "@huggingface/transformers": await version("@huggingface/transformers"),
    "onnxruntime-web": await version("onnxruntime-web"),
    esbuild: await version("esbuild"),
  },
  bytes: {
    "kokoro.bundle.js": await size(path.join(vendor, "kokoro.bundle.js")),
    ...Object.fromEntries(await Promise.all(ORT_FILES.map(async (f) => [`ort/${f}`, await size(path.join(ortOut, f))]))),
  },
};
await writeFile(path.join(vendor, "BUILD.json"), JSON.stringify(info, null, 2) + "\n");
const mb = (n) => (n / 1e6).toFixed(1);
console.log(
  `vendor/: bundle ${mb(info.bytes["kokoro.bundle.js"])} MB, ORT ${mb(Object.entries(info.bytes).filter(([k]) => k.startsWith("ort/")).reduce((a, [, v]) => a + v, 0))} MB ` +
    `(kokoro-js ${info.versions["kokoro-js"]}, onnxruntime-web ${info.versions["onnxruntime-web"]})`,
);
