# Readlight

A free, open-source browser extension (Manifest V3; Chromium-based browsers such as Chrome, Edge and Brave, Firefox planned) that reads the **current page**, a **region you point at**, or your **highlighted selection** aloud — and highlights the sentence it's currently speaking, in a colour you choose (or no highlight at all).

Speech comes from one of three providers you pick in Settings:

| Provider | Needs | Where the text goes |
|---|---|---|
| **Built-in voice** (default) | Nothing. Kokoro-82M runs *inside the browser* on WebGPU (or CPU) | Nowhere — synthesis happens in the extension. The model (326 MB GPU / 92 MB CPU) is downloaded from huggingface.co once and cached. |
| **OpenVox** | The [OpenVox](https://openvoxai.com/support) desktop app with its Local API on | `http://127.0.0.1:8005` on your machine |
| **Kokoro Web** | A self-hosted [Kokoro Web](https://github.com/eduardolat/kokoro-web) server | The URL you configure (default `127.0.0.1:3000`) |

Built as a study / focus aid, with technical pages and neurodivergent readers in mind: adjustable speed, one-key re-read, keyboard control that works with the popup closed, and code blocks announced rather than read character by character.

---

## Prerequisites

1. A Chromium browser ≥ 116 (Chrome, Edge, Brave, Arc…). For the built-in voice at full speed, WebGPU (Chrome 113+, on by default on macOS/Windows/ChromeOS; it falls back to multi-threaded CPU otherwise).
2. **Node ≥ 20** — to build the built-in voice bundle once (`npm ci && npm run build`), and to run the tests.
3. *Optional:* **OpenVox** installed and running with the **Local API** enabled, reachable at `http://127.0.0.1:8005/v1`, if you prefer its voices or want to keep the model out of the browser.

Verify OpenVox is reachable (only if you use it):

```bash
curl http://127.0.0.1:8005/v1/models
```

---

## Install (load unpacked)

1. `npm ci && npm run build` in this folder — produces `vendor/` (the in-browser voice: ~5 MB JS + ~33 MB ONNX Runtime wasm, gitignored).
2. Open `chrome://extensions`.
3. Toggle **Developer mode** (top-right).
4. Click **Load unpacked** and select this folder (`openvox`).
5. Pin the **🔊 Readlight** icon to the toolbar.

> Tabs that were already open *before* you installed the extension are handled automatically — the service worker injects the content script on demand. If a page still doesn't respond, reload it once.

---

## Usage

Click the toolbar icon:

- **Read page** — auto-detects the main readable content (skips nav/sidebars/ads) and reads it.
- **Read a region…** — when the auto-detector guesses wrong, click this (the popup closes so the page has focus), then hover the pane you want: it outlines in blue. **Scroll up/down to grow/shrink** the outline (or `↑`/`↓` keys) until it wraps the pane you want, then **click** to read it. **Esc** cancels. Deterministic — *you* choose the main pane.
- **Read selection** — select text on the page first, then click this.
- **⏮ / ⏭** — previous / next sentence. **↺ Again** — re-read the current sentence from its start.
- **⏸ Pause / ▶ Resume**, **⏹ Stop**.
- **Speed** — 0.75× to 2×, changeable while reading (the current sentence restarts at the new speed).

The sentence being spoken is highlighted on the page and (optionally) auto-scrolled into view. As soon as you start, the *first* sentence is highlighted while the voice loads, so you can see where reading will begin.

### Keyboard shortcuts (work in any tab, popup closed)

| Default | Action |
|---|---|
| `Alt+Shift+P` | Pause / resume — or start reading the page if nothing is playing |
| `Alt+Shift+.` | Next sentence |
| `Alt+Shift+,` | Previous sentence |
| `Alt+Shift+R` | Re-read the current sentence |

Rebind them at `chrome://extensions/shortcuts`; the popup shows whatever is currently bound. Inside the popup, `Space` toggles, `⌘/Ctrl+←/→` skip, `r` re-reads.

### Settings (right-click the icon → Options, or the *Settings* link in the popup)

- **Speech provider** — *Built-in voice (runs in your browser)*, *OpenVox (local app)* or *Kokoro Web (self-hosted)*. Each provider keeps its own connection settings, so switching back and forth loses nothing.
  - **Built-in voice** (default for new installs): Kokoro-82M via [kokoro-js](https://github.com/hexgrad/kokoro) and ONNX Runtime Web, inside the extension's offscreen document. **Run the voice model** picks *Automatic* (WebGPU when a real adapter exists, else CPU), *GPU* or *CPU*. Measured on an M-series Mac: GPU synthesises ~16× faster than real time, CPU (8 threads) ~1.7×. The weights (326 MB for GPU `fp32`, 92 MB for CPU `q8`) download from huggingface.co on first *Read* with a progress line in the popup, then live in the browser cache. 28 English voices (US/UK); no blending.
  - **Kokoro Web**: run `ghcr.io/eduardolat/kokoro-web` (default `http://127.0.0.1:3000/api/v1`). If the server has `KW_SECRET_API_KEY` set, paste it into **API key** — it is stored on this device only (`storage.local`), never synced. Kokoro voices can be blended: fill in **Custom voice formula** (e.g. `af_bella*0.5+af_heart*0.5`) to override the picker. The first sentence after choosing a new model can take a while — the server downloads the model on first use.
- **Model / Language / Voice** — populated live from the selected provider (OpenVox: `kokoro` → English → *Bella*, *Adam*…; Kokoro Web: `model_q8f16` → English (US) → *Heart*, *Bella*…).
- **Reading speed** — default for new sessions; the popup overrides it live.
- **Code blocks** — how `<pre>` blocks are handled in page/region mode:
  - *Announce* (default): one spoken stand-in such as "Python code block, 12 lines." The block is still highlighted so you keep your place.
  - *Skip*: not mentioned at all.
  - *Read verbatim*: the old behaviour. (Selecting text inside a code block, or picking a code block as the region, always reads it verbatim — that's an explicit request.)
- **API Base URL** — per provider; defaults to `http://127.0.0.1:8005/v1` (OpenVox) or `http://127.0.0.1:3000/api/v1` (Kokoro Web). Change it to reach a server on another host/port. Only the OpenVox default origin is granted at install; saving any other origin (including Kokoro's default) prompts once for permission to connect to it, and only origins you approve are granted.
- **Highlight** — on/off, **colour**, and **opacity**.
- **Auto-scroll** — keep the current sentence in view.
- **Chunk target / max chars** — how aggressively sentences are merged/split.

### Local files (`file://`)

Chrome blocks extensions on local files until you turn on **Allow access to file URLs** for this extension (`chrome://extensions` → Details). The extension tells you this if you try before enabling it.

---

## How it works

```
popup ──START_PAGE/START_SELECTION/PAUSE/STOP/SKIP──▶ service_worker (stateless router)
                                                          │
        ┌── EXTRACT ───────────────────────────────────▶ │ ──▶ content_script
        │   (chunks: id,index,text)  ◀────────────────────┘     • extract page/selection
        │                                                        • sentence-split (Intl.Segmenter)
        │   HIGHLIGHT / CLEAR_HIGHLIGHT / DISPOSE  ◀──────┐      • map sentences → DOM Ranges
        │                                                 │      • paint via CSS Custom Highlight API
        └── SESSION_START / PAUSE / STOP / SKIP ─────────▶ offscreen document
                                                                 • OpenVox client + single-job lock
            CHUNK_STARTED / CHUNK_ENDED / SESSION_DONE ◀──        • <audio> playback + prefetch N+1
                                                                 │
                                                    fetch ───────┴──▶ OpenVox  http://127.0.0.1:8005
```

**Components**

| File | Role |
|------|------|
| `service_worker.js` | Stateless router. Creates the offscreen doc, finds the active tab, forwards messages, handles keyboard commands, paints the preview highlight. Holds no audio state. |
| `offscreen.js` | Owns the OpenVox calls, the **one-job-at-a-time lock**, `<audio>` playback, prefetch, speed changes and re-read. |
| `content_script.js` | Extracts text, maps sentences to DOM `Range`s, applies code-block mode, paints the highlight. |
| `lib/tts-providers.js` | Provider registry: OpenVox and Kokoro Web behind one interface (`ensureReady`, `synthesize`, pickers). The only file that imports a concrete client. |
| `lib/openvox-client.js` | DOM-free OpenVox HTTP client incl. `speed` (also used by tests). |
| `lib/kokoro-client.js` | DOM-free Kokoro Web HTTP client (bearer auth, voice formulas; also used by tests). |
| `lib/tts-error.js` | Provider-neutral `TtsError`. |
| `lib/chunker.js` | Pure sentence chunking (also used by tests). |
| `lib/code-block.js` | Pure "Python code block, 12 lines." announcer (also used by tests). |
| `lib/settings.js` | Single source of truth for defaults and presets. |
| `popup.*` / `options.*` | Controls and settings. |

### Why sentence-level highlighting (not word-level karaoke)

OpenVox returns **audio only — no word/sentence timestamps** (verified against the running API: its streaming events carry base64 WAV and nothing else). Perfectly-synced word highlighting is therefore impossible without timing data.

Instead, the extension splits text into **sentences**, synthesizes **one sentence at a time**, and highlights that sentence for exactly as long as its audio plays. Because the extension controls both the chunk boundary and playback start/end, the highlight is exact *by construction* — no timestamps needed. Sentence granularity is also the sweet spot for studying: precise enough to follow, coarse enough to keep latency low. A **prefetch** of the next sentence runs while the current one plays, but never as a second concurrent OpenVox job (the API allows only one at a time → HTTP 429).

Each highlighted unit is a sentence, or a few short sentences merged (about 180 characters), so navigation is by unit rather than strictly by sentence. The popup therefore counts *parts* (*Part 3 / 41*), while the ⏮ / ⏭ / ↺ controls keep the familiar "sentence" name.

---

## Testing

```bash
npm test          # unit tests (chunker, code blocks, speech body, providers, manifest guards) + live integration (auto-skips if a server is down)
npm run test:live # same; OpenVox integration tests fail (not skip) if the API is unreachable
```

The OpenVox integration test exercises the **real** local API: lists models, finds English voices, loads `kokoro`, asserts `POST /audio/speech` returns a valid `RIFF/WAVE` WAV, and that `speed: 1.5` produces shorter audio than `1.0`. The Kokoro Web tests run the normalisers against responses captured from a real container (`test/fixtures/kokoro/`) and, when an instance answers at `KOKORO_BASE` (default `http://127.0.0.1:3000/api/v1`, key via `KOKORO_API_KEY`), synthesize live too. The manifest tests guard the store-review flags (icons present, no `connect-src`, ≤4 suggested shortcut keys, version parity with `package.json`, licence and privacy policy present).

### Manual in-Chrome smoke test

After *Load unpacked*:

1. **Connection** — Options → with *OpenVox* or *Kokoro Web* selected, *Test connection* shows *Connected ✓* and the Model/Voice dropdowns fill. For any origin other than OpenVox's default (e.g. Kokoro Web on `127.0.0.1:3005`) Chrome asks once for permission to connect — accept it; a declined or missing permission reads as *Not reachable* because the fetch itself is blocked. With *Built-in voice* the server rows are hidden and the voice list is static.
2. **Read selection** — select a paragraph on any article, open the popup, *Read selection*. The first sentence highlights immediately; status says *Connecting and loading the voice model…* then *Generating part 1/N…*; audio plays; the highlight advances.
3. **Read page** — on a news/blog article, *Read page*. The main body reads (nav/sidebars skipped).
4. **Controls** — Pause/Resume, Skip ⏭/⏮, ↺ Again, Stop all behave; Stop clears the highlight.
5. **Speed** — change speed mid-sentence: the sentence restarts at the new rate; following sentences keep it.
6. **Shortcuts** — close the popup, press `Alt+Shift+P`: reading pauses/resumes (or starts on an idle tab).
7. **Code blocks** — on a page with `<pre>` blocks (e.g. MDN), hear "JavaScript code block, N lines." with the block highlighted; switch the setting to *Skip* and *Verbatim* and read again.
8. **Highlight config** — change colour/opacity (or turn highlight off) in Options, then read again.
9. **Long pause** — pause, wait at least 45 seconds, resume: reading continues from the paused sentence (Chrome reaps an idle offscreen document at ~30 s; the sub-audible keepalive tone prevents it).
10. **Voice preview** — Options → pick a voice → *▶ Preview*: one sentence plays in that voice (the button turns into *■ Stop*; the status line shows a counting timer while loading, a download percentage on the built-in voice's first run, then *Playing on GPU…*). Changing the voice mid-preview stops it. With a reading session playing, the preview refuses with *Pause or stop reading first*.
11. **Elapsed timer** — while the popup says *Connecting and loading the voice model…* or *Generating part…*, a `· m:ss` counter ticks every second (a cold OpenVox load or Kokoro Web's first-run model download can hold one request open for minutes).
12. **Built-in voice, first run** — Options → provider *Built-in voice* → Save → *Read selection*. Status shows *Downloading the voice model… N% (… of 326 MB, one time only)*, then *Generating part 1/N…*; the popup meta line ends with *on GPU* (or *on CPU*). Stop, read again: no download line, first audio within ~2 s. Switch **Run the voice model** to *CPU*, Save, read again: *on CPU*, a second (92 MB) download, slower but intelligible.
13. **Speed during generation** — while the status says *Generating part…*, change the speed: reading restarts at the new rate with no error.
14. **Skip during model load** — start reading and press ⏭ while the status still says *Connecting and loading the voice model…*: once the model is ready, reading starts at the next part, not the first.
15. **Long pause during first-run download** — with the built-in voice and an empty cache (remove and re-add the extension), start reading and pause for at least 45 seconds during *Downloading the voice model…*: the download finishes and, on resume, reading continues.

---

## Troubleshooting

| Symptom | Fix |
|--------|-----|
| *"Can't reach the TTS server at …"* | Open OpenVox and enable the Local API. Confirm `curl http://127.0.0.1:8005/v1/models`. |
| *"The built-in voice bundle is missing"* | Run `npm ci && npm run build` in the extension folder, then reload the extension (`vendor/` is built, not committed). |
| *"Couldn't download the voice model from huggingface.co"* | First run of the built-in voice needs internet access to huggingface.co once; retry when online. Afterwards it is served from the browser cache. |
| Built-in voice says *on CPU, single thread (slow)* | `crossOriginIsolated` is false — the manifest's COOP/COEP headers were removed, or the browser does not support them. Restore them (a test guards this). |
| *"OpenVox is busy"* (429) | Another generation/preload is running. The extension retries with backoff; wait and retry. |
| *"No readable text found"* | Some apps render non-standard DOM. Try *Read a region…* or *Read selection* instead. |
| *"Chrome blocks extensions on local files…"* | `chrome://extensions` → Details → **Allow access to file URLs**. |
| No audio but no error | Reopen the popup; some pages restrict audio. Audio plays from the extension's offscreen document, independent of the page. |
| Page opened before install doesn't respond | Reload the tab once (the content script auto-injects on demand, but a reload is the reliable fallback). |
| Shortcut does nothing | Another extension or the OS may own the key. Rebind at `chrome://extensions/shortcuts`. |

---

## Known limitations / roadmap

- **No word-level highlight** — not possible without timestamps from OpenVox (see above).
- Planned: read from a chosen point, resume where you left off on the same page, a Firefox build.
- Deferred: streaming SSE playback, a progress scrubber.

## Privacy

Page text goes to whichever speech provider you pick in Settings, and nowhere else:

- **Built-in voice** (the default for new installs): synthesis runs inside the extension, so **page text never leaves the browser**. The first time you use it, the model and voice files (326 MB GPU / 92 MB CPU) are downloaded from Hugging Face and cached. That download carries no page text, but Hugging Face sees the ordinary request metadata (IP address, HTTP headers). It is repeated only if the browser evicts the cache.
- **OpenVox**: text is sent to the OpenVox app on your own machine at `http://127.0.0.1:8005`. Installs upgraded from 1.0.x that never chose a provider stay on this one.
- **Kokoro Web**: text is sent to the server URL you configure (default `http://127.0.0.1:3000`, also your own machine).

If you point a provider at another origin, the extension asks permission for that origin only. Opening Settings with OpenVox or Kokoro Web selected contacts that server to list its models and voices (no page text); with the built-in voice it makes no request. The extension collects nothing itself and has no servers of its own. Full policy, including a permission-by-permission table: [`PRIVACY.md`](PRIVACY.md).

---

## Project structure

```
openvox/
├── manifest.json          # MV3 manifest + commands + optional_host_permissions
├── service_worker.js      # Stateless router (ESM). Owns no audio state.
├── offscreen.js           # Provider-driven synthesis + one-job lock + <audio> + prefetch + speed (ESM)
├── content_script.js      # Text extraction, code-block mode, Range mapping, CSS Custom Highlight API
├── popup.* / options.*    # Thin UI + settings form
├── icons/                 # icon.svg source + generated PNGs (npm run icons)
├── src/kokoro-entry.js    # The only importer of kokoro-js; bundled by `npm run build`
├── vendor/                # BUILT, gitignored: kokoro.bundle.js + ort/*.wasm (the in-browser voice)
├── lib/
│   ├── chunker.js         # Pure Intl.Segmenter sentence chunking (unit-tested)
│   ├── code-block.js      # Pure code-block announcer (unit-tested)
│   ├── openvox-client.js  # HTTP client incl. speed, also used by Node tests
│   ├── kokoro-client.js   # Kokoro Web HTTP client (fixtures in test/fixtures/kokoro)
│   ├── kokoro-builtin-client.js  # In-browser Kokoro: loads vendor/ bundle on demand (offscreen only)
│   ├── kokoro-builtin-device.js  # Pure WebGPU/WASM decision (unit-tested)
│   ├── kokoro-voices.js   # Static voice table for the built-in provider (unit-tested)
│   ├── tts-providers.js   # Provider registry — the only importer of concrete clients
│   ├── tts-error.js       # Provider-neutral error type
│   ├── settings.js        # Defaults, presets, per-provider connection resolution
│   └── message-types.js   # Single source of truth for all MSG.* constants
├── scripts/               # build-vendor (bundle), package (store zip), validate-package, gen-icons
├── PRIVACY.md             # Hosted privacy policy for the store listings
└── test/                  # Node test runner
```

**Key design choices:**

- **Stateless service worker** + offscreen document = correct MV3 pattern.
- **One-job mutex** in `offscreen.js` prevents HTTP 429 from concurrent synthesis.
- **Sentence-level highlight** is exact by construction (no timestamps from OpenVox).
- **Dynamic host permissions** via `chrome.permissions.request()` — never blanket network access.
- **Speed changes invalidate prefetched audio** via a generation counter, so a sentence is never played at a stale rate.

---

## Development

```bash
# Build the in-browser voice bundle (required before load-unpacked and before packaging)
npm ci
npm run build         # → vendor/ (kokoro-js + ONNX Runtime wasm); reproducible from package-lock.json

# Run tests and packaging validation
npm test
npm run test:live     # fails (not skips) if API unreachable
npm run validate      # verifies referenced extension files are tracked and the vendor build exists
npm run icons         # regenerate icons/*.png from icons/icon.svg (needs rsvg-convert)
npm run preflight     # build + tests + package validation

# Load unpacked in Chrome
# 1. chrome://extensions → Developer mode → Load unpacked → select this folder
# 2. Make changes → reload the extension tile (or use a reload extension)

# After any manifest or service_worker change, always reload the extension
```

**Conventions**

- All inter-component messages use constants from `lib/message-types.js`; all defaults from `lib/settings.js`.
- New features should add unit tests in `test/` where possible.
- Keep the README and architecture diagram in sync with code changes.
- Bump `version` in both `manifest.json` and `package.json` (a test enforces parity).

Packaging: `npm run package` writes `dist/readlight-<version>.zip` from the committed tree plus the built `vendor/` (run `npm run build` first; uncommitted edits are not included). `npm run validate` checks the zip's file list covers everything the manifest loads.

---

## License

[MIT](LICENSE).

---

*README last updated 2026-10-27 for v1.0.0.*
