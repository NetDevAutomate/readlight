// lib/kokoro-voices.js — the voice table for the built-in Kokoro provider. Static on purpose:
// the options page needs the list without loading the 5 MB model bundle, and kokoro-js does not
// export its voice table. Source: kokoro-js 1.2.1 `VOICES` (onnx-community/Kokoro-82M-v1.0-ONNX).
// DOM-free.

export const KOKORO_BUILTIN_LANGUAGES = Object.freeze([
  { code: "en-us", name: "English (US)" },
  { code: "en-gb", name: "English (UK)" },
]);

// id prefix: a = American, b = British; f = female, m = male.
const V = (id, name, language, gender) => Object.freeze({ id, name, language, gender });
export const KOKORO_BUILTIN_VOICES = Object.freeze([
  V("af_heart", "Heart", "en-us", "Female"),
  V("af_bella", "Bella", "en-us", "Female"),
  V("af_alloy", "Alloy", "en-us", "Female"),
  V("af_aoede", "Aoede", "en-us", "Female"),
  V("af_jessica", "Jessica", "en-us", "Female"),
  V("af_kore", "Kore", "en-us", "Female"),
  V("af_nicole", "Nicole", "en-us", "Female"),
  V("af_nova", "Nova", "en-us", "Female"),
  V("af_river", "River", "en-us", "Female"),
  V("af_sarah", "Sarah", "en-us", "Female"),
  V("af_sky", "Sky", "en-us", "Female"),
  V("am_adam", "Adam", "en-us", "Male"),
  V("am_echo", "Echo", "en-us", "Male"),
  V("am_eric", "Eric", "en-us", "Male"),
  V("am_fenrir", "Fenrir", "en-us", "Male"),
  V("am_liam", "Liam", "en-us", "Male"),
  V("am_michael", "Michael", "en-us", "Male"),
  V("am_onyx", "Onyx", "en-us", "Male"),
  V("am_puck", "Puck", "en-us", "Male"),
  V("am_santa", "Santa", "en-us", "Male"),
  V("bf_alice", "Alice", "en-gb", "Female"),
  V("bf_emma", "Emma", "en-gb", "Female"),
  V("bf_isabella", "Isabella", "en-gb", "Female"),
  V("bf_lily", "Lily", "en-gb", "Female"),
  V("bm_daniel", "Daniel", "en-gb", "Male"),
  V("bm_fable", "Fable", "en-gb", "Male"),
  V("bm_george", "George", "en-gb", "Male"),
  V("bm_lewis", "Lewis", "en-gb", "Male"),
]);

export const KOKORO_BUILTIN_DEFAULT_VOICE = "af_heart";
export const KOKORO_BUILTIN_DEFAULT_LANGUAGE = "en-us";

/** Voices for one language code; an unknown/empty code returns every voice. */
export function listBuiltinVoices(language) {
  const known = KOKORO_BUILTIN_LANGUAGES.some((l) => l.code === language);
  return known ? KOKORO_BUILTIN_VOICES.filter((v) => v.language === language) : [...KOKORO_BUILTIN_VOICES];
}

/** True for a known voice id. kokoro-js has no blend formulas (unlike Kokoro Web). */
export function isValidBuiltinVoice(voice) {
  return KOKORO_BUILTIN_VOICES.some((v) => v.id === voice);
}
