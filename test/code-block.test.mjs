// test/code-block.test.mjs — unit tests for the DOM-free code-block announcer.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
await import(path.join(here, "../lib/code-block.js"));
const { describeCodeBlock, languageFromClass, countCodeLines } = globalThis.OpenVoxCodeBlock;

test("countCodeLines ignores blank lines and trailing newline", () => {
  assert.equal(countCodeLines("a\n\nb\nc\n"), 3);
  assert.equal(countCodeLines("   \n\n"), 0);
  assert.equal(countCodeLines("single"), 1);
});

test("languageFromClass recognises common highlighter conventions", () => {
  assert.equal(languageFromClass("language-python"), "Python");
  assert.equal(languageFromClass("highlight lang-ts"), "TypeScript");
  assert.equal(languageFromClass("hljs javascript"), "JavaScript");
  assert.equal(languageFromClass("brush: bash; gutter: false"), "Bash");
  assert.equal(languageFromClass("codehilite"), null);
  assert.equal(languageFromClass("col c r"), null, "bare single letters are not languages");
  assert.equal(languageFromClass("language-c"), "C");
  assert.equal(languageFromClass(""), null);
  assert.equal(languageFromClass(undefined), null);
});

test("describeCodeBlock produces a short spoken label", () => {
  assert.equal(describeCodeBlock("x = 1\ny = 2\n", "language-python"), "Python code block, 2 lines.");
  assert.equal(describeCodeBlock("ls", ""), "Code block, 1 line.");
  assert.equal(describeCodeBlock("", ""), "Empty code block.");
});

test("describeCodeBlock never speaks an unknown language token verbatim", () => {
  // Unknown tokens come from arbitrary site CSS; we must not read "language-xyzzyfoo" aloud.
  assert.equal(describeCodeBlock("a\nb", "language-xyzzyfoo"), "Code block, 2 lines.");
});
