// src/kokoro-entry.js — the ONLY file that imports kokoro-js. `npm run build` bundles it (plus
// transformers.js, phonemizer and ONNX Runtime Web) into vendor/kokoro.bundle.js, which
// lib/kokoro-builtin-client.js loads on demand inside the offscreen document.
//
// `env` comes from transformers.js itself: kokoro-js re-exports a thin facade (only `wasmPaths`),
// and the client needs env.backends.onnx.wasm.numThreads, env.useBrowserCache, etc.
export { KokoroTTS } from "kokoro-js";
export { env } from "@huggingface/transformers";
