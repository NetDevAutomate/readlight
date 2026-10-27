// test/chunker.test.mjs — unit tests for the pure, DOM-free chunking logic.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

// lib/chunker.js is a classic IIFE that attaches OpenVoxChunker to globalThis.
const here = path.dirname(fileURLToPath(import.meta.url));
await import(path.join(here, "../lib/chunker.js"));
const { splitSentences, chunkText } = globalThis.OpenVoxChunker;

test("splitSentences covers the whole string with ≥2 spans", () => {
  const t = "Hello world. How are you?";
  const spans = splitSentences(t, "en");
  assert.ok(spans.length >= 2, `expected ≥2, got ${spans.length}`);
  assert.equal(spans[0].start, 0);
  assert.equal(spans[spans.length - 1].end, t.length);
});

test("merges very short sentences up to target", () => {
  const chunks = chunkText("A. B. C. D.", { target: 100, max: 200 });
  assert.equal(chunks.length, 1);
});

test("keeps sentences separate once target is exceeded", () => {
  const s =
    "This is a reasonably long sentence number one. This is another reasonably long sentence two.";
  const chunks = chunkText(s, { target: 40, max: 200 });
  assert.ok(chunks.length >= 2, `expected ≥2, got ${chunks.length}`);
});

test("hard-splits a runaway sentence and never exceeds max", () => {
  const t = "word ".repeat(100).trim() + "."; // ~500 chars, spaces, no sentence breaks
  const chunks = chunkText(t, { target: 180, max: 200 });
  assert.ok(chunks.length > 1, "should split into multiple chunks");
  for (const c of chunks) assert.ok(c.length <= 200, `chunk too long: ${c.length}`);
});

test("empty / whitespace-only input yields no chunks", () => {
  assert.deepEqual(chunkText("   \n  ", {}), []);
});

test("no text is lost (chunks rejoin to the normalized original)", () => {
  const t = "First sentence here. Second one follows! Third? Yes.";
  const chunks = chunkText(t, { target: 30, max: 200 });
  const joined = chunks.join(" ").replace(/\s+/g, " ").trim();
  const expect = t.replace(/\s+/g, " ").trim();
  assert.equal(joined, expect);
});

test("clampChunkSizes coerces to integers: target in [40, 2000], max in [target, 4000]", () => {
  const { clampChunkSizes } = globalThis.OpenVoxChunker;
  assert.deepEqual(clampChunkSizes(180, 260), { target: 180, max: 260 });
  assert.deepEqual(clampChunkSizes(-5, 0), { target: 40, max: 40 });
  assert.deepEqual(clampChunkSizes(NaN, NaN), { target: 180, max: 260 });
  assert.deepEqual(clampChunkSizes("300", "250"), { target: 300, max: 300 });
  assert.deepEqual(clampChunkSizes(99999, 99999), { target: 2000, max: 4000 });
  assert.deepEqual(clampChunkSizes(100.7, Infinity), { target: 100, max: 260 });
  assert.deepEqual(clampChunkSizes(undefined, null), { target: 180, max: 260 });
});

// A non-positive or NaN max used to spin forever (cut never advances). Run the hostile calls in a
// child process with a timeout so a regression fails this test instead of hanging the suite.
test("mergeAndSplit terminates for non-positive / NaN sizes", () => {
  const script = `
    require(${JSON.stringify(path.join(here, "../lib/chunker.js"))});
    const C = globalThis.OpenVoxChunker;
    const t = "a sentence. " + "word ".repeat(400);
    const out = [];
    for (const [tg, mx] of [[-5, 0], [0, -1], [NaN, NaN], [1, 1], ["x", undefined]]) {
      const spans = C.mergeAndSplit(C.splitSentences(t, "en"), t, tg, mx);
      if (!spans.length || spans.some((s) => s.end <= s.start)) throw new Error("bad spans " + tg + "/" + mx);
      out.push(spans.length);
    }
    process.stdout.write(JSON.stringify(out));
  `;
  const r = spawnSync(process.execPath, ["-e", script], { timeout: 5000, encoding: "utf8" });
  assert.equal(r.error?.code, undefined, "mergeAndSplit did not terminate");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).length, 5);
});
