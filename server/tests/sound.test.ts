import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DUCK_DB, duckFilter, makeStinger, mixBed, musicGainExpression, musicMode, timedCues } from "../soundDesign";
import { CINEMASCOPE, finishingFilters } from "../finishing";
import { audioDuration, masterVoice, runFfmpeg } from "../audioPost";
import { tmpDir } from "./helpers";

/** Mean volume in dB of a stretch of audio. */
async function meanDb(file: string, start: number, end: number) {
  const log = await runFfmpeg(["-i", file, "-af", `atrim=start=${start}:end=${end},volumedetect`, "-f", "null", "-"], { info: true });
  const m = /mean_volume:\s*(-?[\d.]+) dB/.exec(log);
  assert.ok(m, `no volume for ${start}-${end}`);
  return Number(m[1]);
}

test("music modes are read from the cue text", () => {
  assert.equal(musicMode("low strings, tense"), "normal");
  assert.equal(musicMode("out"), "out");
  assert.equal(musicMode("silence"), "out");
  assert.equal(musicMode("swell to a climax"), "swell");
});

test("timedCues puts each scene's cues at its start and skips pauses", () => {
  const cues = timedCues(
    [{ cues: [{ kind: "sfx", text: "door" }, { kind: "pause", ms: 500 }] }, {}, { cues: [{ kind: "chapter", text: "Act two" }] }],
    [0, 4, 9.5],
  );
  assert.deepEqual(cues, [{ kind: "sfx", text: "door", start: 0 }, { kind: "chapter", text: "Act two", start: 9.5 }]);
  assert.equal(musicGainExpression(cues), null);
});

test("music gain follows [MUSIC: out] and [MUSIC: swell] cues (measured)", async () => {
  const dir = tmpDir("gain");
  const src = path.join(dir, "m.wav");
  await runFfmpeg(["-f", "lavfi", "-i", "sine=f=300:d=14:r=44100,volume=0.3", "-ac", "1", src]);
  const expr = musicGainExpression([
    { kind: "music", text: "out", start: 4 },
    { kind: "music", text: "swell", start: 9 },
  ]);
  assert.ok(expr);
  const out = path.join(dir, "g.wav");
  await runFfmpeg(["-i", src, "-af", `volume='${expr}':eval=frame`, out]);
  const before = await meanDb(out, 1, 3.5);
  const silent = await meanDb(out, 6, 8);
  const swell = await meanDb(out, 11.5, 13.5);
  console.log(`  music level: normal ${before.toFixed(1)} dB, after "out" ${silent.toFixed(1)} dB, swell ${swell.toFixed(1)} dB`);
  assert.ok(silent < before - 50, "music is muted after [MUSIC: out]");
  assert.ok(Math.abs(swell - before - 4.1) < 0.6, `swell is about +4 dB (${swell - before})`);
});

test("music ducks about 14 dB under mastered speech and recovers in the gaps (measured)", async () => {
  const dir = tmpDir("duck");
  // Speech-like voice: pulsing tone in 0-4 s and 8-12 s, silence between.
  const raw = path.join(dir, "voice-raw.wav");
  await runFfmpeg([
    "-f", "lavfi", "-i", "sine=f=180:d=4:r=44100,tremolo=f=5:d=0.8,volume=0.4",
    "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono",
    "-filter_complex", "[0:a]asplit=2[a][b];[1:a]atrim=duration=4,asetpts=PTS-STARTPTS[s];[a][s][b]concat=n=3:v=0:a=1,apad=pad_dur=2[out]",
    "-map", "[out]", "-ac", "1", raw,
  ]);
  const voice = path.join(dir, "voice.wav");
  const m = await masterVoice(raw, voice);
  assert.ok(Math.abs(m.after.input_i - -16) < 0.8, `voice at ${m.after.input_i} LUFS`);
  const music = path.join(dir, "music.wav");
  await runFfmpeg(["-f", "lavfi", "-i", "sine=f=330:d=14:r=44100,volume=0.3", "-ac", "1", music]);
  const out = path.join(dir, "ducked.wav");
  await runFfmpeg(["-i", music, "-i", voice, "-filter_complex", `[0:a][1:a]${duckFilter()}[o]`, "-map", "[o]", out]);
  const speaking = await meanDb(out, 1.5, 3.8);
  const gap = await meanDb(out, 5.5, 7.5);
  const depth = gap - speaking;
  console.log(`  music ducking: ${speaking.toFixed(1)} dB under speech vs ${gap.toFixed(1)} dB in gaps = ${depth.toFixed(1)} dB deep (target ${DUCK_DB})`);
  assert.ok(depth >= 12 && depth <= 18, `duck depth ${depth} dB should be 12-18`);
  const again = await meanDb(out, 9.5, 11.8);
  assert.ok(Math.abs(again - speaking) < 1.5, "ducks again on the next line");
});

test("mixBed places effects at their time, loops ambience and makes a stinger", async () => {
  const dir = tmpDir("bed");
  const sfx = path.join(dir, "sfx.wav");
  await runFfmpeg(["-f", "lavfi", "-i", "sine=f=800:d=0.5:r=44100,volume=0.5", sfx]);
  const amb = path.join(dir, "amb.wav");
  await runFfmpeg(["-f", "lavfi", "-i", "anoisesrc=d=2:c=brown:r=44100:a=0.3", amb]);
  const stinger = await makeStinger(path.join(dir, "st.wav"));
  assert.ok((await audioDuration(stinger)) > 1.2);
  const out = path.join(dir, "bed.wav");
  await mixBed(
    [
      { file: sfx, start: 3, gainDb: -6 },
      { file: amb, start: 1, gainDb: -20, loopFor: 6 },
      { file: stinger, start: 6.5, gainDb: -8 },
    ],
    9,
    out,
  );
  assert.ok(Math.abs((await audioDuration(out)) - 9) < 0.1);
  const quiet = await meanDb(out, 0, 0.8);
  const hit = await meanDb(out, 3.05, 3.4);
  const stung = await meanDb(out, 6.6, 7.0);
  assert.ok(quiet < -60, `silent before anything starts (${quiet})`);
  assert.ok(hit > quiet + 30 && stung > quiet + 30, `effects land where placed (sfx ${hit}, stinger ${stung})`);
  // Ambience loops past its 2 s source file.
  assert.ok((await meanDb(out, 4.5, 5.5)) > -50, "ambience bed still playing 3.5 s in");
});

// ---- film finishing, checked on real frames ----

async function frame(dir: string, name: string, filters: string[], size: string, input = "color=c=gray:s=640x360") {
  const out = path.join(dir, `${name}.rgb`);
  await runFfmpeg(["-f", "lavfi", "-i", input, "-vf", [...filters, "format=rgb24"].join(","), "-frames:v", "1", "-f", "rawvideo", out]);
  const [w, h] = size.split("x").map(Number);
  const buf = fs.readFileSync(out);
  assert.equal(buf.length, w * h * 3, `frame size for ${name}`);
  return { buf, w, h, px: (x: number, y: number) => [buf[(y * w + x) * 3], buf[(y * w + x) * 3 + 1], buf[(y * w + x) * 3 + 2]] };
}

test("letterbox gives 2.39:1 black bars and keeps the frame size", async () => {
  const dir = tmpDir("fin");
  const f = finishingFilters({ letterbox: true }, 640, 360);
  const { px } = await frame(dir, "lb", f, "640x360");
  const picture = Math.floor(640 / CINEMASCOPE / 2) * 2; // 268
  const bar = (360 - picture) / 2;
  assert.ok(px(320, 5).every((c) => c < 8), "top bar is black");
  assert.ok(px(320, 354).every((c) => c < 8), "bottom bar is black");
  assert.ok(px(320, bar + 10).every((c) => c > 100), "picture area is untouched");
  console.log(`  letterbox: ${picture}px picture, ${bar}px bars on a 640x360 frame (${(640 / picture).toFixed(2)}:1)`);
});

test("letterbox is skipped on vertical video; grade and grain filters run", async () => {
  assert.deepEqual(finishingFilters({ letterbox: true }, 1080, 1920), []);
  const dir = tmpDir("fin2");
  const sepia = await frame(dir, "sepia", finishingFilters({ grade: "sepia" }, 640, 360), "640x360");
  const [r, , b] = sepia.px(100, 100);
  assert.ok(r > b + 25, `sepia warms the picture (r ${r}, b ${b})`);
  const desat = await frame(dir, "desat", finishingFilters({ grade: "desaturated", grain: true }, 640, 360), "640x360", "testsrc=s=640x360");
  assert.equal(desat.buf.length, 640 * 360 * 3);
  assert.deepEqual(finishingFilters({}, 640, 360), []);
});
