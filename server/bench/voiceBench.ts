/**
 * Old vs new narration, side by side, measured.
 *
 *   npm run voice:bench -- --video <videoId> [--voice <voiceId>] [--out ./bench-out] [--words 225]
 *   npm run voice:bench -- --script path/to/script.txt
 *   npm run voice:bench -- --mock        (synthetic audio and a fake ElevenLabs: tests the harness only)
 *
 * It renders the first ~90 s (225 words) of the script twice, once the way the app used to
 * (one request per scene, multilingual v2, fixed 0.25 s gaps, no mastering) and once with the
 * new pipeline, then a 40 s three-speaker dialogue scene. For each it reports words per minute,
 * integrated loudness, true peak, the longest silence and the number of long gaps, and writes
 * WAV files you can listen to. Costs ElevenLabs characters when run for real (about 3,000).
 */
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { db } from "../db";
import { elevenSpeak, resetModelMemory, voiceConfigured } from "../media";
import { concatScenes, silenceReport } from "./benchTools";
import { audioDuration, masterVoice, measureLoudness } from "../audioPost";
import { prepareScript } from "../screenplay";
import { splitSentences } from "../ttsChunks";
import { listVoices, synthesizeScenes, type CharacterLine, type SceneAudio } from "../voices";
import { resolvePresets } from "../voicePresets";
import { wordsPerMinute } from "../narration";

const { values: args } = parseArgs({
  options: {
    video: { type: "string" },
    script: { type: "string" },
    voice: { type: "string" },
    out: { type: "string", default: "bench-out" },
    words: { type: "string", default: "225" },
    mock: { type: "boolean", default: false },
  },
});

const DIALOGUE = [
  ["NARRATOR", "", "The nurse lowered her voice and leaned toward the bed."],
  ["BESS", "tender", "Rest, Harry. The doctors say you must rest."],
  ["HOUDINI", "tired, whispering", "I can still feel the blow. Nobody asks for it, Bess. Nobody."],
  ["DOCTOR", "firm", "Mr. Houdini, the pain in your side is not nothing. We operate tonight."],
  ["HOUDINI", "defiant", "Tonight I have a show to finish."],
  ["BESS", "afraid", "Harry, please."],
  ["NARRATOR", "", "He did not finish the show. Eight days later, on Halloween, the greatest escape artist in the world was dead."],
] as const;

interface Metrics {
  label: string;
  seconds: number;
  words: number;
  wpm: number;
  lufs: number;
  truePeak: number;
  longestSilence: number;
  longGaps: number;
  file: string;
  errors: string[];
}

async function measure(label: string, text: string, file: string, errors: string[]): Promise<Metrics> {
  const seconds = await audioDuration(file);
  const loud = await measureLoudness(file);
  const quiet = await silenceReport(file);
  return {
    label,
    seconds: Number(seconds.toFixed(2)),
    words: text.split(/\s+/).filter(Boolean).length,
    wpm: wordsPerMinute(text, seconds),
    lufs: Number(loud.input_i.toFixed(1)),
    truePeak: Number(loud.input_tp.toFixed(1)),
    longestSilence: Number(quiet.longest.toFixed(2)),
    longGaps: quiet.over500ms,
    file,
    errors,
  };
}

/** The first `maxWords` words of the script as scenes of up to two sentences. */
function openingScenes(script: string, maxWords: number) {
  const spoken = prepareScript(script).spoken.split("\n").filter((l) => !/^\[.*\]$/.test(l.trim()));
  const sentences = spoken.flatMap((l) => splitSentences(l.replace(/^[A-Z][A-Z .'’-]{0,39}:\s*(\[[^\]]*\]\s*)?/, "")));
  const scenes: string[] = [];
  let count = 0;
  for (let i = 0; i < sentences.length && count < maxWords; i += 2) {
    const text = sentences.slice(i, i + 2).join(" ");
    scenes.push(text);
    count += text.split(/\s+/).length;
  }
  return scenes;
}

async function renderOld(scenes: string[], voiceId: string, dir: string, errors: string[]) {
  const done: SceneAudio[] = [];
  for (const [i, text] of scenes.entries()) {
    try {
      const file = path.join(dir, `old-${i}.mp3`);
      const r = await elevenSpeak(text, voiceId, file); // the old call: multilingual v2, fixed settings
      done.push({ file, words: r.words, duration: r.duration });
    } catch (err) {
      errors.push(`old scene ${i + 1}: ${(err as Error).message}`);
    }
  }
  // As render.ts did: each scene padded with a fixed 0.25 s, joined, nothing else.
  return concatScenes(done.map((d) => d.file), done.map(() => 0.25), path.join(dir, "old-opening.wav"));
}

async function main() {
  const out = path.resolve(args.out!);
  fs.mkdirSync(out, { recursive: true });
  const work = fs.mkdtempSync(path.join(out, "work-"));
  let restore: (() => void) | undefined;
  if (args.mock) restore = (await import("./mockEleven")).installMockEleven();
  else if (!voiceConfigured()) throw new Error("Set ELEVENLABS_API_KEY (or use --mock to test the harness with fake audio).");

  const results: Metrics[] = [];
  const problems: string[] = [];
  try {
    let script = "";
    if (args.script) script = fs.readFileSync(args.script, "utf8");
    else if (args.video) script = db.video(args.video)?.script ?? "";
    else if (args.mock) script = "In 1926 the most famous escape artist in the world walked into a Montreal hospital. He had been punched in the stomach by a student. Nobody thought it mattered. He kept his show going for two more days. The pain grew worse every hour. By the time he saw a doctor his appendix had burst. Eight days later he was dead. But the strangest part of the story begins at the funeral. His wife had made him a promise. If there was a way to speak from the other side, he would find it. Every year on the anniversary she held a séance. For ten years nothing came. Then, on the tenth Halloween, the candle went out.";
    if (!script.trim()) throw new Error("Give --video <id> or --script <file>.");
    const scenes = openingScenes(script, Number(args.words));
    const text = scenes.join(" ");

    const voices = args.mock ? [] : await listVoices("elevenlabs").catch(() => []);
    const voiceId = args.voice ?? (args.mock ? "mock-narrator" : "JBFqnCBsd6RMkjVDRZzb");
    const cast = (process.env.BENCH_VOICES ?? "").split(",").filter(Boolean);
    const pick = (n: number) => cast[n] ?? voices[n + 1]?.id ?? voices[0]?.id ?? `mock-voice-${n}`;

    // 1. Opening, old pipeline.
    resetModelMemory();
    const oldErrors: string[] = [];
    const oldFile = await renderOld(scenes, voiceId, work, oldErrors);
    results.push(await measure("Opening ~90 s: OLD pipeline", text, oldFile, oldErrors));

    // 2. Opening, new pipeline.
    const newErrors: string[] = [];
    const presets = resolvePresets(undefined as never);
    const narrated = await synthesizeScenes(scenes, { engine: "elevenlabs", voiceId }, path.join(work, "new"), () => undefined, [], { format: "long", presets }).catch((e) => {
      newErrors.push((e as Error).message);
      return [] as SceneAudio[];
    });
    if (narrated.length) {
      const joined = await concatScenes(narrated.map((n) => n.file), narrated.map((n) => n.gapAfter ?? 0.25), path.join(work, "new-opening-raw.wav"));
      const mastered = path.join(out, "new-opening.wav");
      await masterVoice(joined, mastered);
      results.push(await measure("Opening ~90 s: NEW pipeline", text, mastered, newErrors));
    } else results.push({ label: "Opening ~90 s: NEW pipeline", seconds: 0, words: 0, wpm: 0, lufs: 0, truePeak: 0, longestSilence: 0, longGaps: 0, file: "", errors: newErrors });
    fs.copyFileSync(oldFile, path.join(out, "old-opening.wav"));

    // 3. Three-speaker dialogue scene.
    const ids: Record<string, string> = { NARRATOR: voiceId, BESS: pick(0), HOUDINI: pick(1), DOCTOR: pick(2) };
    const lines = DIALOGUE.map(([speaker, delivery, line]) => ({ speaker, delivery, line }));
    const characters: (CharacterLine | undefined)[] = lines.map((l) => (l.speaker === "NARRATOR" ? undefined : { voiceId: ids[l.speaker], delivery: l.delivery, fx: l.speaker === "DOCTOR" ? ("hall" as const) : undefined }));
    const dErrors: string[] = [];
    const dialogue = await synthesizeScenes(lines.map((l) => l.line), { engine: "elevenlabs", voiceId }, path.join(work, "dlg"), () => undefined, characters, { format: "long", presets }).catch((e) => {
      dErrors.push((e as Error).message);
      return [] as SceneAudio[];
    });
    if (dialogue.length) {
      const joined = await concatScenes(dialogue.map((d) => d.file), dialogue.map((d) => d.gapAfter ?? 0.25), path.join(work, "dlg-raw.wav"));
      const mastered = path.join(out, "new-dialogue-3-speakers.wav");
      await masterVoice(joined, mastered);
      results.push(await measure("Dialogue scene, 3 speakers + narrator: NEW", lines.map((l) => l.line).join(" "), mastered, dErrors));
    } else results.push({ label: "Dialogue scene, 3 speakers + narrator: NEW", seconds: 0, words: 0, wpm: 0, lufs: 0, truePeak: 0, longestSilence: 0, longGaps: 0, file: "", errors: dErrors });
  } catch (err) {
    problems.push((err as Error).message);
  } finally {
    restore?.();
    fs.rmSync(work, { recursive: true, force: true });
  }

  const table = results
    .map((r) => `| ${r.label} | ${r.seconds}s | ${r.words} | ${r.wpm} | ${r.lufs} | ${r.truePeak} | ${r.longestSilence}s | ${r.longGaps} | ${r.errors.length} |`)
    .join("\n");
  const report =
    `# Voice bench ${args.mock ? "(MOCK: synthetic audio, harness test only)" : ""}\n\n` +
    `| Render | Length | Words | Words/min | LUFS | True peak | Longest silence | Gaps > 0.5 s | Errors |\n|---|---|---|---|---|---|---|---|---|\n${table}\n\n` +
    `Targets: 150-170 wpm for documentaries, 170-190 for Shorts, about -16 LUFS, true peak under -1.5.\n` +
    (results.flatMap((r) => r.errors.map((e) => `- ${r.label}: ${e}`)).concat(problems.map((p) => `- ${p}`)).join("\n") || "No errors.") +
    "\n";
  fs.writeFileSync(path.join(out, "report.md"), report);
  fs.writeFileSync(path.join(out, "report.json"), JSON.stringify({ mock: Boolean(args.mock), results, problems }, null, 2));
  console.log(report);
  console.log(`Files and report are in ${out}`);
  if (problems.length || results.some((r) => r.errors.length)) process.exitCode = 1;
}

main();
