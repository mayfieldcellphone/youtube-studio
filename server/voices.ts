import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, type Channel } from "./db";
import { DEFAULT_VOICE_ID, ELEVEN_ACTING_MODEL, elevenSpeak, listVoices as listElevenVoices, voiceConfigured as elevenConfigured, type Word } from "./media";
import { narrateWithEleven, wordsPerMinute } from "./narration";
import { applyFx, audioDuration, joinWithGaps, masterVoice } from "./audioPost";
import { isConversation, planDialogueGroups, speakDialogue } from "./dialogue";
import type { CharacterFx } from "./characterFx";
import { characterPreset, DEFAULT_PRESETS, gapSeconds, interruptionOverlap, modelChain, presetFor, resolvePresets, type PresetId, type VoicePreset } from "./voicePresets";
import { db } from "./db";

/**
 * Narration engines. Each channel picks one:
 * - elevenlabs: most human, exact word timings, paid by characters per month
 * - gemini: very natural and can be directed with a style prompt; cheap, free tier has daily limits
 * - kokoro: open-source model that runs on this computer; free and unlimited (English)
 */
export type VoiceEngine = "elevenlabs" | "gemini" | "kokoro";

export interface VoiceChoice {
  engine: VoiceEngine;
  voiceId?: string;
  /** Gemini only: how to read the text, e.g. "slow, suspenseful documentary narrator". */
  style?: string;
}

export interface VoiceOption {
  id: string;
  name: string;
  description: string;
}

export const geminiConfigured = () => Boolean(process.env.GEMINI_API_KEY);

/** The engine a channel uses: its own choice, else Gemini, ElevenLabs or Kokoro, whichever is set up first. */
export function voiceFor(channel: Channel): VoiceChoice {
  const engine: VoiceEngine =
    channel.voiceEngine ?? (geminiConfigured() ? "gemini" : elevenConfigured() ? "elevenlabs" : "kokoro");
  // Without a style, Gemini reads neutrally; pick one that fits the channel's look.
  const style = channel.voiceStyle?.trim() || DEFAULT_STYLES[channel.look ?? "clean"];
  return { engine, voiceId: validVoice(engine, channel.voiceId), style };
}

export const DEFAULT_STYLES = {
  cinematic:
    "You are a seasoned true-crime documentary narrator. Speak in a low, intimate voice at a confident, steady pace that holds attention, a little faster than a slow read. Let tension build with short pauses before reveals, and drop your voice slightly on ominous lines. Never sound cheerful",
  warm: "You are a trusted friend who is good with money. Speak warmly and confidently at a relaxed pace, with a hint of a smile, emphasising the key numbers",
  clean: "You are an energetic but credible tech YouTuber. Speak clearly and briskly, with natural enthusiasm and emphasis on the most useful points",
} as const;

/**
 * A saved voice only applies to the engine it came from: an ElevenLabs voice ID sent to
 * Gemini fails. Anything that doesn't belong to the engine falls back to its default.
 */
function validVoice(engine: VoiceEngine, voiceId?: string) {
  if (!voiceId) return undefined;
  const isGemini = GEMINI_VOICES.some(([name]) => name === voiceId);
  const isKokoro = voiceId in KOKORO_VOICES;
  if (engine === "gemini") return isGemini ? voiceId : undefined;
  if (engine === "kokoro") return isKokoro ? voiceId : undefined;
  return isGemini || isKokoro ? undefined : voiceId;
}

export function engineReady(engine: VoiceEngine) {
  if (engine === "elevenlabs") return elevenConfigured();
  if (engine === "gemini") return geminiConfigured();
  return true;
}

export async function listVoices(engine: VoiceEngine): Promise<VoiceOption[]> {
  if (engine === "elevenlabs") return elevenConfigured() ? listElevenVoices() : [];
  if (engine === "gemini") return GEMINI_VOICES.map(([id, description]) => ({ id, name: id, description }));
  return Object.entries(KOKORO_VOICES).map(([id, [name, description]]) => ({ id, name, description }));
}

export interface SceneAudio {
  file: string;
  words: Word[];
  duration: number;
  /** Natural silence to leave after this scene, in seconds (the video maker falls back to a default) */
  gapAfter?: number;
  /** Seconds this line starts before its slot, because the character cuts in on the one before */
  overlap?: number;
}

/** How narrator scenes are spoken: which voice preset each uses, and which models to try. */
export interface NarrationOptions {
  format: "short" | "long";
  presets: Record<PresetId, VoicePreset>;
  /** Scenes that are key moments; on long videos they use the dramatic_reveal preset */
  keyMoments?: boolean[];
}

export const defaultNarration = (): NarrationOptions => ({ format: "long", presets: resolvePresets(db.voicePresets()) });

/** A scene spoken by a character from the channel's cast instead of the narrator. */
export interface CharacterLine {
  /** ElevenLabs voice ID */
  voiceId: string;
  /** Delivery cue such as "firm" or "whispering" */
  delivery?: string;
  /** The character's own voice settings */
  settings?: { stability?: number; style?: number; speed?: number };
  /** Sound treatment for their lines */
  fx?: CharacterFx;
}

const tagged = (text: string, delivery?: string) => {
  const cue = delivery?.replace(/[[\]]/g, "").trim();
  return cue ? `[${cue}] ${text}` : text;
};

/**
 * Narrates a list of scenes. Gemini and Kokoro read several scenes at once (up to about 45
 * seconds of speech), so the delivery flows and builds like one continuous narration
 * instead of restarting every sentence. The audio is then cut back into scenes at the
 * quietest moment near each scene boundary.
 *
 * Scenes with an entry in `characters` are acted by that character's ElevenLabs voice,
 * whatever engine the narrator uses.
 */
export async function synthesizeScenes(
  texts: string[],
  voice: VoiceChoice,
  outBase: string,
  onProgress: (done: number, total: number) => void,
  characters: (CharacterLine | undefined)[] = [],
  narration: NarrationOptions = defaultNarration(),
): Promise<SceneAudio[]> {
  const results: SceneAudio[] = [];
  const presetOf = (i: number) => narration.presets[presetFor({ keyMoment: narration.keyMoments?.[i] }, narration.format)];

  // Steps: a conversation (two or more characters in a row) is spoken as one dialogue request;
  // other character scenes on their own; narrator scenes one by one (ElevenLabs) or grouped.
  const steps: number[][] = [];
  const dialogueSteps = new Set<number[]>();
  const useDialogue = process.env.ELEVENLABS_DIALOGUE !== "off";
  for (let i = 0; i < texts.length; i++) {
    if (characters[i]) {
      let end = i;
      while (end + 1 < texts.length && characters[end + 1]) end++;
      const run = Array.from({ length: end - i + 1 }, (_, k) => i + k);
      const lines = run.map((j) => ({ voiceId: characters[j]!.voiceId, text: tagged(texts[j], characters[j]!.delivery) }));
      for (const group of useDialogue ? planDialogueGroups(lines) : run.map((_, k) => [k])) {
        const scenes = group.map((k) => run[k]);
        if (useDialogue && isConversation(lines, group)) {
          steps.push(scenes);
          dialogueSteps.add(scenes);
        } else for (const j of scenes) steps.push([j]);
      }
      i = end;
      continue;
    }
    const last = steps[steps.length - 1];
    const groupable = voice.engine !== "elevenlabs" && last && !characters[last[0]];
    const length = last ? last.reduce((n, j) => n + texts[j].length + 1, 0) : Infinity;
    if (groupable && length + texts[i].length <= MAX_CHUNK_CHARS) last.push(i);
    else steps.push([i]);
  }

  for (const [c, scenes] of steps.entries()) {
    onProgress(c, steps.length);
    const character = characters[scenes[0]];
    const modelsFor = () => modelChain(process.env, narration.format);
    const lineAt = async (i: number) =>
      speakCharacter(texts[i], characters[i]!, `${outBase}-${i}`, {
        models: modelsFor(),
        before: texts[i - 1],
        after: texts[i + 1],
        gapSeed: i * 8,
      });
    if (dialogueSteps.has(scenes)) {
      try {
        const clips = await speakDialogue(
          scenes.map((i) => ({ voiceId: characters[i]!.voiceId, text: tagged(texts[i], characters[i]!.delivery) })),
          `${outBase}-${scenes[0]}`,
          { seed: scenes[0] },
        );
        for (const [k, i] of scenes.entries()) {
          const file = `${outBase}-${i}.wav`;
          const duration = await applyFx(clips[k].file, file, characters[i]!.fx);
          fs.rmSync(clips[k].file, { force: true });
          // The dialogue model already paced the exchange, so only a breath is left between lines.
          results[i] = { file, duration, words: estimateWords(texts[i], duration), gapAfter: 0.12 };
        }
      } catch (err) {
        console.warn(`Dialogue mode failed, speaking the lines one at a time: ${(err as Error).message}`);
        for (const i of scenes) results[i] = await lineAt(i);
      }
      continue;
    }
    if (character) {
      results[scenes[0]] = await lineAt(scenes[0]);
      continue;
    }
    if (voice.engine === "elevenlabs") {
      const i = scenes[0];
      const preset = presetOf(i);
      // The narration either side of this scene gives its first and last sentences some context.
      const before = i > 0 && !characters[i - 1] ? texts[i - 1] : undefined;
      const after = i < texts.length - 1 && !characters[i + 1] ? texts[i + 1] : undefined;
      const spoken = await narrateWithEleven({
        text: texts[i],
        voiceId: voice.voiceId || DEFAULT_VOICE_ID,
        outBase: `${outBase}-${i}`,
        preset,
        models: modelChain(process.env, narration.format),
        before,
        after,
        gapSeed: i * 8,
      });
      results[i] = {
        file: spoken.file,
        duration: spoken.duration,
        words: spoken.words.length ? spoken.words : estimateWords(texts[i], spoken.duration),
        gapAfter: gapSeconds(preset, i * 8 + 7),
      };
      continue;
    }
    const text = scenes.map((i) => texts[i]).join(" ");
    const raw = voice.engine === "gemini" ? await geminiSpeak(text, voice) : await kokoroSpeak(text, voice.voiceId || DEFAULT_KOKORO);
    const samples = raw.samples instanceof Float32Array ? raw.samples : Float32Array.from(raw.samples, (v) => v / 32768);
    const cuts = sceneCuts(scenes.map((i) => texts[i]), samples, raw.rate);
    for (const [k, i] of scenes.entries()) {
      const part = samples.subarray(cuts[k], cuts[k + 1]);
      const file = `${outBase}-${i}.wav`;
      writeWav(file, part, raw.rate);
      const duration = part.length / raw.rate;
      results[i] = { file, words: estimateWords(texts[i], duration), duration, gapAfter: gapSeconds(presetOf(i), i * 8 + 7) };
    }
  }
  // A character who cuts in on the previous line starts slightly early, over its last moments.
  for (let i = 1; i < results.length; i++) {
    const own = results[i];
    if (!characters[i] || !own || !results[i - 1]) continue;
    const overlap = interruptionOverlap({ text: texts[i - 1], duration: results[i - 1].duration }, characters[i]!.delivery, own.duration);
    if (overlap > 0) {
      own.overlap = overlap;
      results[i - 1].gapAfter = 0;
    }
  }
  return results;
}

/**
 * A character's line in their own voice. The [delivery] cue is sent as an audio tag to models
 * that act on tags (v4, v3) and dropped for the rest. Like narration it is spoken sentence by
 * sentence with the neighbouring lines as context, trimmed to the speech, and then given the
 * character's sound treatment.
 */
export async function speakCharacter(
  text: string,
  line: CharacterLine,
  outBase: string,
  ctx: { models: string[]; before?: string; after?: string; gapSeed?: number },
): Promise<SceneAudio> {
  const preset = characterPreset(line.settings);
  const spoken = await narrateWithEleven({
    text: tagged(text, line.delivery),
    voiceId: line.voiceId,
    outBase,
    preset,
    models: ctx.models,
    before: ctx.before,
    after: ctx.after,
    gapSeed: ctx.gapSeed,
  });
  let file = spoken.file;
  let duration = spoken.duration;
  if (line.fx && line.fx !== "none") {
    const treated = `${outBase}-fx.wav`;
    duration = await applyFx(spoken.file, treated, line.fx);
    fs.renameSync(treated, spoken.file);
    file = spoken.file;
  }
  return {
    file,
    duration,
    words: spoken.words.length ? spoken.words : estimateWords(text, duration),
    gapAfter: gapSeconds(preset, (ctx.gapSeed ?? 0) + 7),
  };
}

const MAX_CHUNK_CHARS = 700;

/** Sample positions where each scene starts (plus the end), snapped to nearby pauses. */
function sceneCuts(texts: string[], samples: Float32Array, rate: number) {
  const weights = texts.map((t) => t.split(/\s+/).filter(Boolean).reduce((n, w) => n + wordWeight(w), 0));
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  const frame = Math.round(rate * 0.02);
  const energy = (at: number) => {
    let sum = 0;
    for (let i = at; i < Math.min(at + frame, samples.length); i++) sum += samples[i] * samples[i];
    return sum;
  };
  const cuts = [0];
  let acc = 0;
  for (let k = 0; k < texts.length - 1; k++) {
    acc += weights[k];
    const guess = Math.round((acc / total) * samples.length);
    // Look up to 0.4 s either side for the quietest moment: the pause between sentences.
    const window = Math.round(rate * 0.4);
    let best = guess;
    let bestEnergy = Infinity;
    for (let at = Math.max(cuts[k] + frame, guess - window); at <= Math.min(samples.length - frame, guess + window); at += frame) {
      const e = energy(at);
      if (e < bestEnergy) [best, bestEnergy] = [at, e];
    }
    cuts.push(best);
  }
  cuts.push(samples.length);
  return cuts;
}

const wordWeight = (t: string) => t.length + 1 + (/[.!?…]$/.test(t) ? 6 : /[,;:—-]$/.test(t) ? 3 : 0);

/** Writes narration for `text` next to `outBase` (extension added) and returns timings. */
export async function synthesize(text: string, voice: VoiceChoice, outBase: string) {
  if (voice.engine === "elevenlabs") {
    const file = `${outBase}.mp3`;
    const { words, duration } = await elevenSpeak(text, voice.voiceId || DEFAULT_VOICE_ID, file);
    return { file, words, duration };
  }
  const file = `${outBase}.wav`;
  const { samples, rate } =
    voice.engine === "gemini" ? await geminiSpeak(text, voice) : await kokoroSpeak(text, voice.voiceId || DEFAULT_KOKORO);
  writeWav(file, samples, rate);
  const duration = samples.length / rate;
  // These engines don't report word timings, so spread the words over the audio by length,
  // with extra weight for punctuation where the narrator pauses. Scenes are short, so this
  // stays close to the voice.
  return { file, words: estimateWords(text, duration), duration };
}

// ---------- Gemini ----------

const GEMINI_MODELS = ["gemini-3.1-flash-tts-preview", "gemini-2.5-flash-preview-tts"];

/** Gemini's prebuilt voices and their character. */
const GEMINI_VOICES: [string, string][] = [
  ["Charon", "Informative, deep (great for documentaries)"],
  ["Algenib", "Gravelly"],
  ["Gacrux", "Mature"],
  ["Iapetus", "Clear"],
  ["Orus", "Firm"],
  ["Alnilam", "Firm"],
  ["Rasalgethi", "Informative"],
  ["Sadaltager", "Knowledgeable"],
  ["Schedar", "Even"],
  ["Enceladus", "Breathy"],
  ["Fenrir", "Excitable"],
  ["Puck", "Upbeat"],
  ["Algieba", "Smooth"],
  ["Umbriel", "Easy-going"],
  ["Achird", "Friendly"],
  ["Zubenelgenubi", "Casual"],
  ["Kore", "Firm (female)"],
  ["Sulafat", "Warm (female)"],
  ["Vindemiatrix", "Gentle (female)"],
  ["Despina", "Smooth (female)"],
  ["Erinome", "Clear (female)"],
  ["Achernar", "Soft (female)"],
  ["Aoede", "Breezy (female)"],
  ["Leda", "Youthful (female)"],
  ["Zephyr", "Bright (female)"],
  ["Autonoe", "Bright (female)"],
  ["Callirrhoe", "Easy-going (female)"],
  ["Laomedeia", "Upbeat (female)"],
  ["Pulcherrima", "Forward (female)"],
  ["Sadachbia", "Lively (female)"],
];

let workingGeminiModel: string | undefined;

async function geminiSpeak(text: string, voice: VoiceChoice): Promise<{ samples: Int16Array; rate: number }> {
  // Gemini TTS takes a spoken instruction before the text ("Say cheerfully: ...").
  const prompt = voice.style?.trim() ? `${voice.style.trim().replace(/[:.]+$/, "")}:\n${text}` : text;
  const body = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice.voiceId || "Charon" } } },
    },
  });

  const models = workingGeminiModel ? [workingGeminiModel] : GEMINI_MODELS;
  for (const [i, model] of models.entries()) {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY ?? "" },
        body,
      });
      if (res.ok) {
        const data = await res.json();
        const part = data.candidates?.[0]?.content?.parts?.find((p: any) => p.inlineData?.data);
        if (!part) throw new Error("Gemini returned no audio. Try again, or shorten the scene.");
        workingGeminiModel = model;
        const rate = Number(/rate=(\d+)/.exec(part.inlineData.mimeType ?? "")?.[1] ?? 24000);
        const bytes = Buffer.from(part.inlineData.data, "base64");
        const samples = new Int16Array(Math.floor(bytes.length / 2));
        for (let s = 0; s < samples.length; s++) samples[s] = bytes.readInt16LE(s * 2);
        return { samples, rate };
      }

      const err = await res.json().catch(() => ({}));
      const message: string = err?.error?.message ?? `HTTP ${res.status}`;
      // Model not available to this key: try the next one.
      if (res.status === 404 && i < models.length - 1) break;
      if (res.status === 400 && /api key/i.test(message)) {
        throw new Error("Your Gemini API key was rejected. Create a new one at aistudio.google.com and paste it on the Setup page.");
      }
      if (res.status === 429) {
        const retry = err?.error?.details?.find((d: any) => d.retryDelay)?.retryDelay;
        const seconds = retry ? parseFloat(retry) : NaN;
        // Per-minute limits clear quickly: wait and retry. Daily limits don't.
        if (attempt < 4 && (Number.isNaN(seconds) ? attempt < 2 : seconds <= 65)) {
          await new Promise((r) => setTimeout(r, (Number.isNaN(seconds) ? 20 : seconds + 1) * 1000));
          continue;
        }
        throw new Error(
          "Gemini voice limit reached (the free tier allows only a few voice requests per day). Turn on billing in Google AI Studio, or set this channel's voice engine to Kokoro (free) under Edit channel.",
        );
      }
      if (res.status >= 500 && attempt < 2) {
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }
      throw new Error(`Gemini voice error: ${message}`);
    }
  }
  throw new Error("No Gemini voice model is available for this key.");
}

// ---------- Kokoro (runs locally) ----------

const DEFAULT_KOKORO = "am_michael";

/** English Kokoro voices worth using (the lowest-rated ones are left out). */
const KOKORO_VOICES: Record<string, [string, string]> = {
  am_michael: ["Michael", "American male, calm narrator"],
  am_fenrir: ["Fenrir", "American male, deep"],
  am_puck: ["Puck", "American male, lively"],
  bm_george: ["George", "British male, storyteller"],
  bm_fable: ["Fable", "British male, warm"],
  bm_lewis: ["Lewis", "British male, low"],
  af_heart: ["Heart", "American female, best quality"],
  af_bella: ["Bella", "American female, expressive"],
  af_nicole: ["Nicole", "American female, soft"],
  af_sarah: ["Sarah", "American female, clear"],
  bf_emma: ["Emma", "British female, clear"],
  bf_isabella: ["Isabella", "British female"],
};

let kokoro: Promise<any> | undefined;

/** Loads the model once. The first time, it downloads it (about 90 MB) into data/models. */
function loadKokoro() {
  kokoro ??= (async () => {
    const { env } = await import("@huggingface/transformers");
    env.cacheDir = path.join(DATA_DIR, "models");
    const { KokoroTTS, TextSplitterStream } = await import("kokoro-js");
    const tts = await KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-v1.0-ONNX", { dtype: "q8", device: "cpu" });
    return { tts, TextSplitterStream };
  })().catch((err) => {
    kokoro = undefined;
    throw new Error(
      `Couldn't load the free Kokoro voice: ${(err as Error).message}. The first use needs internet to download the voice model.`,
    );
  });
  return kokoro;
}

async function kokoroSpeak(text: string, voiceId: string): Promise<{ samples: Float32Array; rate: number }> {
  const { tts, TextSplitterStream } = await loadKokoro();
  const voice = voiceId in KOKORO_VOICES ? voiceId : DEFAULT_KOKORO;
  // Speak sentence by sentence so nothing is cut off by the model's input limit. The splitter
  // must be closed: a plain string passed to stream() waits forever for its last sentence.
  const splitter = new TextSplitterStream();
  splitter.push(text);
  splitter.close();
  const chunks: Float32Array[] = [];
  let rate = 24000;
  for await (const { audio } of tts.stream(splitter, { voice })) {
    chunks.push(audio.audio);
    rate = audio.sampling_rate;
  }
  const samples = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const c of chunks) {
    samples.set(c, offset);
    offset += c.length;
  }
  return { samples, rate };
}

// ---------- Helpers ----------

/** Writes mono 16-bit PCM WAV from 16-bit ints or -1..1 floats. */
function writeWav(file: string, samples: Int16Array | Float32Array, rate: number) {
  const pcm = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const v = samples instanceof Float32Array ? Math.max(-1, Math.min(1, samples[i])) * 32767 : samples[i];
    pcm.writeInt16LE(Math.round(v), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  fs.writeFileSync(file, Buffer.concat([header, pcm]));
}

export function estimateWords(text: string, duration: number): Word[] {
  const tokens = text.split(/\s+/).filter(Boolean);
  if (!tokens.length || duration <= 0) return [];
  const weight = wordWeight;
  const total = tokens.reduce((n, t) => n + weight(t), 0);
  const lead = Math.min(0.1, duration * 0.02);
  const span = Math.max(duration - lead * 2, 0.1);
  let t = lead;
  return tokens.map((token) => {
    const length = (span * weight(token)) / total;
    const word = { text: token, start: t, end: t + length * 0.85 };
    t += length;
    return word;
  });
}

/** About 20 seconds at documentary pace. Three scenes, like a real script. */
export const PREVIEW_SCENES = [
  "In the winter of 1959, nine hikers vanished in the mountains. What they left behind has puzzled investigators ever since.",
  "A tent, cut open from the inside. Boots left in the snow. And a final photograph that nobody can fully explain.",
  "Tonight, we follow their footsteps, one at a time. Stay with me.",
];

export interface VoicePreview {
  file: string;
  /** Seconds */
  duration: number;
  wpm: number;
  /** Integrated loudness after mastering */
  lufs: number;
  preset: PresetId;
}

/**
 * A ~20 second sample for the "Preview" button, made with the same steps as a real video:
 * sentence chunks, natural gaps and voice mastering. `presetId` picks which preset to hear.
 */
export async function previewVoice(voice: VoiceChoice, dir: string, presetId: PresetId = "documentary_narration"): Promise<VoicePreview> {
  fs.mkdirSync(dir, { recursive: true });
  const presets = resolvePresets(db.voicePresets());
  const chosen = presets[presetId] ?? DEFAULT_PRESETS.documentary_narration;
  // Every kind of scene uses the chosen preset, so the sample is exactly what it will sound like.
  const narration: NarrationOptions = {
    format: "long",
    presets: { documentary_narration: chosen, dramatic_reveal: chosen, fast_short: chosen },
  };
  const base = path.join(dir, `preview-${Date.now()}`);
  const scenes = await synthesizeScenes(PREVIEW_SCENES, voice, base, () => {}, [], narration);
  const joined = `${base}-joined.wav`;
  await joinWithGaps(scenes.map((s) => s.file), scenes.map((s) => s.gapAfter ?? 0.25), joined);
  const file = `${base}.wav`;
  const { after } = await masterVoice(joined, file);
  const duration = await audioDuration(file);
  for (const f of [joined, ...scenes.map((s) => s.file)]) fs.rmSync(f, { force: true });
  return { file, duration, wpm: wordsPerMinute(PREVIEW_SCENES.join(" "), duration), lufs: after.input_i, preset: presetId };
}
