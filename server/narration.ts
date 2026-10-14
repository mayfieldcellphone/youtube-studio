import fs from "node:fs";
import { contextSupported, speakChunk, usableModels, type Word } from "./media";
import { chunkForSpeech, contextFor } from "./ttsChunks";
import { audioDuration, joinWithGaps, trimClip } from "./audioPost";
import { gapSeconds, type VoicePreset } from "./voicePresets";

/** Seconds of breath kept before the first word and of decay kept after the last one. */
export const LEAD_IN = 0.04;
export const TAIL_OUT = 0.09;

export interface NarrationRequest {
  text: string;
  voiceId: string;
  /** Output path without extension; a .wav is written */
  outBase: string;
  preset: VoicePreset;
  /** ElevenLabs models to try, in order */
  models: string[];
  /** Narration just before and after this scene, so the first and last sentences have context */
  before?: string;
  after?: string;
  /** Running number used for deterministic gaps */
  gapSeed?: number;
}

export interface NarrationResult {
  file: string;
  words: Word[];
  /** Length of the speech in seconds, with the gaps between its sentences */
  duration: number;
  models: string[];
  chunks: number;
}

/**
 * Narrates one scene in ElevenLabs. The text is split into sentences, each is spoken with the
 * sentences either side as context, trimmed to its speech using the word timings, and joined
 * with short natural gaps. Caption timings are carried through the trimming and tempo change.
 */
export async function narrateWithEleven(req: NarrationRequest): Promise<NarrationResult> {
  // A model that can't take context is better given the whole scene than disconnected sentences.
  // What matters is the model that will actually speak, the first one still available.
  const speaker = usableModels(req.models)[0] ?? req.models[0];
  const canStitch = contextSupported(speaker);
  const chunks = canStitch ? chunkForSpeech(req.text) : [req.text.replace(/\s+/g, " ").trim()];
  if (!chunks.length || !chunks[0]) throw new Error("This scene has no text to speak.");

  const tempo = req.preset.tempo;
  const raws: string[] = [];
  const trimmed: string[] = [];
  const spoken: { words: Word[]; trimStart: number; length: number; model: string }[] = [];
  try {
    for (const [k, chunk] of chunks.entries()) {
      const raw = `${req.outBase}-c${k}.mp3`;
      raws.push(raw);
      const ctx = contextFor(chunks, k, req.before, req.after);
      const speech = await speakChunk(chunk, req.voiceId, raw, {
        models: req.models,
        preset: req.preset,
        previousText: ctx.previousText,
        nextText: ctx.nextText,
      });
      const clip = `${req.outBase}-c${k}.wav`;
      trimmed.push(clip);
      const hasTimings = speech.speechStart !== undefined && speech.speechEnd !== undefined;
      const trimStart = hasTimings ? Math.max(0, speech.speechStart! - LEAD_IN) : 0;
      const length = await trimClip(raw, clip, {
        start: trimStart,
        end: hasTimings ? speech.speechEnd! + TAIL_OUT : undefined,
        tempo,
      });
      spoken.push({ words: speech.words, trimStart, length, model: speech.model });
    }

    const seed = req.gapSeed ?? 0;
    const gaps = chunks.slice(0, -1).map((_, k) => gapSeconds(req.preset, seed + k));
    const file = `${req.outBase}.wav`;
    const duration = await joinWithGaps(trimmed, gaps, file);

    // Move each chunk's word timings to where that chunk now sits in the joined audio.
    const words: Word[] = [];
    let offset = 0;
    for (const [k, chunk] of spoken.entries()) {
      for (const w of chunk.words) {
        const start = offset + Math.max(0, (w.start - chunk.trimStart) / tempo);
        const end = offset + Math.max(0, (w.end - chunk.trimStart) / tempo);
        words.push({ text: w.text, start, end: Math.max(end, start + 0.02) });
      }
      offset += chunk.length + (gaps[k] ?? 0);
    }
    return { file, words, duration, models: [...new Set(spoken.map((s) => s.model))], chunks: chunks.length };
  } finally {
    for (const f of [...raws, ...trimmed]) fs.rmSync(f, { force: true });
  }
}

/** Words per minute for a spoken text and its length in seconds. */
export function wordsPerMinute(text: string, seconds: number) {
  const words = text.replace(/\[[^\]]*\]/g, " ").split(/\s+/).filter(Boolean).length;
  return seconds > 0 ? Math.round((words / seconds) * 60) : 0;
}

export { audioDuration };
