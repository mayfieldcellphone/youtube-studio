import fs from "node:fs";
import { eleven, ElevenError, type Word } from "./media";
import { trimClip } from "./audioPost";
import { LEAD_IN, TAIL_OUT } from "./narration";

/**
 * Multi-speaker dialogue in one ElevenLabs request (Text to Dialogue). The model hears the
 * whole exchange, so turn-taking, pacing and emotion carry between speakers. The result is cut
 * back into one clip per line using the segment timings the API returns.
 *
 * Limits from the API: at most 10 distinct voices and about 2,000 characters per request.
 */
export const DIALOGUE_MODEL = "eleven_v3";
export const MAX_DIALOGUE_VOICES = 10;
export const MAX_DIALOGUE_CHARS = 1800; // under the documented 2,000, leaving room for tags

export interface DialogueLine {
  voiceId: string;
  /** Text with its [emotion] audio tag in front */
  text: string;
}

export interface DialogueClip {
  file: string;
  /** Length of the clip in seconds */
  duration: number;
}

/**
 * Groups consecutive lines into requests the API accepts. A group needs two or more different
 * voices to be worth sending as dialogue; a lone speaker is left to the per-line path.
 * Returns groups of indexes into `lines`.
 */
export function planDialogueGroups(lines: DialogueLine[]): number[][] {
  const groups: number[][] = [];
  let current: number[] = [];
  let voices = new Set<string>();
  let chars = 0;
  const flush = () => {
    if (current.length) groups.push(current);
    current = [];
    voices = new Set();
    chars = 0;
  };
  for (const [i, line] of lines.entries()) {
    const nextVoices = new Set(voices).add(line.voiceId);
    if (current.length && (nextVoices.size > MAX_DIALOGUE_VOICES || chars + line.text.length > MAX_DIALOGUE_CHARS)) flush();
    current.push(i);
    voices.add(line.voiceId);
    chars += line.text.length;
  }
  flush();
  return groups;
}

/** True when a group has at least two speakers and so benefits from dialogue mode. */
export const isConversation = (lines: DialogueLine[], group: number[]) => new Set(group.map((i) => lines[i].voiceId)).size >= 2;

interface Segment {
  index: number;
  start: number;
  end: number;
}

/** Reads the per-input timings out of a with-timestamps dialogue response. */
export function segmentsFrom(data: { voice_segments?: Record<string, unknown>[] }, count: number): Segment[] {
  const out: Segment[] = [];
  for (const s of data.voice_segments ?? []) {
    const index = Number(s.dialogue_input_index);
    const start = Number(s.start_time_seconds);
    const end = Number(s.end_time_seconds);
    if (!Number.isInteger(index) || index < 0 || index >= count || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    const seen = out.find((o) => o.index === index);
    if (seen) seen.end = Math.max(seen.end, end);
    else out.push({ index, start, end });
  }
  return out;
}

/**
 * Speaks a group of lines as one conversation and writes one clip per line next to `outBase`.
 * Throws if the API refuses or doesn't return timings for every line, so the caller can fall
 * back to speaking the lines one at a time.
 */
export async function speakDialogue(lines: DialogueLine[], outBase: string, opts: { model?: string; seed?: number } = {}): Promise<DialogueClip[]> {
  const body = {
    inputs: lines.map((l) => ({ text: l.text, voice_id: l.voiceId })),
    model_id: opts.model ?? DIALOGUE_MODEL,
    ...(opts.seed !== undefined ? { seed: opts.seed } : {}),
  };
  const data = await eleven("/v1/text-to-dialogue/with-timestamps?output_format=mp3_44100_128", { method: "POST", body: JSON.stringify(body) });
  if (!data?.audio_base64) throw new Error("The dialogue request returned no audio.");
  const segments = segmentsFrom(data, lines.length);
  if (segments.length !== lines.length) throw new Error("The dialogue request didn't return timings for every line.");

  const raw = `${outBase}-dialogue.mp3`;
  fs.writeFileSync(raw, Buffer.from(data.audio_base64, "base64"));
  const clips: DialogueClip[] = [];
  try {
    for (const seg of segments.sort((a, b) => a.index - b.index)) {
      const file = `${outBase}-d${seg.index}.wav`;
      const duration = await trimClip(raw, file, { start: Math.max(0, seg.start - LEAD_IN), end: seg.end + TAIL_OUT });
      clips[seg.index] = { file, duration };
    }
  } finally {
    fs.rmSync(raw, { force: true });
  }
  return clips;
}

export { ElevenError };
export type { Word };
