import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runFfmpeg } from "../audioPost";

export function tmpDir(name: string) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `studio-${name}-`));
}

/** A speech-like tone (pulsing sine) with silence before and after, as 44.1 kHz mono WAV. */
export async function makeSpeechLike(file: string, o: { lead?: number; body?: number; tail?: number; volume?: number; freq?: number } = {}) {
  const { lead = 0.3, body = 1, tail = 0.4, volume = 0.2, freq = 180 } = o;
  await runFfmpeg([
    "-f", "lavfi", "-i", `sine=f=${freq}:d=${body}:r=44100,tremolo=f=4:d=0.8,volume=${volume}`,
    "-af", `adelay=${Math.round(lead * 1000)}:all=1,apad=pad_dur=${tail}`,
    "-ar", "44100", "-ac", "1", file,
  ]);
}

/** What an ElevenLabs with-timestamps response looks like for `text` spoken between two times. */
export function fakeAlignment(text: string, start: number, end: number) {
  const n = text.length;
  const step = (end - start) / n;
  return {
    characters: [...text],
    character_start_times_seconds: [...text].map((_, i) => start + i * step),
    character_end_times_seconds: [...text].map((_, i) => start + (i + 1) * step),
  };
}
