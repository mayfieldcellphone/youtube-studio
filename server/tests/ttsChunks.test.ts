import { test } from "node:test";
import assert from "node:assert/strict";
import { CONTEXT_CHARS, MAX_CHUNK_CHARS, MIN_CHUNK_CHARS, chunkForSpeech, contextFor, splitSentences } from "../ttsChunks";

test("splits plain sentences", () => {
  assert.deepEqual(splitSentences("It was cold. The river froze! Who saw it? Nobody."), ["It was cold.", "The river froze!", "Who saw it?", "Nobody."]);
});

test("does not split on abbreviations, initials, decimals or lowercase continuations", () => {
  assert.deepEqual(splitSentences("Mr. Houdini met Dr. Watson in St. Louis. They talked."), ["Mr. Houdini met Dr. Watson in St. Louis.", "They talked."]);
  assert.deepEqual(splitSentences("H. P. Lovecraft wrote it. Then he stopped."), ["H. P. Lovecraft wrote it.", "Then he stopped."]);
  assert.deepEqual(splitSentences("The U.S. army arrived at 3.5 miles out. Then silence."), ["The U.S. army arrived at 3.5 miles out.", "Then silence."]);
  assert.deepEqual(splitSentences("He waited... and then he ran."), ["He waited... and then he ran."]);
});

test("keeps quotes with their sentence and audio tags with what they introduce", () => {
  assert.deepEqual(splitSentences('She said, "Run." He did. [whispering] Nobody heard.'), ['She said, "Run."', "He did.", "[whispering] Nobody heard."]);
});

test("short pieces join a neighbour; a short last piece joins the one before", () => {
  const chunks = chunkForSpeech("No. The expedition never returned from the northern ridge that winter. Gone.");
  assert.ok(chunks.every((c) => c.length >= MIN_CHUNK_CHARS), JSON.stringify(chunks));
  assert.equal(chunks.join(" "), "No. The expedition never returned from the northern ridge that winter. Gone.");
});

test("overlong sentences are cut at a comma or dash, never mid-word", () => {
  const long =
    "The investigators searched the tent, the ridge, the frozen forest below, the ravine where the last four were found, and every rumour that reached them over the long months that followed, without ever settling on a single explanation that satisfied the grieving families, the newspapers, or the officials who wanted the file closed before the next winter arrived.";
  assert.ok(long.length > MAX_CHUNK_CHARS, `test sentence must exceed the limit, is ${long.length}`);
  const chunks = chunkForSpeech(long);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((c) => c.length <= MAX_CHUNK_CHARS), JSON.stringify(chunks.map((c) => c.length)));
  assert.equal(chunks.join(" ").replace(/\s+/g, " "), long);
});

test("empty text gives no chunks", () => {
  assert.deepEqual(chunkForSpeech("   "), []);
});

test("context carries across chunks and into neighbouring scenes, without audio tags", () => {
  const chunks = ["First sentence here for the scene.", "[whispering] Second sentence follows right after.", "Third one closes the scene out."];
  const mid = contextFor(chunks, 1, "Earlier scene ends here.", "Later scene begins here.");
  assert.ok(mid.previousText?.includes("Earlier scene ends here."));
  assert.ok(mid.previousText?.includes("First sentence"));
  assert.ok(mid.nextText?.includes("Third one"));
  assert.ok(mid.nextText?.includes("Later scene begins here."));
  assert.ok(!/\[/.test(mid.previousText ?? "") && !/\[/.test(mid.nextText ?? ""));

  const first = contextFor(chunks, 0);
  assert.equal(first.previousText, undefined);
  const last = contextFor(chunks, 2);
  assert.equal(last.nextText, undefined);
  assert.equal(contextFor(chunks, 2, "", "After.").nextText, "After.");
});

test("context is capped and starts and ends on whole words", () => {
  const words = Array.from({ length: 200 }, (_, i) => `word${i}`);
  const ctx = contextFor([words.slice(0, 100).join(" "), words.slice(100).join(" ")], 1);
  assert.ok(ctx.previousText!.length <= CONTEXT_CHARS);
  assert.ok(/^word\d+/.test(ctx.previousText!), String(ctx.previousText));
  const ctx2 = contextFor([words.slice(0, 100).join(" "), words.slice(100).join(" ")], 0);
  assert.ok(ctx2.nextText!.length <= CONTEXT_CHARS);
  assert.ok(/word\d+$/.test(ctx2.nextText!), String(ctx2.nextText));
});
