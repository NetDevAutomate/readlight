// lib/page-access.js — pure: can the extension read this tab's URL, and if not, why (in plain words)?
// Chrome lets no extension inject into browser pages, other extensions' pages (which is what a
// replaced new-tab page is) or the web store. The popup used to give one message for all of them,
// which read as wrong when the page was, say, a news feed rendered inside a new-tab extension.

const BROWSER_SCHEMES = /^(chrome|brave|edge|opera|vivaldi|about|view-source|devtools|chrome-search|chrome-untrusted):/i;
const EXTENSION_SCHEMES = /^(chrome-extension|moz-extension|extension):/i;
const NEW_TAB = /^(chrome|brave|edge|opera|vivaldi|about|chrome-search):\/*(newtab|new-tab-page|local-ntp|startpage|home)\b/i;
const WEB_STORE = /^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore|microsoftedge\.microsoft\.com\/addons)(\/|$)/i;

export const OPEN_IN_OWN_TAB = "Open the article in its own tab (for example via its title or “Read post”) and try again.";

/**
 * @param {string|undefined} url the active tab's URL
 * @returns {null|string} null when the page can be read, otherwise the message to show
 */
export function unreadablePageReason(url) {
  const u = typeof url === "string" ? url.trim() : "";
  if (/^(https?|file):/i.test(u) && !WEB_STORE.test(u)) return null;
  if (!u) {
    return "Can't read this tab: the browser doesn't let extensions see what it is. " + OPEN_IN_OWN_TAB;
  }
  if (WEB_STORE.test(u)) return "Browsers don't let extensions read the extension store.";
  if (NEW_TAB.test(u)) {
    return "This is the browser's new-tab page, which extensions can't read. " + OPEN_IN_OWN_TAB;
  }
  if (EXTENSION_SCHEMES.test(u)) {
    return (
      "This page belongs to another extension (a replaced new-tab page, for example), and extensions " +
      "can't read each other's pages. " + OPEN_IN_OWN_TAB
    );
  }
  if (BROWSER_SCHEMES.test(u)) return "Browser pages (settings, history, extensions) can't be read by extensions.";
  return "Can't read this page type. OpenVox reads web pages (http and https) and local files.";
}
