// service_worker.js — stateless router.
// Owns NO audio/queue state. Responsibilities:
//   • create the offscreen document on demand
//   • find the active tab, ensure the content script is present, ask it to extract text
//   • forward control commands (popup → offscreen) and playback events (offscreen → content/popup)

import { MSG } from "./lib/message-types.js";
import {
  getSettings,
  getSessionOptions,
  getLocalSettings,
  grantBuiltinConsent,
  migrateBuiltinDevice,
  resolveConnection,
} from "./lib/settings.js";
import { classifySender, allowedFrom, capPickResult } from "./lib/sender-guard.js";
import { CONSENT_PENDING, CONSENT_STATE, isBuiltinDevicePref, needsBuiltinConsent } from "./lib/builtin-consent.js";
import { unreadablePageReason } from "./lib/page-access.js";

// Content-script contexts must not read the Kokoro API key (local) or settings (sync).
// Older Chrome lacks setAccessLevel and an area may reject it; either way, carry on.
for (const area of [chrome.storage.local, chrome.storage.sync]) {
  try {
    area.setAccessLevel?.({ accessLevel: "TRUSTED_CONTEXTS" })?.catch?.(() => {});
  } catch {
    /* unsupported on this area / Chrome version */
  }
}

// ---- offscreen lifecycle ---------------------------------------------------
async function hasOffscreen() {
  if (chrome.offscreen?.hasDocument) return await chrome.offscreen.hasDocument();
  const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  return contexts.length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["AUDIO_PLAYBACK"],
    justification: "Play synthesized speech audio for read-aloud.",
  });
}

// Send to the offscreen doc, retrying briefly while its module script boots.
async function sendToOffscreen(msg, { retries = 12 } = {}) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await chrome.runtime.sendMessage({ target: MSG.TARGET_OFFSCREEN, ...msg });
      if (res !== undefined) return res;
    } catch {
      /* no listener yet */
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  // Last attempt (may throw up to caller)
  return chrome.runtime.sendMessage({ target: MSG.TARGET_OFFSCREEN, ...msg });
}

// The content script is injected into the top frame only (executeScript's default), so every
// message to it targets frame 0. Without a frameId Chrome delivers to every frame and the first
// reply wins, so a stale listener in an iframe could answer an EXTRACT with an empty selection.
function sendToContent(tabId, msg) {
  return chrome.tabs.sendMessage(tabId, msg, { frameId: 0 });
}

async function ensureContentScript(tabId) {
  try {
    const pong = await sendToContent(tabId, { target: MSG.TARGET_CONTENT, type: MSG.PING });
    if (pong && pong.ok) return true;
  } catch { /* not injected yet */ }
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["lib/chunker.js", "lib/code-block.js", "content_script.js"],
  });
  return true;
}

function notifyPopup(msg) {
  // Popup may be closed; ignore "no receiver" errors.
  chrome.runtime.sendMessage({ target: MSG.TARGET_POPUP, ...msg }).catch(() => {});
}

function popupError(message) {
  notifyPopup({ type: MSG.STATE, state: "error", message });
}

const FILE_URL_HELP =
  "Chrome blocks extensions on local files until you allow it: open chrome://extensions, " +
  "click Details on Readlight, and turn on “Allow access to file URLs”.";

// Resolve the active tab and make sure the content script is present. Returns the tab,
// or null after reporting the reason to the popup.
async function prepareActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) {
    popupError("No active tab.");
    return null;
  }
  const url = tab.url || "";
  const unreadable = unreadablePageReason(url);
  if (unreadable) {
    popupError(unreadable);
    return null;
  }
  try {
    await ensureContentScript(tab.id);
  } catch (err) {
    popupError(/^file:/.test(url) ? FILE_URL_HELP : "Couldn't inject into page: " + err.message);
    return null;
  }
  return tab;
}

// Hand extracted chunks to the offscreen document. Paints the first sentence immediately
// (preview) so the reader sees where reading will start while the model/audio loads.
async function launchSession({ tabId, sessionId, title, chunks, options }) {
  const first = chunks[0];
  if (first) {
    chrome.tabs
      .sendMessage(tabId, { target: MSG.TARGET_CONTENT, type: MSG.HIGHLIGHT, chunkId: first.id, preview: true })
      .catch(() => {});
  }
  try {
    await ensureOffscreen();
    await sendToOffscreen({ type: MSG.SESSION_START, sessionId, tabId, title, chunks, options });
  } catch (err) {
    sendToContent(tabId, { target: MSG.TARGET_CONTENT, type: MSG.DISPOSE }).catch(() => {});
    popupError("Failed to start playback: " + (err.message || err));
  }
}

// ---- first-run download consent (built-in voice) ---------------------------
// The built-in voice's first use downloads a 92–326 MB model from huggingface.co. Nothing may
// start that download until the user has seen the size and agreed once on this machine
// (lib/builtin-consent.js). Returns the consent-needed STATE (and tells the popup) when gated,
// or null when the caller may go ahead.
async function consentGate(connection, pending) {
  const local = await getLocalSettings();
  if (!needsBuiltinConsent(connection, local)) return null;
  const st = { type: MSG.STATE, state: CONSENT_STATE, pending, devicePref: local.builtinDevice };
  notifyPopup(st);
  return st;
}

// ---- start flow ------------------------------------------------------------
// The content script only ever receives display/chunking settings. The resolved connection
// (which may carry an API key) goes to the offscreen document alone.
async function startReading(mode, { fromShortcut = false } = {}) {
  const tab = await prepareActiveTab();
  if (!tab) return;
  const options = await getSessionOptions();
  const { connection, ...pageOptions } = options;
  const pending = mode === "selection" ? CONSENT_PENDING.SELECTION : CONSENT_PENDING.READ;
  if (await consentGate(connection, pending)) {
    // A keyboard shortcut has no popup to show the consent panel in. Open it where Chrome allows
    // (openPopup is missing or rejects on older versions); the user then clicks Read page there.
    if (fromShortcut) {
      try {
        chrome.action?.openPopup?.()?.catch?.(() => {});
      } catch {
        /* unsupported on this Chrome version */
      }
    }
    return;
  }
  // Sentence splitting uses the active provider's language code.
  pageOptions.language = connection.language;
  let res;
  try {
    res = await sendToContent(tab.id, {
      target: MSG.TARGET_CONTENT,
      type: MSG.EXTRACT,
      mode,
      options: pageOptions,
    });
  } catch (err) {
    popupError("Page didn't respond: " + err.message);
    return;
  }
  // The content script answers { error, chunks: [] } when extraction throws. That is not an empty
  // selection: report it, or a real failure reads as "No text selected." with text visibly selected.
  if (res && typeof res.error === "string" && res.error) {
    popupError(
      "Couldn't read the page: " + res.error.slice(0, 200) + ". Reload the tab (Cmd/Ctrl-R) and try again.",
    );
    return;
  }
  if (!res || !res.chunks || res.chunks.length === 0) {
    popupError(mode === "selection" ? "No text selected." : "No readable text found on this page.");
    return;
  }
  await launchSession({ tabId: tab.id, sessionId: res.sessionId, title: res.title, chunks: res.chunks, options });
}

// ---- region picker ---------------------------------------------------------
// Tabs we sent PICK to and have not yet heard back from. A PICK_RESULT / PICK_CANCELLED from any
// other tab is unsolicited and dropped. Kept in storage.session, not module memory: choosing a
// region can easily take longer than the ~30 s after which Chrome suspends an idle MV3 service
// worker, and a dropped click would leave the popup stuck on "picking". storage.session is only
// readable from extension contexts and is cleared when the browser exits.
const PENDING_PICKS_KEY = "pendingPicks";

async function readPendingPicks() {
  const got = await chrome.storage.session.get(PENDING_PICKS_KEY);
  const v = got?.[PENDING_PICKS_KEY];
  return Array.isArray(v) ? v.filter((x) => Number.isInteger(x)) : [];
}

async function writePendingPicks(ids) {
  await chrome.storage.session.set({ [PENDING_PICKS_KEY]: ids });
}

async function addPendingPick(tabId) {
  const ids = await readPendingPicks();
  if (!ids.includes(tabId)) ids.push(tabId);
  await writePendingPicks(ids);
}

async function removePendingPick(tabId) {
  const ids = await readPendingPicks();
  await writePendingPicks(ids.filter((x) => x !== tabId));
}

// Resolves to the consent-needed STATE when the pick is gated, so the popup (which otherwise
// closes itself to hand keyboard focus to the page) can stay open and show the consent panel.
async function startPick() {
  const tab = await prepareActiveTab();
  if (!tab) return null;
  const [options, local] = await Promise.all([getSettings(), getLocalSettings()]);
  // Gate before PICK, not after the click: asking only once a region was chosen would make the
  // user pick twice, and the popup is closed by then so the panel would have nowhere to show.
  const gated = await consentGate(resolveConnection(options, local), CONSENT_PENDING.PICK);
  if (gated) return gated;
  // Recorded before sending: the reply can only follow a click, but never race it.
  await addPendingPick(tab.id);
  try {
    await sendToContent(tab.id, { target: MSG.TARGET_CONTENT, type: MSG.PICK, options });
    notifyPopup({ type: MSG.STATE, state: "picking" });
  } catch (err) {
    await removePendingPick(tab.id);
    popupError("Page didn't respond: " + err.message);
  }
  return null;
}

// True once per PICK we sent to this sender's tab; consumes the pending entry.
async function takePendingPick(sender) {
  const tabId = sender?.tab?.id;
  if (tabId === undefined) return false;
  const ids = await readPendingPicks();
  if (!ids.includes(tabId)) return false;
  await writePendingPicks(ids.filter((x) => x !== tabId));
  return true;
}

// The content script sends PICK_RESULT after the user clicks a region.
async function handlePickResult(msg, sender) {
  if (!(await takePendingPick(sender))) return;
  const tabId = sender.tab.id;
  // Re-cap here: the page renderer the content script shares could send anything.
  const res = capPickResult(msg);
  if (!res) return;
  if (res.chunks.length === 0) {
    popupError("That region has no readable text.");
    return;
  }
  const options = await getSessionOptions();
  // The provider may have changed in Settings while the user was choosing a region.
  if (await consentGate(options.connection, CONSENT_PENDING.PICK)) return;
  await launchSession({ tabId, sessionId: res.sessionId, title: res.title, chunks: res.chunks, options });
}

// ---- session commands ------------------------------------------------------
const SESSION_CMD = {
  [MSG.PAUSE]: MSG.SESSION_PAUSE,
  [MSG.RESUME]: MSG.SESSION_RESUME,
  [MSG.STOP]: MSG.SESSION_STOP,
  [MSG.SKIP_NEXT]: MSG.SESSION_SKIP_NEXT,
  [MSG.SKIP_PREV]: MSG.SESSION_SKIP_PREV,
  [MSG.REREAD]: MSG.SESSION_REREAD,
  [MSG.SET_SPEED]: MSG.SESSION_SET_SPEED,
};

async function sessionCommand(type, extra = {}) {
  if (!(await hasOffscreen())) {
    if (type !== MSG.SET_SPEED) popupError("Nothing is playing — start reading first.");
    return;
  }
  sendToOffscreen({ type: SESSION_CMD[type], ...extra }).catch(() => {});
}

async function currentState() {
  if (!(await hasOffscreen())) return { state: "idle" };
  try {
    return (await sendToOffscreen({ type: MSG.GET_STATE }, { retries: 4 })) || { state: "idle" };
  } catch {
    return { state: "idle" };
  }
}

// One key does the obvious thing: pause if playing, resume if paused, start reading if idle.
async function toggle({ fromShortcut = false } = {}) {
  const st = await currentState();
  if (st.state === "playing" || st.state === "loading") return sessionCommand(MSG.PAUSE);
  if (st.state === "paused") return sessionCommand(MSG.RESUME);
  return startReading("page", { fromShortcut });
}

// Settings-page voice preview: the offscreen document synthesises and plays one phrase with the
// connection the form currently holds (which may be unsaved). Errors come back as PREVIEW_STATE.
// The form's connection is gated like a saved one: previewing the built-in voice is its download.
async function previewVoice({ connection, text, previewId }) {
  const local = await getLocalSettings();
  if (needsBuiltinConsent(connection, local)) {
    chrome.runtime
      .sendMessage({ target: MSG.TARGET_OPTIONS, type: MSG.PREVIEW_STATE, previewId, state: CONSENT_STATE, devicePref: local.builtinDevice })
      .catch(() => {});
    return;
  }
  try {
    await ensureOffscreen();
    await sendToOffscreen({ type: MSG.SESSION_PREVIEW, connection, text, previewId });
  } catch (err) {
    chrome.runtime
      .sendMessage({ target: MSG.TARGET_OPTIONS, type: MSG.PREVIEW_STATE, previewId, state: "error", message: err?.message || String(err) })
      .catch(() => {});
  }
}

// Keyboard shortcuts (manifest "commands"). These outlive the popup, which is the point.
chrome.commands?.onCommand.addListener((command) => {
  switch (command) {
    case "toggle-play":
      toggle({ fromShortcut: true });
      break;
    case "next-sentence":
      sessionCommand(MSG.SKIP_NEXT);
      break;
    case "prev-sentence":
      sessionCommand(MSG.SKIP_PREV);
      break;
    case "reread-sentence":
      sessionCommand(MSG.REREAD);
      break;
  }
});

// ---- install / upgrade -----------------------------------------------------
// The built-in voice is the default for NEW installs. 1.0.x had no `provider` key (OpenVox was
// the only backend), so an upgrade that finds none must keep OpenVox or the user's configured
// server would silently stop being used.
chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason !== "update") return;
  const { provider } = await chrome.storage.sync.get("provider");
  if (provider === undefined) await chrome.storage.sync.set({ provider: "openvox" });
  // The built-in device pref moved from storage.sync to storage.local (it is a fact about this
  // machine's GPU). Copy it over once, keeping any local choice, then drop the synced key.
  const [{ builtinDevice: synced }, { builtinDevice: local }] = await Promise.all([
    chrome.storage.sync.get("builtinDevice"),
    chrome.storage.local.get("builtinDevice"),
  ]);
  const migrated = migrateBuiltinDevice(synced, local);
  if (migrated) await chrome.storage.local.set({ builtinDevice: migrated });
  if (synced !== undefined) await chrome.storage.sync.remove("builtinDevice");
});

// One click both agrees to the download and starts what the consent panel interrupted.
// Extension pages only (the sender guard drops it from content scripts like every other
// non-pick type), and the device is checked here because storage is the loader's input.
async function grantConsent({ device, pending, connection, text, previewId }) {
  if (!isBuiltinDevicePref(device)) return;
  await grantBuiltinConsent(device);
  switch (pending) {
    case CONSENT_PENDING.READ:
      return startReading("page");
    case CONSENT_PENDING.SELECTION:
      return startReading("selection");
    case CONSENT_PENDING.PICK:
      return startPick();
    case CONSENT_PENDING.PREVIEW:
      // The options form's connection, with the device the user just agreed to.
      if (connection && typeof connection === "object") return previewVoice({ connection: { ...connection, device }, text, previewId });
      return;
  }
}

// ---- message routing -------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== MSG.TARGET_SW) return;
  // msg.target is whatever the sender wrote; authorise on Chrome's `sender` instead. Dropped
  // silently (no response) so a page probing from a content-script context learns nothing.
  if (!allowedFrom(classifySender(sender, chrome.runtime.id), msg.type, MSG)) return;

  switch (msg.type) {
    // From popup ---------------------------------------------------------
    case MSG.START_PAGE:
      startReading("page");
      break;
    case MSG.START_SELECTION:
      startReading("selection");
      break;
    case MSG.START_PICK:
      // Replies so the popup knows whether to close (picking) or show the consent panel.
      startPick().then(sendResponse, () => sendResponse(null));
      return true; // async response
    case MSG.TOGGLE:
      toggle();
      break;
    case MSG.PAUSE:
    case MSG.RESUME:
    case MSG.STOP:
    case MSG.SKIP_NEXT:
    case MSG.SKIP_PREV:
    case MSG.REREAD:
      sessionCommand(msg.type);
      break;
    case MSG.SET_SPEED:
      sessionCommand(MSG.SET_SPEED, { speed: msg.speed });
      break;
    case MSG.GET_STATE:
      currentState().then(sendResponse);
      return true; // async response

    // From options ---------------------------------------------------------
    case MSG.PREVIEW_VOICE:
      previewVoice(msg);
      break;
    case MSG.PREVIEW_STOP:
      hasOffscreen().then((yes) => yes && sendToOffscreen({ type: MSG.SESSION_PREVIEW_STOP }).catch(() => {}));
      break;

    // From popup or options -------------------------------------------------
    case MSG.GRANT_BUILTIN_CONSENT:
      grantConsent(msg);
      break;

    // From offscreen -----------------------------------------------------
    case MSG.CHUNK_STARTED:
      chrome.tabs
        .sendMessage(msg.tabId, { target: MSG.TARGET_CONTENT, type: MSG.HIGHLIGHT, chunkId: msg.chunkId })
        .catch(() => {});
      notifyPopup({ type: MSG.STATE, state: "playing", index: msg.index, total: msg.total });
      break;
    case MSG.CHUNK_ENDED:
      chrome.tabs
        .sendMessage(msg.tabId, { target: MSG.TARGET_CONTENT, type: MSG.CLEAR_HIGHLIGHT, chunkId: msg.chunkId })
        .catch(() => {});
      break;
    case MSG.SESSION_DONE:
      if (msg.tabId)
        sendToContent(msg.tabId, { target: MSG.TARGET_CONTENT, type: MSG.DISPOSE }).catch(() => {});
      break;
    case MSG.STATE:
      notifyPopup(msg);
      break;
    case MSG.PREVIEW_STATE:
      chrome.runtime.sendMessage({ ...msg, target: MSG.TARGET_OPTIONS }).catch(() => {});
      break;
    case MSG.ERROR:
      if (msg.tabId)
        sendToContent(msg.tabId, { target: MSG.TARGET_CONTENT, type: MSG.DISPOSE }).catch(() => {});
      notifyPopup({ type: MSG.STATE, state: "error", message: msg.message });
      break;

    // From content (region picker) ---------------------------------------
    case MSG.PICK_RESULT:
      handlePickResult(msg, sender);
      break;
    case MSG.PICK_CANCELLED:
      takePendingPick(sender).then((ok) => {
        if (ok) notifyPopup({ type: MSG.STATE, state: "idle" });
      });
      break;
  }
});
