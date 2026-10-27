# Privacy Policy — OpenVox Read Aloud

_Last updated: 2026-10-26_

OpenVox Read Aloud is a free, open-source browser extension that reads web pages aloud using either a text-to-speech (TTS) voice that runs **inside your browser**, or a TTS server you control. It has no accounts, no analytics, no advertising, and no servers of its own.

## What the extension processes

When you press **Read page**, **Read a region** or **Read selection**, the extension extracts the visible text of that page, region or selection and turns it into speech, one sentence at a time, with the speech provider configured in the extension's settings.

- **By default** the provider is the **built-in voice**: the Kokoro-82M model runs inside the extension itself (on your GPU via WebGPU, or on your CPU). **The text never leaves your browser.** The first time you use it, the extension downloads the model's weight files (about 326 MB for the GPU version or 92 MB for the CPU version) and voice files from Hugging Face (`huggingface.co` and its file hosts) and stores them in the browser's cache. That download sends no page text and no personal data from the extension. Like any file download, the request itself carries the ordinary metadata a web server sees (your IP address and standard HTTP headers such as the browser's user agent), which Hugging Face receives under its own privacy policy. The download happens once, and again only if the browser evicts the cache.
- **OpenVox** sends each sentence to the OpenVox app running on your own computer at `http://127.0.0.1:8005`. The text never leaves your machine. **Kokoro Web** defaults to `http://127.0.0.1:3000`, also on your own computer.
- **If you change a provider's API base URL** in Settings to a remote server, the text is sent to that server instead. The extension asks for your permission for that specific origin when you save it, and revokes the previous origin's permission. You are responsible for the privacy practices of any remote server you choose.

Page text is sent only when you explicitly start reading, and only the page you are reading is processed. One other request is made without pressing Read: when you open the extension's **Settings** page (or switch provider there) with OpenVox or Kokoro Web selected, it contacts that configured server to list its models, languages and voices. No page text is included. With the built-in voice, the Settings page makes no network request; its voice list is built in.

## What the extension stores

| Data | Where | Why |
|------|-------|-----|
| Your settings (speech provider, per-provider API base URL / model / language / voice, built-in voice GPU/CPU preference, speed, code-block mode, highlight colour/opacity, auto-scroll, chunk sizes) | `chrome.storage.sync` (synced by your browser account if you have browser sync enabled) | So your preferences follow you between devices |
| Your Kokoro Web API key, if you enter one | `chrome.storage.local` — **this device only, never synced** | To authenticate to a Kokoro Web server you run that has a key configured. It is sent only to that server, as an `Authorization` header. |
| The built-in voice's model and voice files | The browser's Cache Storage for this extension | So the download is not repeated (the browser may evict it under storage pressure, in which case it is downloaded again). Removing the extension removes them. |

The extension does **not** store page content, reading history, or the audio it plays. Synthesized audio is held in memory only for the current reading session and discarded when you stop.

## What the extension does not do

- No collection of personal information, browsing history, or usage statistics.
- No trackers or advertising. The only third-party host the extension contacts is Hugging Face, to fetch the built-in voice's files as described above.
- No sale, sharing or transfer of data to anyone.
- No remote code: all extension code ships in the package you install. The built-in voice's model weights are data files, not code.

## Permissions, and why each one is needed

| Permission | Why |
|-----------|-----|
| `activeTab`, `scripting` | To read the text of the tab you are looking at, and to highlight the sentence being spoken — only after you click the extension or use its keyboard shortcut. |
| `storage` | To save your settings. |
| `offscreen` | Audio has to be played from a hidden extension page because the background service worker cannot play sound. |
| `http://127.0.0.1:8005/*` | To talk to OpenVox on your own machine (OpenVox's default address). |
| `https://huggingface.co/*`, `https://*.huggingface.co/*`, `https://*.hf.co/*` | To download the built-in voice's model and voice files (public data files) the first time it is used; they are then cached. No page text is sent. |
| Optional `http://*/*`, `https://*/*` | Only requested — for one specific origin — if you point the extension at a different TTS server. Never requested otherwise. |

## Local files

Chrome blocks extensions from reading `file://` pages unless you enable **Allow access to file URLs** for this extension. If you do, the same rules above apply: the text of the local file you choose to read is sent to your configured TTS server, and nowhere else.

## Open source

The full source code is published under the MIT licence so that anyone can verify these statements: see the repository linked from the store listing.

## Contact

Questions or concerns: open an issue on the project repository.
