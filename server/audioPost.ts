import fs from "node:fs";
import { spawn } from "node:child_process";
import ffmpegPath from "ffmpeg-static";
import { MAX_TEMPO, MIN_TEMPO } from "./voicePresets";
import { FX_FILTERS, type CharacterFx } from "./characterFx";

/**
 * FFmpeg audio post-processing for narration: trimming each clip to the speech, joining clips
 * with natural gaps, and mastering the voice track (light compression, loudness to -16 LUFS).
 * Everything works on 44.1 kHz mono WAV and never changes pitch.
 */

export const SAMPLE_RATE = 44100;
/** Loudness target for the voice track, in LUFS. Music is mixed under it afterwards. */
export const TARGET_LUFS = -16;
export const TRUE_PEAK = -1.5;

export const audioToolsAvailable = () => Boolean(ffmpegPath && fs.existsSync(ffmpegPath));

/** Runs FFmpeg and resolves with its stderr text. */
export function runFfmpeg(args: string[], opts: { info?: boolean } = {}) {
  return new Promise<string>((resolve, reject) => {
    if (!ffmpegPath) return reject(new Error("FFmpeg is missing. Run npm install again."));
    const proc = spawn(ffmpegPath, ["-y", "-hide_banner", "-nostdin", "-loglevel", opts.info ? "info" : "error", ...args]);
    let log = "";
    proc.stderr.on("data", (chunk: Buffer) => (log = (log + chunk.toString()).slice(-60000)));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) return resolve(log);
      reject(new Error(`Audio processing failed (exit ${code}): ${log.split(/[\r\n]+/).filter(Boolean).slice(-6).join(" | ").slice(-600)}`));
    });
  });
}

/** Length of an audio file in seconds. */
export async function audioDuration(file: string): Promise<number> {
  const log = await runFfmpeg(["-i", file, "-f", "null", "-"], { info: true });
  const times = [...log.matchAll(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)];
  const last = times[times.length - 1];
  if (!last) throw new Error(`Couldn't read the length of ${file}.`);
  return Number(last[1]) * 3600 + Number(last[2]) * 60 + Number(last[3]);
}

export interface TrimOptions {
  /** Seconds to cut from the start (where speech begins, minus a little breath) */
  start: number;
  /** Seconds where speech ends (plus a little tail); omit to keep the rest */
  end?: number;
  /** Speed-up with pitch preserved, clamped to 1.00-1.08 */
  tempo?: number;
}

/**
 * Cuts a clip down to its speech and converts it to 44.1 kHz mono WAV. Short fades on both
 * ends stop clicks. Returns the clip's new length in seconds.
 */
export async function trimClip(src: string, out: string, opts: TrimOptions): Promise<number> {
  const tempo = Math.min(MAX_TEMPO, Math.max(MIN_TEMPO, opts.tempo ?? 1));
  const start = Math.max(0, opts.start);
  const trim = opts.end !== undefined ? `atrim=start=${start.toFixed(4)}:end=${Math.max(opts.end, start + 0.05).toFixed(4)}` : `atrim=start=${start.toFixed(4)}`;
  const filters = [trim, "asetpts=PTS-STARTPTS", `aresample=${SAMPLE_RATE}`, "aformat=sample_fmts=s16:channel_layouts=mono"];
  // atempo drops its last ~30 ms, so give it silence to drop instead of the end of a word.
  if (tempo > 1.0001) filters.push("apad=pad_dur=0.06", `atempo=${tempo.toFixed(4)}`);
  const fades = (len: number) => [`afade=t=in:d=0.008`, `afade=t=out:st=${Math.max(0, len - 0.015).toFixed(4)}:d=0.015`];
  // First pass writes the trimmed clip; the fades need its length, so a second short pass applies them.
  const tmp = `${out}.pre.wav`;
  await runFfmpeg(["-i", src, "-af", filters.join(","), "-ac", "1", "-ar", String(SAMPLE_RATE), tmp]);
  const length = await audioDuration(tmp);
  await runFfmpeg(["-i", tmp, "-af", fades(length).join(","), "-ac", "1", "-ar", String(SAMPLE_RATE), out]);
  fs.rmSync(tmp, { force: true });
  return length;
}

/**
 * Joins clips into one WAV, with `gapsAfter[i]` seconds of silence after clip i (the last gap is
 * left out: whoever places the scene decides what follows it). Returns the total length.
 */
export async function joinWithGaps(files: string[], gapsAfter: number[], out: string): Promise<number> {
  if (!files.length) throw new Error("Nothing to join.");
  if (files.length === 1) {
    await runFfmpeg(["-i", files[0], "-ac", "1", "-ar", String(SAMPLE_RATE), out]);
    return audioDuration(out);
  }
  const prep = files.map((_, i) => {
    const gap = i < files.length - 1 ? Math.max(0, gapsAfter[i] ?? 0) : 0;
    const pad = gap > 0 ? `,apad=pad_dur=${gap.toFixed(4)}` : "";
    return `[${i}:a]aresample=${SAMPLE_RATE},aformat=sample_fmts=s16:channel_layouts=mono${pad}[a${i}]`;
  });
  const graph = `${prep.join(";")};${files.map((_, i) => `[a${i}]`).join("")}concat=n=${files.length}:v=0:a=1[out]`;
  await runFfmpeg([...files.flatMap((f) => ["-i", f]), "-filter_complex", graph, "-map", "[out]", "-ac", "1", "-ar", String(SAMPLE_RATE), out]);
  return audioDuration(out);
}

export interface Loudness {
  /** Integrated loudness, LUFS */
  input_i: number;
  /** True peak, dBTP */
  input_tp: number;
  /** Loudness range, LU */
  input_lra: number;
  input_thresh: number;
  target_offset: number;
}

/** Light cleanup and gentle compression ahead of loudness normalisation. */
export const VOICE_CHAIN = [
  "highpass=f=70",
  "acompressor=threshold=-20dB:ratio=2.5:attack=8:release=120:makeup=1.5",
];

const LOUDNORM = `loudnorm=I=${TARGET_LUFS}:TP=${TRUE_PEAK}:LRA=11`;

function parseLoudnorm(log: string): Loudness {
  const start = log.lastIndexOf("{");
  const end = log.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("Couldn't measure the loudness of the voice track.");
  const raw = JSON.parse(log.slice(start, end + 1));
  const n = (k: string) => Number(raw[k]);
  return { input_i: n("input_i"), input_tp: n("input_tp"), input_lra: n("input_lra"), input_thresh: n("input_thresh"), target_offset: n("target_offset") };
}

/** Integrated loudness (LUFS), true peak and loudness range of a file. */
export async function measureLoudness(file: string, chain: string[] = []): Promise<Loudness> {
  const filter = [...chain, `${LOUDNORM}:print_format=json`].join(",");
  return parseLoudnorm(await runFfmpeg(["-i", file, "-af", filter, "-f", "null", "-"], { info: true }));
}

/**
 * Masters the voice track: high-pass, light compression, then two-pass linear loudness
 * normalisation to -16 LUFS. Returns what was measured before and after.
 */
export async function masterVoice(src: string, out: string): Promise<{ before: Loudness; after: Loudness }> {
  const before = await measureLoudness(src, VOICE_CHAIN);
  const measured = `measured_I=${before.input_i}:measured_TP=${before.input_tp}:measured_LRA=${before.input_lra}:measured_thresh=${before.input_thresh}:offset=${before.target_offset}`;
  const filter = [...VOICE_CHAIN, `${LOUDNORM}:${measured}:linear=true`, `aresample=${SAMPLE_RATE}`].join(",");
  await runFfmpeg(["-i", src, "-af", filter, "-ar", String(SAMPLE_RATE), out]);
  return { before: await measureLoudness(src), after: await measureLoudness(out) };
}

/**
 * Gives a character's line its own space (room, radio, intimacy). Reverb and echo get silence
 * to ring into so the tail isn't cut off. Returns the new length in seconds.
 */
export async function applyFx(src: string, out: string, fx: CharacterFx | undefined): Promise<number> {
  const filters = FX_FILTERS[fx ?? "none"];
  if (!filters.length) {
    if (src !== out) fs.copyFileSync(src, out);
    return audioDuration(out);
  }
  const tail = fx === "hall" ? ["apad=pad_dur=0.35"] : [];
  await runFfmpeg(["-i", src, "-af", [...tail, ...filters, `aresample=${SAMPLE_RATE}`].join(","), "-ac", "1", "-ar", String(SAMPLE_RATE), out]);
  return audioDuration(out);
}
