import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { audioDuration, joinWithGaps, masterVoice, measureLoudness, trimClip, TARGET_LUFS, TRUE_PEAK } from "../audioPost";
import { MAX_TEMPO } from "../voicePresets";
import { makeSpeechLike, tmpDir } from "./helpers";

/** Dominant frequency (Hz) of the middle second of a mono 16-bit WAV, found with a Goertzel scan. */
function estimateFrequency(file: string) {
  const buf = fs.readFileSync(file);
  let at = 12;
  let data = Buffer.alloc(0);
  while (at < buf.length - 8) {
    const id = buf.toString("ascii", at, at + 4);
    const size = buf.readUInt32LE(at + 4);
    if (id === "data") {
      data = buf.subarray(at + 8, at + 8 + size);
      break;
    }
    at += 8 + size;
  }
  const rate = 44100;
  const total = data.length / 2;
  const from = Math.max(0, Math.floor(total / 2 - rate / 2));
  const x = Array.from({ length: Math.min(rate, total - from) }, (_, i) => data.readInt16LE((from + i) * 2) / 32768);
  let best = 0;
  let bestPower = -1;
  for (let f = 80; f <= 500; f++) {
    const w = (2 * Math.PI * f) / rate;
    const coeff = 2 * Math.cos(w);
    let s1 = 0;
    let s2 = 0;
    for (const v of x) {
      const s0 = v + coeff * s1 - s2;
      s2 = s1;
      s1 = s0;
    }
    const power = s1 * s1 + s2 * s2 - coeff * s1 * s2;
    if (power > bestPower) [best, bestPower] = [f, power];
  }
  return best;
}

test("trimClip cuts leading and trailing silence down to the speech", async () => {
  const d = tmpDir("trim");
  const src = path.join(d, "src.wav");
  await makeSpeechLike(src, { lead: 0.5, body: 1.2, tail: 0.4 });
  assert.ok(Math.abs((await audioDuration(src)) - 2.1) < 0.03);
  const length = await trimClip(src, path.join(d, "out.wav"), { start: 0.46, end: 1.74 });
  assert.ok(Math.abs(length - 1.28) < 0.03, `trimmed length ${length}`);
});

test("tempo speeds speech up without changing pitch, and is capped at 1.08", async () => {
  const d = tmpDir("tempo");
  const src = path.join(d, "src.wav");
  await makeSpeechLike(src, { lead: 0.1, body: 3, tail: 0.1, freq: 180 });
  const plain = await trimClip(src, path.join(d, "plain.wav"), { start: 0.1, end: 3.1, tempo: 1 });
  const fast = await trimClip(src, path.join(d, "fast.wav"), { start: 0.1, end: 3.1, tempo: 1.05 });
  const capped = await trimClip(src, path.join(d, "capped.wav"), { start: 0.1, end: 3.1, tempo: 2 });
  const atMax = await trimClip(src, path.join(d, "max.wav"), { start: 0.1, end: 3.1, tempo: MAX_TEMPO });
  // 5% faster, give or take the short silence padded on so the end of a word is never clipped.
  assert.ok(Math.abs(plain / fast - 1.05) < 0.03, `ratio ${plain / fast}`);
  assert.ok(Math.abs(capped - atMax) < 0.01, "a tempo above 1.08 is treated as 1.08");
  const base = estimateFrequency(path.join(d, "plain.wav"));
  const shifted = estimateFrequency(path.join(d, "fast.wav"));
  assert.ok(Math.abs(base - 180) <= 2, `baseline pitch ${base}`);
  assert.ok(Math.abs(shifted - base) <= 2, `pitch moved from ${base} to ${shifted}`);
});

test("joinWithGaps puts exactly the requested silence between clips and none after the last", async () => {
  const d = tmpDir("join");
  const files: string[] = [];
  for (const [i, body] of [1, 0.8, 1.2].entries()) {
    const f = path.join(d, `c${i}.wav`);
    await makeSpeechLike(f, { lead: 0, body, tail: 0 });
    files.push(f);
  }
  const total = await joinWithGaps(files, [0.2, 0.35, 9], path.join(d, "joined.wav"));
  assert.ok(Math.abs(total - (1 + 0.8 + 1.2 + 0.2 + 0.35)) < 0.03, `total ${total}`);
  const single = await joinWithGaps([files[0]], [0.5], path.join(d, "single.wav"));
  assert.ok(Math.abs(single - 1) < 0.03);
});

test("masterVoice brings quiet and loud voices to -16 LUFS without clipping", async () => {
  const d = tmpDir("master");
  for (const [name, volume] of [["quiet", 0.02], ["loud", 0.6]] as const) {
    const src = path.join(d, `${name}.wav`);
    await makeSpeechLike(src, { lead: 0.2, body: 6, tail: 0.2, volume });
    const { before, after } = await masterVoice(src, path.join(d, `${name}-master.wav`));
    assert.notEqual(Math.round(before.input_i), TARGET_LUFS, "the source should not already be at target");
    assert.ok(Math.abs(after.input_i - TARGET_LUFS) < 0.7, `${name}: ${after.input_i} LUFS`);
    assert.ok(after.input_tp <= TRUE_PEAK + 0.3, `${name}: true peak ${after.input_tp}`);
    const check = await measureLoudness(path.join(d, `${name}-master.wav`));
    assert.ok(Math.abs(check.input_i - after.input_i) < 0.05);
  }
});
