import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, type Channel } from "./db";
import { DEFAULT_VOICE_ID, elevenSpeak, listVoices as listElevenVoices, voiceConfigured as elevenConfigured, type Word } from "./media";

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

/** The engine a channel uses: its own choice, else the first one that's set up. */
export function voiceFor(channel: Channel): VoiceChoice {
  const engine: VoiceEngine =
    channel.voiceEngine ?? (elevenConfigured() ? "elevenlabs" : geminiConfigured() ? "gemini" : "kokoro");
  return { engine, voiceId: channel.voiceId || undefined, style: channel.voiceStyle || undefined };
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
  const weight = (t: string) => t.length + 1 + (/[.!?…]$/.test(t) ? 6 : /[,;:—-]$/.test(t) ? 3 : 0);
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
