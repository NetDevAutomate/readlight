// lib/chunker.js — pure, DOM-free sentence chunking.
// Shared by the content script (loaded as a classic content-script file, before
// content_script.js) and by the Node tests (loaded via dynamic import()).
// Attaches to globalThis so both the content-script isolated world and Node can reach it.
(function (root) {
  // Split text into contiguous sentence spans [{start,end}] (covers the whole string).
  function splitSentences(text, lang) {
    const spans = [];
    if (typeof Intl !== "undefined" && Intl.Segmenter) {
      const seg = new Intl.Segmenter(lang || "en", { granularity: "sentence" });
      for (const s of seg.segment(text)) {
        spans.push({ start: s.index, end: s.index + s.segment.length });
      }
    } else {
      const re = /[^.!?\n]*[.!?\n]+|\s*\S[^.!?\n]*$/g;
      let m;
      while ((m = re.exec(text)) !== null) {
        if (m[0].length === 0) {
          re.lastIndex++;
          continue;
        }
        spans.push({ start: m.index, end: m.index + m[0].length });
      }
    }
    if (!spans.length) spans.push({ start: 0, end: text.length });
    return spans;
  }

  // Chunk sizes come from user settings (storage), so they are untrusted: coerce to integers,
  // target in [40, 2000], max in [target, 4000]. A non-positive or NaN max previously made the
  // hard-split loop below spin forever (the cut never advanced past `start`).
  const DEFAULT_TARGET = 180;
  const DEFAULT_MAX = 260;
  function toInt(x) {
    const n = typeof x === "string" ? parseFloat(x) : x;
    return typeof n === "number" && Number.isFinite(n) ? Math.trunc(n) : NaN;
  }
  function clampChunkSizes(target, max) {
    const t = toInt(target);
    const m = toInt(max);
    const tgt = Number.isNaN(t) ? DEFAULT_TARGET : Math.min(2000, Math.max(40, t));
    const mx = Math.min(4000, Math.max(tgt, Number.isNaN(m) ? DEFAULT_MAX : m));
    return { target: tgt, max: mx };
  }

  // Merge short sentences up to `target` chars; hard-split anything longer than `max`
  // at the nearest preceding space. Returns final chunk spans [{start,end}].
  function mergeAndSplit(spans, text, target, max) {
    ({ target, max } = clampChunkSizes(target, max));
    const merged = [];
    let cur = null;
    for (const s of spans) {
      const isWs = !text.slice(s.start, s.end).trim();
      if (isWs) {
        if (cur) cur.end = s.end; // glue trailing whitespace onto current chunk
        continue;
      }
      if (!cur) cur = { start: s.start, end: s.end };
      else if (s.end - cur.start <= target) cur.end = s.end;
      else {
        merged.push(cur);
        cur = { start: s.start, end: s.end };
      }
    }
    if (cur) merged.push(cur);

    const out = [];
    for (const seg of merged) {
      if (seg.end - seg.start <= max) {
        out.push(seg);
        continue;
      }
      let start = seg.start;
      while (seg.end - start > max) {
        let cut = start + max;
        // L5: broader break-char set for NBSP-heavy content
        let w = -1;
        for (let k = cut; k > start; k--) {
          if (text[k] === " " || text[k] === "\n" || text[k] === "\t" || text[k] === " ") { w = k; break; }
        }
        if (w > start) cut = w;
        out.push({ start, end: cut });
        start = cut;
      }
      if (start < seg.end) out.push({ start, end: seg.end });
    }
    return out;
  }

  // Convenience: text -> array of trimmed chunk strings (used by tests).
  function chunkText(text, { lang = "en", target = 180, max = 260 } = {}) {
    const spans = mergeAndSplit(splitSentences(text, lang), text, target, max);
    return spans.map((s) => text.slice(s.start, s.end).trim()).filter(Boolean);
  }

  root.OpenVoxChunker = { splitSentences, mergeAndSplit, chunkText, clampChunkSizes };
})(typeof globalThis !== "undefined" ? globalThis : this);
