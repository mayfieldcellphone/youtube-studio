import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { isConversation, planDialogueGroups, segmentsFrom, speakDialogue, MAX_DIALOGUE_CHARS } from "../dialogue";
import { resetModelMemory } from "../media";
import { audioDuration, applyFx, measureLoudness, runFfmpeg } from "../audioPost";
import { characterPreset, interruptionOverlap } from "../voicePresets";
import { DEFAULT_PRESETS, resolvePresets } from "../voicePresets";
import { fakeAlignment, tmpDir } from "./helpers";

const realFetch = globalThis.fetch;
let calls: { url: string; body: any }[] = [];
let sixSeconds = "";
// Three speakers, a second apart with short gaps: 0.3-1.9, 2.1-3.7, 3.9-5.6
const SEGMENTS = [
  { voice_id: "a", start_time_seconds: 0.3, end_time_seconds: 1.9, dialogue_input_index: 0 },
  { voice_id: "b", start_time_seconds: 2.1, end_time_seconds: 3.7, dialogue_input_index: 1 },
  { voice_id: "c", start_time_seconds: 3.9, end_time_seconds: 5.6, dialogue_input_index: 2 },
];

function mock(dialogue: (call: { url: string; body: any }) => Response | undefined) {
  calls = [];
  globalThis.fetch = (async (url: any, init: any) => {
    const call = { url: String(url), body: JSON.parse(init.body) };
    calls.push(call);
    const custom = dialogue(call);
    if (custom) return custom;
    if (call.url.includes("text-to-dialogue")) {
      return new Response(JSON.stringify({ audio_base64: sixSeconds, voice_segments: SEGMENTS }), { status: 200 });
    }
    // per-line TTS
    return new Response(JSON.stringify({ audio_base64: sixSeconds, alignment: fakeAlignment(call.body.text, 0.3, 1.5) }), { status: 200 });
  }) as typeof fetch;
}

beforeEach(async () => {
  resetModelMemory();
  if (!sixSeconds) {
    const f = path.join(tmpDir("six"), "six.wav");
    await runFfmpeg(["-f", "lavfi", "-i", "sine=f=200:d=6:r=44100,volume=0.2", "-ac", "1", f]);
    sixSeconds = fs.readFileSync(f).toString("base64");
  }
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const LINES = [
  { voiceId: "a", text: "[tired] I can still feel the blow." },
  { voiceId: "b", text: "[tender] Rest, Harry." },
  { voiceId: "c", text: "[firm] The doctor says no visitors." },
];

test("groups respect the 10-voice and character limits", () => {
  const many = Array.from({ length: 12 }, (_, i) => ({ voiceId: `v${i}`, text: "Hello there." }));
  const g = planDialogueGroups(many);
  assert.deepEqual(g.map((x) => x.length), [10, 2]);
  const long = [0, 1, 2].map((i) => ({ voiceId: i % 2 ? "a" : "b", text: "x".repeat(MAX_DIALOGUE_CHARS / 2 + 100) }));
  assert.deepEqual(planDialogueGroups(long).map((x) => x.length), [1, 1, 1]);
});

test("a single speaker is not a conversation", () => {
  const lines = [{ voiceId: "a", text: "one" }, { voiceId: "a", text: "two" }];
  assert.equal(isConversation(lines, [0, 1]), false);
  assert.equal(isConversation(LINES, [0, 1, 2]), true);
});

test("segmentsFrom ignores malformed segments and merges repeats", () => {
  const segs = segmentsFrom(
    { voice_segments: [{ dialogue_input_index: 0, start_time_seconds: 0, end_time_seconds: 1 }, { dialogue_input_index: 0, start_time_seconds: 1, end_time_seconds: 2 }, { dialogue_input_index: 9, start_time_seconds: 0, end_time_seconds: 1 }, { dialogue_input_index: 1, start_time_seconds: 3, end_time_seconds: 3 }] },
    2,
  );
  assert.deepEqual(segs, [{ index: 0, start: 0, end: 2 }]);
});

test("speakDialogue sends one request with all voices and cuts one clip per line", async () => {
  mock(() => undefined);
  const dir = tmpDir("d1");
  const clips = await speakDialogue(LINES, path.join(dir, "s"));
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /text-to-dialogue\/with-timestamps/);
  assert.deepEqual(calls[0].body.inputs.map((i: any) => i.voice_id), ["a", "b", "c"]);
  assert.equal(calls[0].body.model_id, "eleven_v3");
  assert.equal(clips.length, 3);
  // Lengths match the segment lengths plus the small breath either side.
  const expected = [1.6, 1.6, 1.7];
  for (const [k, c] of clips.entries()) {
    const d = await audioDuration(c.file);
    assert.ok(Math.abs(d - (expected[k] + 0.13)) < 0.08, `clip ${k}: ${d}`);
  }
  console.log("  dialogue clip lengths:", (await Promise.all(clips.map((c) => audioDuration(c.file)))).map((d) => d.toFixed(2)).join(", "), "s");
});

test("speakDialogue throws when timings are missing, so callers can fall back", async () => {
  mock((c) => (c.url.includes("dialogue") ? new Response(JSON.stringify({ audio_base64: sixSeconds, voice_segments: [] }), { status: 200 }) : undefined));
  await assert.rejects(speakDialogue(LINES, path.join(tmpDir("d2"), "s")), /timings/);
});

test("interruption overlap: cut-off lines and 'interrupting' cues overlap, others don't", () => {
  const prev = { text: "I never meant to—", duration: 2 };
  assert.ok(interruptionOverlap(prev, "", 2) > 0);
  assert.ok(interruptionOverlap({ text: "Fine.", duration: 2 }, "interrupting, sharp", 2) > 0);
  assert.equal(interruptionOverlap({ text: "Fine.", duration: 2 }, "calm", 2), 0);
  assert.equal(interruptionOverlap(undefined, "interrupting", 2), 0);
  assert.ok(interruptionOverlap(prev, "", 0.3) <= 0.1); // never more than a third of a short line
  assert.ok(interruptionOverlap(prev, "", 5) <= 0.25);
});

test("character preset takes the character's own settings, clamped", () => {
  const p = characterPreset({ stability: 0.9, style: 5, speed: 0.1 });
  assert.equal(p.stability, 0.9);
  assert.equal(p.style, 1);
  assert.equal(p.speed, 0.7);
  assert.equal(characterPreset().tempo, 1);
});

test("radio FX removes the high end and keeps the clip usable", async () => {
  const dir = tmpDir("fx");
  const hi = path.join(dir, "hi.wav");
  await runFfmpeg(["-f", "lavfi", "-i", "sine=f=7000:d=1:r=44100,volume=0.3", "-ac", "1", hi]);
  const radio = path.join(dir, "radio.wav");
  const none = path.join(dir, "none.wav");
  await applyFx(hi, radio, "radio");
  await applyFx(hi, none, "none");
  const a = await measureLoudness(none);
  const b = await measureLoudness(radio);
  assert.ok(b.input_i < a.input_i - 12, `radio ${b.input_i} vs none ${a.input_i}`);
  const hall = await applyFx(hi, path.join(dir, "hall.wav"), "hall");
  assert.ok(hall > 1.3, "hall FX leaves room for the reverb tail");
});

// ---- synthesizeScenes: a 40 s style three-speaker scene ----

test("synthesizeScenes speaks consecutive characters as one dialogue and falls back per line on failure", async () => {
  const { synthesizeScenes } = await import("../voices");
  const narration = { format: "long" as const, presets: resolvePresets(undefined as never), keyMoments: [] };
  const texts = ["The nurse lowered her voice.", "I can still feel the blow.", "Rest, Harry.", "The doctor says no visitors."];
  const chars = [undefined, { voiceId: "a", delivery: "tired" }, { voiceId: "b", delivery: "tender", fx: "close" as const }, { voiceId: "c", delivery: "firm", fx: "radio" as const }];
  const voice = { engine: "elevenlabs" as const, voiceId: "narr" };

  mock((c) => {
    if (c.url.includes("text-to-dialogue")) return new Response(JSON.stringify({ audio_base64: sixSeconds, voice_segments: SEGMENTS }), { status: 200 });
    return undefined;
  });
  let out = await synthesizeScenes(texts, voice, path.join(tmpDir("s1"), "v"), () => undefined, chars, narration);
  assert.equal(calls.filter((c) => c.url.includes("dialogue")).length, 1);
  assert.equal(calls.filter((c) => c.url.includes("text-to-speech")).length >= 1, true, "narrator line uses normal TTS");
  assert.equal(out.length, 4);
  for (const o of out) assert.ok(o.duration > 0.5 && o.words.length > 0);

  // Dialogue mode refused: the same lines are spoken one at a time.
  mock((c) => (c.url.includes("text-to-dialogue") ? new Response(JSON.stringify({ detail: "nope" }), { status: 422 }) : undefined));
  out = await synthesizeScenes(texts, voice, path.join(tmpDir("s2"), "v"), () => undefined, chars, narration);
  assert.equal(out.length, 4);
  assert.equal(calls.filter((c) => c.url.includes("text-to-speech")).length >= 4, true);
  // Character calls carry the audio tag for v4/v3 models.
  assert.ok(calls.some((c) => c.body.text?.startsWith("[tender]")));
});

test("a cut-in line overlaps the one before it", async () => {
  const { synthesizeScenes } = await import("../voices");
  const narration = { format: "long" as const, presets: DEFAULT_PRESETS, keyMoments: [] };
  mock(() => undefined);
  const out = await synthesizeScenes(
    ["I never meant to—", "You never do."],
    { engine: "elevenlabs", voiceId: "narr" },
    path.join(tmpDir("s3"), "v"),
    () => undefined,
    [{ voiceId: "a" }, { voiceId: "a", delivery: "interrupting" }],
    narration,
  );
  assert.ok((out[1].overlap ?? 0) > 0);
  assert.equal(out[0].gapAfter, 0);
});

test("captions of a cut-in line start before its slot and the line before clears first", async () => {
  const { buildCaptions } = await import("../render");
  const w = (start: number, end: number) => [{ text: "hello", start, end }];
  const ass = buildCaptions(
    [{ words: w(0.1, 1.8), duration: 2 }, { words: w(0.2, 1), duration: 2, overlap: 0.25 }],
    false, 1920, 1080,
  );
  const times = [...ass.matchAll(/Dialogue: 0,(\d+):(\d+):([\d.]+),(\d+):(\d+):([\d.]+)/g)].map((m) => [Number(m[3]), Number(m[6])]);
  assert.equal(times.length, 2);
  // First line ends no later than where the second starts (2.0 - 0.25 + 0.2 = 1.95)
  assert.ok(times[0][1] <= times[1][0] + 0.01, JSON.stringify(times));
  assert.ok(Math.abs(times[1][0] - 1.95) < 0.02, JSON.stringify(times));
});
