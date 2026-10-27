// lib/voice-label.js — turn a provider's voice record into the picker label the user sees.
// Pure, DOM-free, shared by all providers so the options page shows voices the same way:
//   "Alice — British, Female · Middle aged, Professional"
// The region comes from the voice's language (never from tags: OpenVox tags bf_alice "American"
// while its language says "British English", and the language field is the one that is right).

const REGION_BY_LANG_CODE = Object.freeze({
  "en-us": "US",
  "en-gb": "British",
  "en-au": "Australian",
  "en-in": "Indian",
});

const REGION_WORDS = new Set(["american", "british", "us", "uk", "australian", "indian"]);

/**
 * Human region from a BCP-47-ish code ("en-gb") or a provider's language name
 * ("British English", "English (US)", "US English"). Unknown → "".
 */
export function regionFromLanguage(language) {
  if (typeof language !== "string" || !language.trim()) return "";
  const s = language.trim();
  const byCode = REGION_BY_LANG_CODE[s.toLowerCase()];
  if (byCode) return byCode;
  // "English (US)" / "English (GB)"
  const paren = s.match(/\(([A-Za-z]{2,3})\)\s*$/);
  if (paren) {
    const code = paren[1].toUpperCase();
    if (code === "US") return "US";
    if (code === "GB" || code === "UK") return "British";
    return code;
  }
  // "British English" / "US English" / "American English"
  const lead = s.match(/^(\w+)\s+English$/i);
  if (lead) {
    const w = lead[1].toLowerCase();
    if (w === "us" || w === "american") return "US";
    if (w === "british" || w === "uk") return "British";
    return lead[1];
  }
  return "";
}

/** Tags with the region words removed (the region is shown once, from the language). */
export function descriptiveTags(tags) {
  if (!Array.isArray(tags)) return [];
  return tags.filter((t) => typeof t === "string" && t.trim() && !REGION_WORDS.has(t.trim().toLowerCase()));
}

/**
 * @param {{ name: string, gender?: string, region?: string, tags?: string[] }} v
 * @returns {string} e.g. "Alice — British, Female · Middle aged, Professional"
 */
export function voiceLabel(v) {
  const facts = [v.region, v.gender].filter((x) => typeof x === "string" && x.trim());
  const extra = descriptiveTags(v.tags);
  let label = v.name || v.id || "";
  if (facts.length) label += ` — ${facts.join(", ")}`;
  if (extra.length) label += ` · ${extra.join(", ")}`;
  return label;
}
