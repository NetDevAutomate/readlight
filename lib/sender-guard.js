// lib/sender-guard.js — decide who may send what to the service worker.
// Pure, DOM-free. `msg.target` is self-declared by the sender, so it says nothing about trust;
// `sender` is filled in by Chrome and is the only thing worth authorising on. A content script
// runs inside an arbitrary page's renderer, so a compromised page process can speak with its
// voice: it gets the two region-picker replies and nothing else.

/** Max chunks a PICK_RESULT may carry (the content script itself stops well below this). */
export const PICK_MAX_CHUNKS = 2000;
/** Max chars per chunk text (content script's own cap is chunkMaxChars, default 260). */
export const PICK_MAX_TEXT = 800;
const PICK_MAX_TITLE = 300;
const PICK_MAX_ID = 100;

/**
 * Classify a chrome.runtime.onMessage `sender`.
 * @returns {"content" | "extension-page" | "unknown"}
 */
export function classifySender(sender, runtimeId) {
  if (!sender || !runtimeId || sender.id !== runtimeId) return "unknown";
  const url = typeof sender.url === "string" ? sender.url : "";
  // Our own origin wins over sender.tab: the manifest uses options_page, which opens the settings
  // page as a normal tab, and content scripts never run inside chrome-extension:// pages.
  // The trailing slash stops a prefix collision with a longer id.
  if (url.startsWith(`chrome-extension://${runtimeId}/`)) return "extension-page";
  if (sender.tab) return "content";
  return "unknown";
}

/** May a sender of `kind` send a TARGET_SW message of `type`? */
export function allowedFrom(kind, type, MSG) {
  const isPick = type === MSG.PICK_RESULT || type === MSG.PICK_CANCELLED;
  if (kind === "content") return isPick;
  // Pick results carry the tab to read from in sender.tab, which an extension page lacks.
  if (kind === "extension-page") return !isPick;
  return false;
}

const boundedString = (v, max) => (typeof v === "string" ? v : v == null ? "" : String(v)).slice(0, max);

/**
 * Re-cap a PICK_RESULT from the content script before it reaches the offscreen document.
 * Rebuilds each chunk from the known fields only. Returns null when the shape is wrong
 * (caller drops the message); an empty chunk list is returned as-is so the caller can say
 * "no readable text".
 */
export function capPickResult(msg) {
  if (!msg || !Array.isArray(msg.chunks) || msg.chunks.length > PICK_MAX_CHUNKS) return null;
  const chunks = [];
  for (const c of msg.chunks) {
    if (!c || typeof c.text !== "string") return null;
    chunks.push({
      id: boundedString(c.id, PICK_MAX_ID),
      index: Number.isInteger(c.index) ? c.index : chunks.length,
      text: c.text.slice(0, PICK_MAX_TEXT),
    });
  }
  return {
    sessionId: boundedString(msg.sessionId, PICK_MAX_ID),
    title: boundedString(msg.title, PICK_MAX_TITLE),
    chunks,
  };
}
