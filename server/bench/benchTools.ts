import { joinWithGaps, runFfmpeg } from "../audioPost";

/** Joins scene files with `gaps[i]` seconds of silence after file i. */
export const concatScenes = async (files: string[], gaps: number[], out: string) => {
  await joinWithGaps(files, gaps, out);
  return out;
};

/** Silences (below -35 dB for at least 0.4 s) found in an audio file. */
export async function silenceReport(file: string) {
  const log = await runFfmpeg(["-i", file, "-af", "silencedetect=noise=-35dB:d=0.4", "-f", "null", "-"], { info: true });
  const lengths = [...log.matchAll(/silence_duration:\s*([\d.]+)/g)].map((m) => Number(m[1]));
  return { longest: Math.max(0, ...lengths), over500ms: lengths.filter((l) => l > 0.5).length, count: lengths.length };
}
