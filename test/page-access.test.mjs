import test from "node:test";
import assert from "node:assert/strict";
import { unreadablePageReason } from "../lib/page-access.js";

test("ordinary web pages and local files are readable", () => {
  for (const u of ["https://isoglow.dev/?via=dailydev", "http://127.0.0.1:8765/", "file:///Users/x/notes.html"]) {
    assert.equal(unreadablePageReason(u), null, u);
  }
});

test("a replaced new-tab page (another extension) says so and suggests its own tab", () => {
  const msg = unreadablePageReason("chrome-extension://jlmpjdjjbgclbocgajdjefcidcncaied/newtab.html");
  assert.match(msg, /another extension/);
  assert.match(msg, /new-tab/);
  assert.match(msg, /its own tab/);
});

test("the browser's own new-tab page is named as such", () => {
  for (const u of ["chrome://newtab/", "brave://newtab/", "edge://newtab/", "about:newtab", "chrome-search://local-ntp/local-ntp.html"]) {
    assert.match(unreadablePageReason(u), /new-tab page/, u);
  }
});

test("the web store is refused even though it is https", () => {
  assert.match(unreadablePageReason("https://chromewebstore.google.com/detail/abc"), /extension store/);
  assert.match(unreadablePageReason("https://chrome.google.com/webstore/category/extensions"), /extension store/);
  assert.equal(unreadablePageReason("https://chromewebstore.google.com.evil.example/"), null);
});

test("other browser pages get the browser-page message", () => {
  for (const u of ["chrome://settings/", "brave://extensions/", "about:blank", "view-source:https://x.dev/"]) {
    assert.match(unreadablePageReason(u), /Browser pages/, u);
  }
});

test("a missing URL and unknown schemes still get a reason", () => {
  assert.match(unreadablePageReason(undefined), /its own tab/);
  assert.match(unreadablePageReason(""), /its own tab/);
  assert.match(unreadablePageReason("data:text/html,hi"), /http and https/);
});
