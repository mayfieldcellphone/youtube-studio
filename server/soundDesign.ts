import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { runFfmpeg, SAMPLE_RATE } from "./audioPost";
import type { SceneCue } from "./ai";

/**
 * Sound design around the voice: sound effects, a looping ambience per location, chapter
 * stingers and a music track that ducks 14 dB under speech, drops out or swells on cue.
 */

/** How far the music sits under speech, in dB. The brief asks for 12-18. */
export const DUCK_DB = 14;
/** Loudness of effect layers relative to a full-scale file, in dB. */
export const SFX_GAIN_DB = -9;
export const AMBIENCE_GAIN_DB = -24;
export const STINGER_GAIN_DB = -8;
const MAX_SFX_SECONDS = 4;

export interface TimedCue {
  kind: "sfx" | "music" | "ambience" | "chapter";
  text: string;
  /** Seconds from the start of the video */
  start: number;
}

/** Places each scene's sound cues on the video's timeline, at the start of that scene. */
export function timedCues(scenes: { cues?: SceneCue[] }[], sceneStarts: number[]): TimedCue[] {
  const out: TimedCue[] = [];
  for (const [i, scene] of scenes.entries()) {
    for (const cue of scene.cues ?? []) {
      if (cue.kind === "pause" || !cue.text) continue;
      out.push({ kind: cue.kind, text: cue.text, start: sceneStarts[i] ?? 0 });
    }
  }
  return out;
}

export type MusicMode = "normal" | "out" | "swell";

export function musicMode(text: string): MusicMode {
  if (/\b(out|silence|silent|stop|mute|drop|none|off)\b/i.test(text)) return "out";
  if (/\b(swell|rise|rises|build|builds|crescendo|climax|louder|loud)\b/i.test(text)) return "swell";
  return "normal";
}

const GAIN: Record<MusicMode, number> = { normal: 1, out: 0, swell: 1.6 };
const RAMP = 1.5;

/**
 * An FFmpeg expression for the music's gain over time: 1 normally, 0 after a "music out" cue,
 * +4 dB on a "swell", moving between levels over 1.5 s. Returns null when no cue changes it.
 */
export function musicGainExpression(cues: TimedCue[]): string | null {
  const events = cues.filter((c) => c.kind === "music").sort((a, b) => a.start - b.start);
  if (!events.length) return null;
  const points: [number, number][] = [[0, 1]];
  let gain = 1;
  for (const e of events) {
    const next = GAIN[musicMode(e.text)];
    const last = points[points.length - 1];
    const at = Math.max(e.start, last[0] + 0.01);
    points.push([at, gain], [at + RAMP, next]);
    gain = next;
  }
  let expr = gain.toFixed(3);
  for (let k = points.length - 1; k > 0; k--) {
    const [t0, g0] = points[k - 1];
    const [t1, g1] = points[k];
    expr = `if(lt(t,${t1.toFixed(3)}),${g0.toFixed(3)}+(${g1.toFixed(3)}-${g0.toFixed(3)})*(t-${t0.toFixed(3)})/${(t1 - t0).toFixed(3)},${expr})`;
  }
  return expr;
}

/**
 * Sidechain settings that pull the music down by about DUCK_DB under a voice mastered to
 * -16 LUFS. Ratio 4 removes three quarters of the level above the threshold, so the threshold
 * sits DUCK_DB / 0.75 dB under the voice level. Tuned by measuring a voice mastered to -16 LUFS (see sound.test.ts); real speech has softer passages, so it ducks a little less there.
 */
export function duckFilter(): string {
  return "sidechaincompress=threshold=0.034:ratio=4:attack=20:release=450:makeup=1";
}

// ---------- sound effects ----------

const cacheName = (text: string, seconds: number, kind: string) =>
  `${kind}-${crypto.createHash("sha1").update(`${text}|${seconds}`).digest("hex").slice(0, 16)}`;

/**
 * Generates a sound effect with ElevenLabs Sound Effects and caches it by prompt, so a repeated
 * cue (a door, a train whistle) is only paid for once. Returns null when it can't be made: the
 * video is then rendered without that effect.
 */
export async function generateSound(text: string, seconds: number, cacheDir: string, kind: "sfx" | "ambience"): Promise<string | null> {
  const length = Math.min(kind === "sfx" ? MAX_SFX_SECONDS : 20, Math.max(0.5, seconds));
  const file = path.join(cacheDir, `${cacheName(text, length, kind)}.mp3`);
  if (fs.existsSync(file) && fs.statSync(file).size > 1000) return file;
  if (!process.env.ELEVENLABS_API_KEY) return null;
  try {
    const res = await fetch("https://api.elevenlabs.io/v1/sound-generation?output_format=mp3_44100_128", {
      method: "POST",
      headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ text, duration_seconds: Number(length.toFixed(1)), prompt_influence: 0.4 }),
    });
    if (!res.ok) {
      console.warn(`Sound effect "${text}" couldn't be made (${res.status}); rendering without it.`);
      return null;
    }
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    return file;
  } catch (err) {
    console.warn(`Sound effect "${text}" couldn't be made: ${(err as Error).message}`);
    return null;
  }
}

/** A short low "hit" for chapter changes, made with FFmpeg so it costs nothing. */
export async function makeStinger(out: string): Promise<string> {
  await runFfmpeg([
    "-f", "lavfi", "-i", "sine=f=58:d=1.4:r=44100",
    "-f", "lavfi", "-i", "anoisesrc=d=1.4:c=pink:r=44100:a=0.35",
    "-filter_complex",
    "[0:a]afade=t=in:d=0.02,afade=t=out:st=0.1:d=1.3[low];[1:a]lowpass=f=1100,afade=t=in:d=0.02,afade=t=out:st=0.05:d=1.0[hiss];" +
      "[low][hiss]amix=inputs=2:normalize=0,aecho=0.8:0.5:90|180:0.3|0.15,aformat=channel_layouts=stereo[out]",
    "-map", "[out]", "-ar", String(SAMPLE_RATE), out,
  ]);
  return out;
}

export interface BedItem {
  file: string;
  start: number;
  gainDb: number;
  /** Repeat the file until this many seconds have passed since `start` */
  loopFor?: number;
}

/**
 * Mixes effect items onto one stereo track the length of the video. Looped items (ambience)
 * fade in and out over a second at each end so beds change gently.
 */
export async function mixBed(items: BedItem[], total: number, out: string): Promise<void> {
  if (!items.length) throw new Error("Nothing to mix.");
  const args: string[] = [];
  const chains = items.map((item, i) => {
    if (item.loopFor) args.push("-stream_loop", "-1");
    args.push("-i", item.file);
    const ms = Math.max(0, Math.round(item.start * 1000));
    const trim = item.loopFor
      ? `,atrim=duration=${item.loopFor.toFixed(3)},afade=t=in:d=1,afade=t=out:st=${Math.max(0, item.loopFor - 1).toFixed(3)}:d=1`
      : "";
    return `[${i}:a]aresample=${SAMPLE_RATE},aformat=channel_layouts=stereo${trim},volume=${item.gainDb}dB,adelay=${ms}|${ms}[b${i}]`;
  });
  const graph = `${chains.join(";")};${items.map((_, i) => `[b${i}]`).join("")}amix=inputs=${items.length}:normalize=0:duration=longest,apad,atrim=duration=${total.toFixed(3)}[out]`;
  await runFfmpeg([...args, "-filter_complex", graph, "-map", "[out]", "-ar", String(SAMPLE_RATE), "-ac", "2", out]);
}
