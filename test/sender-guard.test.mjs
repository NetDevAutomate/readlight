// test/sender-guard.test.mjs — who may send what to the service worker, and PICK_RESULT re-capping.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MSG } from "../lib/message-types.js";
import {
  classifySender,
  allowedFrom,
  capPickResult,
  PICK_MAX_CHUNKS,
  PICK_MAX_TEXT,
} from "../lib/sender-guard.js";

const ID = "abcdefghijklmnopabcdefghijklmnop";
const EXT = `chrome-extension://${ID}`;

test("classifySender: content script = our id + a tab + a page url", () => {
  assert.equal(classifySender({ id: ID, tab: { id: 7 }, url: "https://example.com/a" }, ID), "content");
  assert.equal(classifySender({ id: ID, tab: { id: 7 }, url: "file:///tmp/x.html" }, ID), "content");
  // No url at all but a tab: least privilege, still content.
  assert.equal(classifySender({ id: ID, tab: { id: 7 } }, ID), "content");
});

test("classifySender: extension pages (popup, offscreen) have our id, no tab, our origin", () => {
  assert.equal(classifySender({ id: ID, url: `${EXT}/popup.html` }, ID), "extension-page");
  assert.equal(classifySender({ id: ID, url: `${EXT}/offscreen.html` }, ID), "extension-page");
});

test("classifySender: options_page opens in a TAB, so our own origin wins over sender.tab", () => {
  // manifest uses options_page (not options_ui): the settings page is a normal tab, and a
  // tab-based rule alone would demote it to "content" and drop every PREVIEW_VOICE.
  assert.equal(classifySender({ id: ID, tab: { id: 3 }, url: `${EXT}/options.html` }, ID), "extension-page");
});

test("classifySender: anything else is unknown", () => {
  assert.equal(classifySender(undefined, ID), "unknown");
  assert.equal(classifySender(null, ID), "unknown");
  assert.equal(classifySender({}, ID), "unknown");
  assert.equal(classifySender({ id: "otherextension", url: `chrome-extension://otherextension/x.html` }, ID), "unknown");
  assert.equal(classifySender({ id: "otherextension", tab: { id: 1 }, url: "https://e.com" }, ID), "unknown");
  // Our id but no tab and a foreign/missing url.
  assert.equal(classifySender({ id: ID }, ID), "unknown");
  assert.equal(classifySender({ id: ID, url: "https://evil.example/" }, ID), "unknown");
  // Prefix collision: another id that starts with ours.
  assert.equal(classifySender({ id: ID, url: `chrome-extension://${ID}evil/x.html` }, ID), "unknown");
  assert.equal(classifySender({ id: ID, url: `${EXT}` }, ID), "unknown");
  // Missing runtime id never matches a missing sender id.
  assert.equal(classifySender({ url: "chrome-extension://undefined/x.html" }, undefined), "unknown");
});

test("allowedFrom: a content script may only send the pick results", () => {
  assert.equal(allowedFrom("content", MSG.PICK_RESULT, MSG), true);
  assert.equal(allowedFrom("content", MSG.PICK_CANCELLED, MSG), true);
  for (const t of [
    MSG.SESSION_DONE,
    MSG.ERROR,
    MSG.PREVIEW_VOICE,
    MSG.STOP,
    MSG.SET_SPEED,
    MSG.CHUNK_STARTED,
    MSG.STATE,
    MSG.START_PAGE,
    MSG.GET_STATE,
  ]) {
    assert.equal(allowedFrom("content", t, MSG), false, t);
  }
});

test("allowedFrom: extension pages may send everything except the pick results", () => {
  for (const t of [
    MSG.START_PAGE,
    MSG.STOP,
    MSG.SET_SPEED,
    MSG.GET_STATE,
    MSG.PREVIEW_VOICE,
    MSG.PREVIEW_STOP,
    MSG.CHUNK_STARTED,
    MSG.CHUNK_ENDED,
    MSG.SESSION_DONE,
    MSG.STATE,
    MSG.ERROR,
    MSG.PREVIEW_STATE,
  ]) {
    assert.equal(allowedFrom("extension-page", t, MSG), true, t);
  }
  assert.equal(allowedFrom("extension-page", MSG.PICK_RESULT, MSG), false);
  assert.equal(allowedFrom("extension-page", MSG.PICK_CANCELLED, MSG), false);
});

test("allowedFrom: unknown senders get nothing", () => {
  for (const t of [MSG.PICK_RESULT, MSG.PICK_CANCELLED, MSG.STOP, MSG.GET_STATE, MSG.PREVIEW_VOICE]) {
    assert.equal(allowedFrom("unknown", t, MSG), false, t);
  }
  assert.equal(allowedFrom("bogus", MSG.STOP, MSG), false);
});

test("capPickResult keeps only id/index/text and truncates text", () => {
  const long = "x".repeat(PICK_MAX_TEXT + 50);
  const out = capPickResult({
    sessionId: "s1",
    title: "T",
    chunks: [{ id: "c0", index: 0, text: "hello", evil: 1 }, { id: "c1", index: 1, text: long }],
  });
  assert.equal(out.sessionId, "s1");
  assert.equal(out.title, "T");
  assert.deepEqual(out.chunks[0], { id: "c0", index: 0, text: "hello" });
  assert.equal(out.chunks[1].text.length, PICK_MAX_TEXT);
  assert.equal(PICK_MAX_TEXT, 800);
});

test("capPickResult rejects the wrong shape", () => {
  assert.equal(capPickResult(null), null);
  assert.equal(capPickResult({}), null);
  assert.equal(capPickResult({ chunks: "nope" }), null);
  assert.equal(capPickResult({ chunks: [{ id: "c0", text: 5 }] }), null);
  assert.equal(capPickResult({ chunks: [null] }), null);
  assert.equal(capPickResult({ chunks: new Array(PICK_MAX_CHUNKS + 1).fill({ id: "c", index: 0, text: "a" }) }), null);
});

test("capPickResult accepts exactly the cap and an empty list (caller reports 'no text')", () => {
  assert.equal(PICK_MAX_CHUNKS, 2000);
  const full = capPickResult({ chunks: new Array(PICK_MAX_CHUNKS).fill({ id: "c", index: 0, text: "a" }) });
  assert.equal(full.chunks.length, PICK_MAX_CHUNKS);
  assert.deepEqual(capPickResult({ chunks: [] }).chunks, []);
});

test("capPickResult coerces sessionId/title to bounded strings", () => {
  const out = capPickResult({ sessionId: { x: 1 }, title: "t".repeat(5000), chunks: [] });
  assert.equal(typeof out.sessionId, "string");
  assert.ok(out.title.length <= 300);
});
