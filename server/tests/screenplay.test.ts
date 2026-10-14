import test from "node:test";
import assert from "node:assert/strict";
import { anchorCues, dialogueShare, parsePause, parseScreenplay, parseScreenplayLine, prepareScript, screenplaySpeakers } from "../screenplay";

test("parses bracketed speaker lines with emotion", () => {
  const e = parseScreenplayLine("[HOUDINI | tired, whispering] I can still feel the blow.");
  assert.deepEqual(e, { kind: "speech", speaker: "HOUDINI", emotion: "tired, whispering", text: "I can still feel the blow.", dramatized: true, source: undefined });
});

test("speaker without emotion, and narrator is never dramatized", () => {
  const bess = parseScreenplayLine("[BESS] Rest, Harry.");
  assert.equal(bess?.kind === "speech" && bess.emotion, "");
  const n = parseScreenplayLine("[NARRATOR] In 1926 he walked into a hospital.");
  assert.equal(n?.kind === "speech" && n.speaker, "NARRATOR");
  assert.equal(n?.kind === "speech" && n.dramatized, false);
});

test("narrator ignores emotion tags", () => {
  const n = parseScreenplayLine("[NARRATOR | grave] It ended there.");
  assert.equal(n?.kind === "speech" && n.emotion, "");
});

test("legacy NAME: [cue] format still works", () => {
  const e = parseScreenplayLine("JOAN OF ARC: [firm] I deny it entirely.");
  assert.equal(e?.kind === "speech" && e.speaker, "JOAN OF ARC");
  assert.equal(e?.kind === "speech" && e.emotion, "firm");
  assert.equal(e?.kind === "speech" && e.text, "I deny it entirely.");
});

test("sfx, music and pause directives", () => {
  assert.deepEqual(parseScreenplayLine("[SFX: train whistle]"), { kind: "sfx", text: "train whistle" });
  assert.deepEqual(parseScreenplayLine("[MUSIC: low strings, tense]"), { kind: "music", text: "low strings, tense" });
  assert.deepEqual(parseScreenplayLine("[PAUSE: 600ms]"), { kind: "pause", ms: 600 });
  assert.deepEqual(parseScreenplayLine("[PAUSE: 1.2s]"), { kind: "pause", ms: 1200 });
  assert.equal(parseScreenplayLine("[PAUSE: soon]"), null);
});

test("pause is capped", () => {
  assert.equal(parsePause("60s"), 5000);
  assert.equal(parsePause("250"), 250);
});

test("a bracket line with no text is a visual direction, not a speaker", () => {
  assert.deepEqual(parseScreenplayLine("[WIDE SHOT]"), { kind: "direction", text: "WIDE SHOT" });
  assert.deepEqual(parseScreenplayLine("[slow push-in on the tent]"), { kind: "direction", text: "slow push-in on the tent" });
  assert.deepEqual(parseScreenplayLine("[NARRATOR]"), { kind: "direction", text: "NARRATOR" });
});

test("SOURCE tag marks a line as sourced, not dramatized", () => {
  const e = parseScreenplayLine("[HOUDINI | firm] [SOURCE: letter, 1924] The lock holds no fear for me.");
  assert.equal(e?.kind === "speech" && e.dramatized, false);
  assert.equal(e?.kind === "speech" && e.source, "letter, 1924");
  assert.equal(e?.kind === "speech" && e.text, "The lock holds no fear for me.");
});

test("a leading [DRAMATIZED] flag is stripped from the spoken text", () => {
  const e = parseScreenplayLine("[DRAMATIZED] [BESS | tender] Come home.");
  assert.equal(e?.kind === "speech" && e.speaker, "BESS");
  assert.equal(e?.kind === "speech" && e.text, "Come home.");
  assert.equal(e?.kind === "speech" && e.dramatized, true);
});

test("plain lines are narration; ordinary prose with a colon stays narration", () => {
  const e = parseScreenplayLine("In 1431: the court sat for weeks.");
  assert.equal(e?.kind === "speech" && e.speaker, "NARRATOR");
});

test("speakers, dialogue share", () => {
  const script = "[NARRATOR] One two three four five six.\n[A | x] seven eight.\n[B] nine ten.";
  assert.deepEqual(screenplaySpeakers(script), ["A", "B"]);
  assert.equal(dialogueShare(parseScreenplay(script)), 0.4);
});

test("prepareScript normalises to the planner format and anchors cues", () => {
  const script = [
    "[MUSIC: low strings]",
    "[NARRATOR] The train rolled into Montreal at dawn.",
    "[SFX: train whistle]",
    "[PAUSE: 400ms]",
    "[HOUDINI | tired] I can still feel the blow.",
    "[wide shot of the station]",
    "[BESS] Rest, Harry.",
    "[SFX: door closing]",
  ].join("\n");
  const p = prepareScript(script);
  assert.equal(p.spoken, "The train rolled into Montreal at dawn.\nHOUDINI: [tired] I can still feel the blow.\n[wide shot of the station]\nBESS: Rest, Harry.");
  assert.deepEqual(p.speakers, ["HOUDINI", "BESS"]);
  assert.equal(p.dramatizedLines, 2);
  assert.deepEqual(p.cues.map((c) => [c.kind, c.before]), [
    ["music", "The train rolled into Montreal at"],
    ["sfx", "I can still feel the blow."],
    ["pause", "I can still feel the blow."],
    ["sfx", ""],
  ]);
  const scenes = ["The train rolled into Montreal at dawn.", "I can still feel the blow.", "Rest, Harry."];
  assert.deepEqual(anchorCues(p.cues, scenes), [0, 1, 1, 2]);
});
