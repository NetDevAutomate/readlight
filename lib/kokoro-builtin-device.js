// lib/kokoro-builtin-device.js — decide how the built-in Kokoro model runs. Pure, DOM-free; the
// caller probes the environment and passes the facts in, so the decision is unit-testable.
//
// Measured in an offscreen document on Apple Silicon (rtf = synthesis time / audio length):
// WebGPU fp32 rtf 0.063; WASM q8 rtf 0.60 at 8 threads, no gain beyond 8, 1.6 single-threaded
// (slower than real time). fp16 on WebGPU produces garbled audio and q8 on WebGPU falls back to
// CPU, so those pairs are never chosen.

export const BUILTIN_DEVICE_PREFS = Object.freeze({
  AUTO: "auto", // GPU when there is a usable adapter, else CPU
  WEBGPU: "webgpu",
  WASM: "wasm",
});

export const MAX_WASM_THREADS = 8;

/** Approximate one-time download per path (bytes), for first-run disclosure. */
export const MODEL_DOWNLOAD_BYTES = Object.freeze({ webgpu: 326e6, wasm: 92e6 });

/**
 * @param {{ hasAdapter: boolean, isFallbackAdapter?: boolean, crossOriginIsolated: boolean, hardwareConcurrency?: number }} env
 * @param {string} [pref] one of BUILTIN_DEVICE_PREFS
 * @returns {{ device: "webgpu"|"wasm", dtype: "fp32"|"q8", numThreads: number, label: string, downloadBytes: number }}
 */
export function chooseBuiltinDevice(env, pref = BUILTIN_DEVICE_PREFS.AUTO) {
  const gpuUsable = env.hasAdapter === true && env.isFallbackAdapter !== true;
  const wantGpu = pref === BUILTIN_DEVICE_PREFS.WEBGPU || (pref !== BUILTIN_DEVICE_PREFS.WASM && gpuUsable);
  if (wantGpu && gpuUsable) {
    return { device: "webgpu", dtype: "fp32", numThreads: 1, label: "on GPU", downloadBytes: MODEL_DOWNLOAD_BYTES.webgpu };
  }
  // Threads need SharedArrayBuffer, which needs crossOriginIsolated (COOP/COEP in the manifest).
  const cores = Number.isInteger(env.hardwareConcurrency) && env.hardwareConcurrency > 0 ? env.hardwareConcurrency : 1;
  const numThreads = env.crossOriginIsolated ? Math.max(1, Math.min(MAX_WASM_THREADS, cores)) : 1;
  const label = numThreads > 1 ? "on CPU" : "on CPU, single thread (slow)";
  return { device: "wasm", dtype: "q8", numThreads, label, downloadBytes: MODEL_DOWNLOAD_BYTES.wasm };
}

/**
 * May a caller wanting `wantedPref` use a model loaded (or loading) under `loaded.requestedPref`,
 * which ended up on `loaded.device` (absent while the load is still in flight)? Compare the
 * request, not just the outcome: a "webgpu" pref on a machine without a usable GPU always lands
 * on wasm, and testing `device === pref` there reloaded the whole model on every session.
 * @param {{ requestedPref?: string, device?: string }} loaded
 * @param {string} [wantedPref]
 */
export function canReuseBuiltinLoad(loaded, wantedPref) {
  const want = wantedPref || BUILTIN_DEVICE_PREFS.AUTO;
  const had = loaded?.requestedPref || BUILTIN_DEVICE_PREFS.AUTO;
  if (want === BUILTIN_DEVICE_PREFS.AUTO) return true; // auto takes whatever is already loaded
  if (loaded?.device === want || had === want) return true;
  // "auto" only picks wasm when there is no usable GPU, so a "webgpu" pref would pick wasm too.
  if (want === BUILTIN_DEVICE_PREFS.WEBGPU && had === BUILTIN_DEVICE_PREFS.AUTO && loaded?.device === "wasm") return true;
  return false;
}

// ---- load coordination -------------------------------------------------------------------------

/** A paused session gives the model back after this long; resume reloads it from the Cache API. */
export const PAUSE_RELEASE_MS = 15 * 60 * 1000;

export function shouldReleaseAfterPause(pausedMs, limitMs = PAUSE_RELEASE_MS) {
  return Number.isFinite(pausedMs) && pausedMs >= limitMs;
}

const MODEL_HOSTS = ["huggingface.co", "hf.co"];

/**
 * Is this a Hugging Face file request (weights, config, tokenizer, voice vectors)? Only these get
 * the load's abort signal; every other fetch in the document passes through untouched. Matches the
 * host or a subdomain of it, and only over https, so "evilhuggingface.co" does not qualify.
 */
export function isModelFileUrl(url) {
  let u;
  try {
    u = new URL(url instanceof Request ? url.url : String(url));
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  const host = u.hostname.toLowerCase();
  return MODEL_HOSTS.some((h) => host === h || host.endsWith("." + h));
}

/**
 * Wrap a fetch so that, while `getSignal()` returns a signal, model-file requests carry it: aborting
 * the load then cancels the HTTP transfer (headers and body stream), not just our wait for it.
 * A caller's own signal is kept: the request aborts on whichever fires first.
 */
export function makeLoadAbortingFetch(baseFetch, getSignal) {
  const wrapped = function (input, init) {
    const loadSignal = getSignal();
    if (!loadSignal || !isModelFileUrl(input)) return baseFetch(input, init);
    const own = init?.signal || (input instanceof Request ? input.signal : null);
    const signal = own ? AbortSignal.any([own, loadSignal]) : loadSignal;
    return baseFetch(input, { ...init, signal });
  };
  wrapped.__openvoxBase = baseFetch; // lets a re-install wrap the original, never a stale wrapper
  return wrapped;
}

/**
 * The callers waiting on one model load. Each joins with its session's AbortSignal (or none, which
 * means "cannot be cancelled" and pins the load). When the last cancellable waiter aborts and no
 * pinned waiter remains, `onEmpty` fires once so the load can abort its download.
 */
export class LoadWaiters {
  #live = new Set(); // { signal, onAbort } entries, or a sentinel for a pinned waiter
  #onEmpty;
  #closed = false;
  #fired = false;

  constructor(onEmpty) {
    this.#onEmpty = onEmpty;
  }

  get size() {
    return this.#live.size;
  }

  add(signal) {
    if (this.#closed) return;
    const entry = { signal };
    if (signal) {
      if (signal.aborted) {
        this.#check(); // joining already-aborted adds nothing; it may still be the only "waiter"
        return;
      }
      entry.onAbort = () => this.remove(entry);
      signal.addEventListener("abort", entry.onAbort, { once: true });
    }
    this.#live.add(entry);
    return entry;
  }

  remove(entry) {
    if (!entry || !this.#live.delete(entry)) return;
    entry.signal?.removeEventListener("abort", entry.onAbort);
    this.#check();
  }

  /** The load settled: drop every listener and never fire onEmpty afterwards. */
  close() {
    this.#closed = true;
    for (const e of this.#live) e.signal?.removeEventListener("abort", e.onAbort);
    this.#live.clear();
  }

  #check() {
    if (this.#closed || this.#fired || this.#live.size > 0) return;
    this.#fired = true;
    this.#onEmpty?.();
  }
}

export function formatBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return "";
  return n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`;
}
