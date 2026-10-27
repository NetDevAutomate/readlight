// popup.js — thin control surface. All state lives in the offscreen document;
// the popup just sends commands and renders STATE broadcasts.
import { MSG, PHASE } from "./lib/message-types.js";
import { SPEED_PRESETS, getSettings } from "./lib/settings.js";
import { clampSpeed } from "./lib/openvox-client.js";
import { CONSENT_PENDING, CONSENT_STATE, consentCopy, isBuiltinDevicePref } from "./lib/builtin-consent.js";

const $ = (id) => document.getElementById(id);
const sw = (type, extra = {}) => chrome.runtime.sendMessage({ target: MSG.TARGET_SW, type, ...extra });

let lastState = "idle";
let lastSt = null; // last STATE rendered; re-rendered every second while loading so the timer ticks
let tick = null;

function mmss(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// Elapsed time on every loading line: a cold OpenVox load or Kokoro Web's first-run model
// download holds one HTTP request open for minutes with nothing to measure, and a line that
// visibly counts is the difference between "working" and "hung".
function elapsedSuffix(st) {
  return typeof st.startedAt === "number" ? ` · ${mmss(Date.now() - st.startedAt)}` : "";
}

function loadingText(st) {
  const n = typeof st.index === "number" && st.total ? ` ${st.index + 1}/${st.total}` : "";
  const t = elapsedSuffix(st);
  // "Part", not "sentence": lib/chunker.js merges short sentences (~180 chars), so one unit is
  // often two or three sentences and "sentence 3/41" would overclaim.
  if (st.phase === PHASE.SYNTH) return `Generating part${n}…${t}`;
  if (st.phase === PHASE.DOWNLOAD && st.progress?.total) {
    // The first progress events cover tiny config files (a few KB) before the weights appear;
    // a percentage would read 100% then jump back, so only show numbers once the total is real.
    if (st.progress.total < 1e6) return `Downloading the voice model… (one time only)${t}`;
    const pct = Math.min(100, Math.floor((st.progress.loaded / st.progress.total) * 100));
    const mb = (b) => Math.round(b / 1e6);
    return `Downloading the voice model… ${pct}% (${mb(st.progress.loaded)} of ${mb(st.progress.total)} MB, one time only)${t}`;
  }
  return `Connecting and loading the voice model… (first load can take a while)${t}`;
}

function render(st) {
  st = st || { state: "idle" };
  lastSt = st;
  lastState = st.state || "idle";
  if (tick) clearInterval(tick);
  tick = null;
  if (st.state === CONSENT_STATE) {
    showConsent(st);
    return;
  }
  hideConsent();
  if (st.state === "loading" && typeof st.startedAt === "number") {
    tick = setInterval(() => {
      if (lastSt === st) $("status").textContent = loadingText(st);
    }, 1000);
  }
  const status = $("status");
  status.classList.remove("error");
  let txt;
  switch (st.state) {
    case "loading":
      txt = loadingText(st);
      break;
    case "playing":
      txt = "Reading…";
      break;
    case "paused":
      txt = "Paused.";
      break;
    case "done":
      txt = "Finished.";
      break;
    case "error":
      txt = st.message || "Error.";
      status.classList.add("error");
      break;
    case "picking":
      txt = "Click the area on the page to read… (Esc cancels)";
      break;
    case "idle":
    default:
      txt = st.message || "Idle.";
  }
  status.textContent = txt;
  const pos = typeof st.index === "number" && st.total ? `Part ${st.index + 1} / ${st.total}` : "";
  const via = typeof st.provider === "string" && st.provider ? st.provider.replace(/\s*\(.*\)$/, "") : "";
  const engine = typeof st.engine === "string" && st.engine ? st.engine : "";
  $("meta").textContent = [pos, [via, engine].filter(Boolean).join(" ")].filter(Boolean).join(" · ");
  if (typeof st.speed === "number") setSpeedSelect(st.speed);

  const paused = st.state === "paused";
  const loading = st.state === "loading";
  const active = st.state === "playing" || st.state === "loading" || paused;
  const playpauseBtn = $("playpause");
  playpauseBtn.textContent = paused ? "▶ Resume" : "⏸ Pause";
  playpauseBtn.setAttribute("aria-label", paused ? "Resume reading" : "Pause reading");
  playpauseBtn.disabled = !active;
  $("prev").disabled = !active || loading;
  $("next").disabled = !active || loading;
  $("reread").disabled = !active || loading;
  $("stop").disabled = !active;
}

// ---- first-run download consent --------------------------------------------
// The service worker answers a built-in read with STATE "needs-consent" until the user has agreed
// to the one-time model download; this panel replaces the controls until they choose.
let consentPending = CONSENT_PENDING.READ;
let consentEnv = null; // probed once per popup; requestAdapter can take a moment

async function probeEnv() {
  if (consentEnv) return consentEnv;
  let adapter = null;
  try {
    adapter = navigator.gpu ? await navigator.gpu.requestAdapter() : null;
  } catch {
    /* no WebGPU here */
  }
  // crossOriginIsolated only decides the CPU thread count, which changes neither the device nor
  // the download size shown here; the offscreen document makes that call for itself.
  consentEnv = {
    hasAdapter: !!adapter,
    isFallbackAdapter: adapter?.info?.isFallbackAdapter === true || adapter?.isFallbackAdapter === true,
    crossOriginIsolated: true,
    hardwareConcurrency: navigator.hardwareConcurrency,
  };
  return consentEnv;
}

const consentRadios = () => Array.from(document.querySelectorAll('input[name="consent-device"]'));
const chosenDevice = () => consentRadios().find((r) => r.checked)?.value || "auto";

async function updateConsentCopy() {
  const env = await probeEnv();
  $("consent-body").textContent = consentCopy(chosenDevice(), env).body;
  const auto = consentCopy("auto", env);
  $("consent-auto-size").textContent = `${auto.sizeLabel}, ${auto.device === "webgpu" ? "GPU here" : "CPU here"}`;
}

function showConsent(st) {
  consentPending = Object.values(CONSENT_PENDING).includes(st.pending) ? st.pending : CONSENT_PENDING.READ;
  const pref = isBuiltinDevicePref(st.devicePref) ? st.devicePref : "auto";
  for (const r of consentRadios()) r.checked = r.value === pref;
  $("consent-accept").textContent = consentPending === CONSENT_PENDING.PICK ? "Download and pick" : "Download and read";
  const wasHidden = $("consent").hidden;
  $("controls").hidden = true;
  $("consent").hidden = false;
  const status = $("status");
  status.classList.remove("error");
  status.textContent = "Waiting for your OK to download the voice model.";
  $("meta").textContent = "";
  updateConsentCopy();
  // Move focus only when the panel appears, so a repeated STATE does not yank it off a radio.
  if (wasHidden) $("consent-title").focus();
}

function hideConsent() {
  if ($("consent").hidden) return;
  $("consent").hidden = true;
  $("controls").hidden = false;
}

function declineConsent() {
  render({ state: "idle" });
  $("read-page").focus();
}

for (const r of consentRadios()) r.addEventListener("change", () => updateConsentCopy());
$("consent-decline").addEventListener("click", declineConsent);
$("consent-accept").addEventListener("click", () => {
  const pending = consentPending;
  const sent = sw(MSG.GRANT_BUILTIN_CONSENT, { device: chosenDevice(), pending });
  if (pending === CONSENT_PENDING.PICK) {
    // Same reason as "Read a region…": the picker's keys need focus back on the page.
    Promise.resolve(sent).finally(() => window.close());
    return;
  }
  hideConsent();
  $("status").textContent = "Starting…";
});

// ---- speed -----------------------------------------------------------------
function setSpeedSelect(speed) {
  const sel = $("speed");
  const value = String(clampSpeed(speed));
  if (!Array.from(sel.options).some((o) => o.value === value)) {
    const o = document.createElement("option");
    o.value = value;
    o.textContent = `${value}×`;
    sel.appendChild(o);
  }
  sel.value = value;
}

function initSpeedSelect(speed) {
  const sel = $("speed");
  sel.innerHTML = "";
  for (const [value, label] of SPEED_PRESETS) {
    const o = document.createElement("option");
    o.value = String(value);
    o.textContent = label;
    sel.appendChild(o);
  }
  setSpeedSelect(speed);
  sel.addEventListener("change", async () => {
    const speed = clampSpeed(sel.value);
    await chrome.storage.sync.set({ speed }); // persists for the next session
    sw(MSG.SET_SPEED, { speed }); // applies to the live one
  });
}

// ---- keyboard shortcut hints (read live, so rebinding in chrome://extensions/shortcuts shows) --
async function renderHints() {
  if (!chrome.commands?.getAll) return;
  const cmds = await chrome.commands.getAll();
  const key = (name) => cmds.find((c) => c.name === name)?.shortcut || "";
  const titles = {
    "toggle-play": ["playpause", "Pause / Resume (or start reading)"],
    "next-sentence": ["next", "Next sentence"],
    "prev-sentence": ["prev", "Previous sentence"],
    "reread-sentence": ["reread", "Re-read this sentence"],
  };
  const hint = $("hint");
  hint.replaceChildren();
  const bound = [];
  for (const [name, [id, label]] of Object.entries(titles)) {
    const k = key(name);
    $(id).setAttribute("title", k ? `${label} (${k})` : label);
    if (k) bound.push([k, label.split(" (")[0].toLowerCase()]);
  }
  if (!bound.length) {
    hint.textContent =
      "Set keyboard shortcuts at chrome://extensions/shortcuts to control reading without opening this popup.";
    return;
  }
  bound.forEach(([k, label], i) => {
    if (i) hint.append(" · ");
    const kbd = document.createElement("kbd");
    kbd.textContent = k;
    hint.append(kbd, ` ${label}`);
  });
  hint.append(" — work anywhere, even with this popup closed.");
}

// ---- wiring ----------------------------------------------------------------
$("read-page").addEventListener("click", () => sw(MSG.START_PAGE));
$("read-region").addEventListener("click", () => {
  // Close the popup so keyboard focus returns to the page — otherwise the popup
  // swallows the picker's ↑/↓/Esc keys. (Mouse hover + scroll work either way.)
  // Unless the service worker answers "needs-consent": then stay open for the consent panel.
  Promise.resolve(sw(MSG.START_PICK)).then(
    (res) => (res?.state === CONSENT_STATE ? render(res) : window.close()),
    () => window.close(),
  );
});
$("read-selection").addEventListener("click", () => sw(MSG.START_SELECTION));
$("stop").addEventListener("click", () => sw(MSG.STOP));
$("prev").addEventListener("click", () => sw(MSG.SKIP_PREV));
$("next").addEventListener("click", () => sw(MSG.SKIP_NEXT));
$("reread").addEventListener("click", () => sw(MSG.REREAD));
$("playpause").addEventListener("click", () => sw(lastState === "paused" ? MSG.RESUME : MSG.PAUSE));
$("open-options").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

// In-popup keys (only while the popup is open; the global ones live in manifest "commands").
document.addEventListener("keydown", (e) => {
  // While the consent panel is up, Space/R/arrows belong to its radios and buttons; only Esc
  // means something here (Not now).
  if (!$("consent").hidden) {
    if (e.key === "Escape") {
      e.preventDefault();
      declineConsent();
    }
    return;
  }
  if (e.target instanceof HTMLSelectElement) return;
  if (e.key === " " && !e.repeat) {
    e.preventDefault();
    sw(MSG.TOGGLE);
  } else if ((e.metaKey || e.ctrlKey) && e.key === "ArrowLeft") {
    e.preventDefault();
    sw(MSG.SKIP_PREV);
  } else if ((e.metaKey || e.ctrlKey) && e.key === "ArrowRight") {
    e.preventDefault();
    sw(MSG.SKIP_NEXT);
  } else if (e.key === "r" && !e.metaKey && !e.ctrlKey && !e.altKey) {
    e.preventDefault();
    sw(MSG.REREAD);
  }
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.target === MSG.TARGET_POPUP && msg.type === MSG.STATE) render(msg);
});

(async () => {
  const settings = await getSettings();
  initSpeedSelect(settings.speed);
  renderHints();
  try {
    render(await sw(MSG.GET_STATE));
  } catch {
    render({ state: "idle" });
  }
})();
