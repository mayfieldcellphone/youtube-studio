import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { narrateWithEleven, wordsPerMinute, LEAD_IN } from "../narration";
import { resetModelMemory, ElevenError } from "../media";
import { DEFAULT_PRESETS, MAX_TEMPO, gapSeconds } from "../voicePresets";
import { audioDuration, runFfmpeg } from "../audioPost";
import { fakeAlignment, makeSpeechLike, tmpDir } from "./helpers";

interface Call {
  url: string;
  body: any;
}
type Handler = (call: Call, index: number) => { status?: number; json?: unknown } | undefined;

const realFetch = globalThis.fetch;
let calls: Call[] = [];
let toneBase64 = "";
const SPEECH_START = 0.35;
const SPEECH_END = 1.35;

/** A fake ElevenLabs: returns audio with silence either side of the speech, plus character timings. */
function mockEleven(handler: Handler = () => undefined) {
  calls = [];
  globalThis.fetch = (async (url: any, init: any) => {
    const call: Call = { url: String(url), body: JSON.parse(init.body) };
    const index = calls.push(call) - 1;
    const custom = handler(call, index);
    if (custom) return new Response(JSON.stringify(custom.json ?? {}), { status: custom.status ?? 200 });
    return new Response(
      JSON.stringify({ audio_base64: toneBase64, alignment: fakeAlignment(call.body.text, SPEECH_START, SPEECH_END) }),
      { status: 200 },
    );
  }) as typeof fetch;
}

beforeEach(async () => {
  resetModelMemory();
  if (!toneBase64) {
    const d = tmpDir("tone");
    const f = path.join(d, "tone.wav");
    await makeSpeechLike(f, { lead: SPEECH_START, body: SPEECH_END - SPEECH_START, tail: 0.5 });
    toneBase64 = fs.readFileSync(f).toString("base64");
  }
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const TWO_SENTENCES = "The tent was cut open from the inside. Nobody ever explained how the boots got there.";
const preset = { ...DEFAULT_PRESETS.documentary_narration, tempo: 1 };

const base = (dir: string, text = TWO_SENTENCES, extra: Record<string, unknown> = {}) => ({
  text, voiceId: "voice1", outBase: path.join(dir, "scene"), preset, models: ["eleven_v4", "eleven_v3", "eleven_multilingual_v2"], ...extra,
});

test("speaks sentence by sentence, with the neighbouring text as context and the preset's settings", async () => {
  mockEleven();
  const dir = tmpDir("n1");
  await narrateWithEleven(base(dir, TWO_SENTENCES, { before: "The last scene ended on the ridge.", after: "The next scene opens in Moscow." }));
  assert.equal(calls.length, 2, "one request per sentence");
  assert.match(calls[0].url, /\/v1\/text-to-speech\/voice1\/with-timestamps/);
  assert.equal(calls[0].body.model_id, "eleven_v4");
  assert.equal(calls[0].body.text, "The tent was cut open from the inside.");
  assert.match(calls[0].body.previous_text, /ridge/);
  assert.match(calls[0].body.next_text, /boots/);
  assert.match(calls[1].body.previous_text, /cut open/);
  assert.match(calls[1].body.next_text, /Moscow/);
  assert.equal(calls[0].body.voice_settings.speed, preset.speed);
  assert.equal(calls[0].body.voice_settings.stability, preset.stability);
  assert.equal(calls[0].body.voice_settings.style, preset.style);
});

test("trims the silence either side of each sentence and joins them with the seeded natural gap", async () => {
  mockEleven();
  const dir = tmpDir("n2");
  const r = await narrateWithEleven(base(dir, TWO_SENTENCES, { gapSeed: 5 }));
  // Each raw clip is ~1.85 s with 0.35 s of lead and 0.5 s of tail; the speech is 1.0 s plus breath and decay.
  const clip = SPEECH_END - SPEECH_START + LEAD_IN + 0.09;
  const gap = gapSeconds(preset, 5);
  assert.ok(gap >= 0.2 && gap <= 0.35);
  assert.ok(Math.abs(r.duration - (clip * 2 + gap)) < 0.05, `duration ${r.duration}, expected ${(clip * 2 + gap).toFixed(3)}`);
  assert.ok(Math.abs((await audioDuration(r.file)) - r.duration) < 0.02);
  // Nothing but the final wav is left behind.
  assert.deepEqual(fs.readdirSync(dir).filter((f) => !f.endsWith("scene.wav")), []);
});

test("caption timings follow the trimmed, joined audio", async () => {
  mockEleven();
  const dir = tmpDir("n3");
  const r = await narrateWithEleven(base(dir, TWO_SENTENCES, { gapSeed: 1 }));
  const clip = SPEECH_END - SPEECH_START + LEAD_IN + 0.09;
  const gap = gapSeconds(preset, 1);
  const words = r.words;
  assert.equal(words.map((w) => w.text).join(" "), TWO_SENTENCES);
  assert.ok(Math.abs(words[0].start - LEAD_IN) < 0.02, `first word starts at ${words[0].start}`);
  const firstOfSecond = words.find((w) => w.text === "Nobody")!;
  assert.ok(Math.abs(firstOfSecond.start - (clip + gap + LEAD_IN)) < 0.03, `second sentence starts at ${firstOfSecond.start}`);
  for (let i = 1; i < words.length; i++) assert.ok(words[i].start >= words[i - 1].start - 1e-9, "words stay in order");
  assert.ok(words[words.length - 1].end <= r.duration + 0.02);
});

test("tempo shrinks the audio and the caption timings together", async () => {
  mockEleven();
  const dir = tmpDir("n4");
  const slow = await narrateWithEleven(base(dir, "A single sentence that is long enough to stand alone.", { outBase: path.join(dir, "a") }));
  const fast = await narrateWithEleven(base(dir, "A single sentence that is long enough to stand alone.", { outBase: path.join(dir, "b"), preset: { ...preset, tempo: MAX_TEMPO } }));
  assert.ok(fast.duration < slow.duration * 0.97, `${fast.duration} vs ${slow.duration}`);
  const lastSlow = slow.words[slow.words.length - 1].end;
  const lastFast = fast.words[fast.words.length - 1].end;
  assert.ok(Math.abs(lastFast - lastSlow / MAX_TEMPO) < 0.03, `${lastFast} vs ${lastSlow / MAX_TEMPO}`);
});

test("falls back to the next model when one isn't available, and doesn't ask for it again", async () => {
  mockEleven((call) =>
    call.body.model_id === "eleven_v4" ? { status: 404, json: { detail: { status: "model_not_found", message: "Model eleven_v4 was not found" } } } : undefined,
  );
  const dir = tmpDir("n5");
  const r = await narrateWithEleven(base(dir, TWO_SENTENCES, { outBase: path.join(dir, "a") }));
  assert.deepEqual(r.models, ["eleven_v3"]);
  assert.equal(calls[0].body.model_id, "eleven_v4");
  assert.equal(calls[1].body.model_id, "eleven_v3");
  // v3 takes only three stability steps and no style.
  assert.ok([0, 0.5, 1].includes(calls[1].body.voice_settings.stability));
  assert.equal(calls[1].body.voice_settings.style, undefined);
  const before = calls.length;
  await narrateWithEleven(base(dir, TWO_SENTENCES, { outBase: path.join(dir, "b") }));
  assert.ok(calls.slice(before).every((c) => c.body.model_id === "eleven_v3"), "the unavailable model is skipped from now on");
});

test("steps down the settings a model rejects, and remembers what worked", async () => {
  mockEleven((call) =>
    call.body.model_id === "eleven_v4" && call.body.voice_settings.style !== undefined
      ? { status: 422, json: { detail: [{ loc: ["body", "voice_settings", "style"], msg: "style is not supported for this model" }] } }
      : undefined,
  );
  const dir = tmpDir("n6");
  await narrateWithEleven(base(dir, "One sentence that is plenty long enough to stand on its own here."));
  assert.equal(calls.length, 2);
  assert.notEqual(calls[0].body.voice_settings.style, undefined);
  assert.equal(calls[1].body.voice_settings.style, undefined);
  assert.equal(calls[1].body.model_id, "eleven_v4");
  assert.equal(calls[1].body.voice_settings.speed, preset.speed, "speed is kept");
  const before = calls.length;
  await narrateWithEleven(base(dir, "Another sentence that is also long enough to be spoken alone.", { outBase: path.join(dir, "x") }));
  assert.equal(calls.length - before, 1, "no repeat of the rejected request");
  assert.equal(calls[before].body.voice_settings.style, undefined);
});

test("drops previous_text/next_text for a model that rejects them, then sends whole scenes instead of sentences", async () => {
  mockEleven((call) =>
    "previous_text" in call.body || "next_text" in call.body
      ? { status: 400, json: { detail: { status: "invalid_request", message: "previous_text is not supported for this model" } } }
      : undefined,
  );
  const dir = tmpDir("n7");
  await narrateWithEleven(base(dir, TWO_SENTENCES, { outBase: path.join(dir, "a") }));
  const withoutContext = calls.filter((c) => !("previous_text" in c.body) && !("next_text" in c.body));
  assert.ok(withoutContext.length >= 2, "the sentences were retried without context");
  const before = calls.length;
  await narrateWithEleven(base(dir, TWO_SENTENCES, { outBase: path.join(dir, "b") }));
  assert.equal(calls.length - before, 1, "the whole scene goes in one request");
  assert.equal(calls[before].body.text, TWO_SENTENCES);
});

test("a used-up quota stops straight away instead of trying every model", async () => {
  mockEleven(() => ({ status: 401, json: { detail: { status: "quota_exceeded", message: "You have used all your credits" } } }));
  const dir = tmpDir("n8");
  await assert.rejects(narrateWithEleven(base(dir)), (err: Error) => err instanceof ElevenError && /used up this month/.test(err.message));
  assert.equal(calls.length, 1);
});

test("falls through every model and says so when none is available", async () => {
  mockEleven(() => ({ status: 404, json: { detail: { status: "model_not_found", message: "model not found" } } }));
  await assert.rejects(narrateWithEleven(base(tmpDir("n9"))), /No ElevenLabs model could voice this line/);
  assert.equal(calls.length, 3);
});

test("words per minute counts spoken words and ignores audio tags", () => {
  assert.equal(wordsPerMinute("one two three four five six", 3), 120);
  assert.equal(wordsPerMinute("[whispering] one two three four five six", 3), 120);
  assert.equal(wordsPerMinute("hello", 0), 0);
});
