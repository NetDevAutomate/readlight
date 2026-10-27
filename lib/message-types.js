/**
 * Shared message type constants for OpenVox Read Aloud extension.
 * Works as an ES module (import { MSG } from ...).
 * Prevents typos and enables IDE autocomplete / exhaustive checking.
 */
export const MSG = Object.freeze({
  // Service worker targets
  TARGET_SW: "sw",
  TARGET_CONTENT: "content",
  TARGET_OFFSCREEN: "offscreen",
  TARGET_POPUP: "popup",
  TARGET_OPTIONS: "options",

  // From popup → service worker
  START_PAGE: "START_PAGE",
  START_SELECTION: "START_SELECTION",
  START_PICK: "START_PICK",
  PAUSE: "PAUSE",
  RESUME: "RESUME",
  TOGGLE: "TOGGLE", // pause/resume; starts "read page" when idle (keyboard command)
  STOP: "STOP",
  SKIP_NEXT: "SKIP_NEXT",
  SKIP_PREV: "SKIP_PREV",
  REREAD: "REREAD", // re-read the current sentence from its start
  SET_SPEED: "SET_SPEED", // { speed } — applies to the live session and is persisted by the sender
  GET_STATE: "GET_STATE",

  // From options → service worker (voice preview; routed to the offscreen document)
  PREVIEW_VOICE: "PREVIEW_VOICE", // { connection, text, previewId }
  PREVIEW_STOP: "PREVIEW_STOP",

  // From popup/options → service worker: store the built-in voice's one-time download consent
  // for { device } (auto|webgpu|wasm) and then run { pending } (read|selection|pick|preview; see
  // CONSENT_PENDING in lib/builtin-consent.js), so one click both agrees and starts. A preview
  // also carries the { connection, text, previewId } it would have sent with PREVIEW_VOICE.
  GRANT_BUILTIN_CONSENT: "GRANT_BUILTIN_CONSENT",

  // From service worker → content script
  PING: "PING",
  EXTRACT: "EXTRACT",
  HIGHLIGHT: "HIGHLIGHT", // { chunkId, preview? } preview=true paints without announcing
  CLEAR_HIGHLIGHT: "CLEAR_HIGHLIGHT",
  PICK: "PICK",
  DISPOSE: "DISPOSE",

  // From content script → service worker (region picker)
  PICK_RESULT: "PICK_RESULT",
  PICK_CANCELLED: "PICK_CANCELLED",

  // From offscreen → service worker
  CHUNK_STARTED: "CHUNK_STARTED",
  CHUNK_ENDED: "CHUNK_ENDED",
  SESSION_DONE: "SESSION_DONE",
  STATE: "STATE", // { state, phase?, progress?, engine?, startedAt?, index?, total?, speed? }
  // STATE.state values (strings, no enum): idle | loading | playing | paused | done | error |
  // picking, plus "needs-consent" { pending, devicePref } from the service worker when the
  // built-in voice would start its first model download before the user agreed (CONSENT_STATE).
  ERROR: "ERROR",
  PREVIEW_STATE: "PREVIEW_STATE", // { previewId, state: loading|playing|done|error|needs-consent, phase?, progress?, message?, startedAt }

  // From service worker → offscreen
  SESSION_START: "SESSION_START",
  SESSION_PAUSE: "SESSION_PAUSE",
  SESSION_RESUME: "SESSION_RESUME",
  SESSION_STOP: "SESSION_STOP",
  SESSION_SKIP_NEXT: "SESSION_SKIP_NEXT",
  SESSION_SKIP_PREV: "SESSION_SKIP_PREV",
  SESSION_REREAD: "SESSION_REREAD",
  SESSION_SET_SPEED: "SESSION_SET_SPEED",
  SESSION_PREVIEW: "SESSION_PREVIEW", // { connection, text, previewId }
  SESSION_PREVIEW_STOP: "SESSION_PREVIEW_STOP",
});

// Loading-phase detail carried on STATE { state: "loading", phase, progress?, engine? }.
export const PHASE = Object.freeze({
  DOWNLOAD: "download", // built-in voice: fetching model weights (first run only); progress = { loaded, total }
  MODEL: "model", // connecting + loading the TTS model (first load can take a while)
  SYNTH: "synth", // generating audio for the current sentence
});
