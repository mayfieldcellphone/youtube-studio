import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, type Channel } from "./db";
import { DEFAULT_VOICE_ID, ELEVEN_ACTING_MODEL, elevenSpeak, listVoices as listElevenVoices, voiceConfigured as elevenConfigured, type Word } from "./media";

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
    "You are a seasoned true-crime documentary narrator. Speak in a low, calm, intimate voice at a slow pace. Let tension build, pause briefly before reveals, and drop your voice slightly on ominous lines. Never sound cheerful",
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
}

/** A scene spoken by a character from the channel's cast instead of the narrator. */
export interface CharacterLine {
  /** ElevenLabs voice ID */
  voiceId: string;
  /** Delivery cue such as "firm" or "whispering" */
  delivery?: string;
}

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
): Promise<SceneAudio[]> {
  const results: SceneAudio[] = [];

  // Steps: each character scene on its own; narrator scenes one by one (ElevenLabs) or grouped.
  const steps: number[][] = [];
  for (const [i, text] of texts.entries()) {
    const last = steps[steps.length - 1];
    const groupable = voice.engine !== "elevenlabs" && !characters[i] && last && !characters[last[0]];
    const length = last ? last.reduce((n, j) => n + texts[j].length + 1, 0) : Infinity;
    if (groupable && length + text.length <= MAX_CHUNK_CHARS) last.push(i);
    else steps.push([i]);
  }

  for (const [c, scenes] of steps.entries()) {
    onProgress(c, steps.length);
    const character = characters[scenes[0]];
    if (character) {
      results[scenes[0]] = await speakCharacter(texts[scenes[0]], character, `${outBase}-${scenes[0]}`);
      continue;
    }
    if (voice.engine === "elevenlabs") {
      results[scenes[0]] = await synthesize(texts[scenes[0]], voice, `${outBase}-${scenes[0]}`);
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
      results[i] = { file, words: estimateWords(texts[i], duration), duration };
    }
  }
  return results;
}

/**
 * A character's line in their own voice. Eleven v3 acts the [delivery] cue; if this account
 * can't use v3, the line is read with the narration model without the cue.
 */
export async function speakCharacter(text: string, line: CharacterLine, outBase: string): Promise<SceneAudio> {
  const file = `${outBase}.mp3`;
  const cue = line.delivery?.replace(/[[\]]/g, "").trim();
  if (!actingModelFailed) {
    try {
      return { file, ...(await elevenSpeak(cue ? `[${cue}] ${text}` : text, line.voiceId, file, ELEVEN_ACTING_MODEL)) };
    } catch (err) {
      console.warn(`Eleven v3 unavailable for character lines, using the narration model: ${(err as Error).message}`);
      // Don't try v3 again for every line of this video; retry on the next one.
      actingModelFailed = true;
      setTimeout(() => (actingModelFailed = false), 10 * 60 * 1000).unref();
    }
  }
  return { file, ...(await elevenSpeak(text, line.voiceId, file)) };
}

let actingModelFailed = false;

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

/** A short sample in the chosen voice for the "Preview" button. */
export async function previewVoice(voice: VoiceChoice, dir: string) {
  const text =
    "In the winter of 1959, nine hikers vanished in the mountains. What they left behind has puzzled investigators ever since.";
  fs.mkdirSync(dir, { recursive: true });
  const { file } = await synthesize(text, voice, path.join(dir, `preview-${Date.now()}`));
  return file;
}
