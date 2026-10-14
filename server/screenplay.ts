import { NARRATOR, speakerKey } from "./speakers";

/**
 * Screenplay-style scripts. One line, one event:
 *
 *   [NARRATOR] In 1926 the most famous escape artist in the world walked into a hospital.
 *   [HOUDINI | tired, whispering] I can still feel the blow.
 *   [BESS | tender] Rest, Harry.
 *   [SFX: train whistle]
 *   [MUSIC: low strings, tense]
 *   [PAUSE: 600ms]
 *   [DRAMATIZED] [HOUDINI | firm] I have never feared a locked door.
 *   [HOUDINI | firm] [SOURCE: letter, 1924] The words in a letter that survives.
 *
 * The older format ("JOAN: [firm] I deny it.") is still read. Any other bracketed line is a
 * visual direction and is not spoken. Character lines are dramatised unless they carry a
 * [SOURCE: ...] tag naming where the words are recorded.
 */

export type ScreenplayEvent =
  | { kind: "speech"; speaker: string; emotion: string; text: string; dramatized: boolean; source?: string }
  | { kind: "sfx"; text: string }
  | { kind: "music"; text: string }
  | { kind: "ambience"; text: string }
  | { kind: "chapter"; text: string }
  | { kind: "pause"; ms: number }
  | { kind: "direction"; text: string };

const RESERVED = new Set(["SFX", "MUSIC", "PAUSE", "AMBIENCE", "AMBIENT", "CHAPTER", "DRAMATIZED", "DRAMATISED", "SOURCE"]);
/** "[HOUDINI | tired]" or "[BESS]": a speaker label in capitals with an optional emotion. */
const SPEAKER_TAG = /^\[\s*([A-Z][A-Z0-9 .'’-]{0,39}?)\s*(?:\|\s*([^\]]{1,60}))?\]\s*/;
const LEGACY_LABEL = /^\s*([A-Z][A-Z .'’-]{0,39}):\s*/;
const MAX_PAUSE_MS = 5000;

/** "600ms", "1.2s", "600" (ms) to milliseconds, capped so a typo can't stall a video. */
export function parsePause(spec: string): number {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|sec|seconds?)?\s*$/i.exec(spec);
  if (!m) return 0;
  const n = Number(m[1]);
  const ms = m[2] && m[2].toLowerCase() !== "ms" ? n * 1000 : n;
  return Math.min(MAX_PAUSE_MS, Math.max(0, Math.round(ms)));
}

/** Reads the directive tags ([DRAMATIZED], [SOURCE: ...]) off the front of a line's text. */
function stripFlags(rest: string) {
  let dramatized: boolean | undefined;
  let source: string | undefined;
  let text = rest;
  for (;;) {
    const flag = /^\[\s*(DRAMATI[ZS]ED)\s*\]\s*/i.exec(text);
    if (flag) { dramatized = true; text = text.slice(flag[0].length); continue; }
    const src = /^\[\s*SOURCE\s*:\s*([^\]]{1,120})\]\s*/i.exec(text);
    if (src) { source = src[1].trim(); text = text.slice(src[0].length); continue; }
    return { text: text.trim(), dramatized, source };
  }
}

/** Parses one script line into an event, or null for a blank line. */
export function parseScreenplayLine(raw: string): ScreenplayEvent | null {
  let line = raw.trim();
  if (!line) return null;

  // [DRAMATIZED] in front of a speaker tag marks that line only.
  const lead = stripFlags(line);
  const leadSource = lead.source;
  line = lead.text;
  if (!line) return null;

  const directive = /^\[\s*(SFX|MUSIC|PAUSE|AMBIENCE|AMBIENT|CHAPTER)\s*:\s*([^\]]*)\]\s*$/i.exec(line);
  if (directive) {
    const kind = directive[1].toUpperCase();
    if (kind === "PAUSE") {
      const ms = parsePause(directive[2]);
      return ms > 0 ? { kind: "pause", ms } : null;
    }
    const text = directive[2].trim();
    if (!text) return null;
    if (kind === "SFX") return { kind: "sfx", text };
    if (kind === "MUSIC") return { kind: "music", text };
    if (kind === "CHAPTER") return { kind: "chapter", text };
    return { kind: "ambience", text };
  }

  const tag = SPEAKER_TAG.exec(line);
  if (tag && !RESERVED.has(speakerKey(tag[1]))) {
    const after = stripFlags(line.slice(tag[0].length));
    if (after.text) {
      const speaker = speakerKey(tag[1]);
      const isNarrator = speaker === NARRATOR;
      return {
        kind: "speech",
        speaker,
        emotion: isNarrator ? "" : (tag[2] ?? "").trim(),
        text: after.text,
        // Narration is the documentary voice; everyone else is a reconstruction unless sourced.
        dramatized: !isNarrator && !(after.source ?? leadSource),
        source: after.source ?? leadSource,
      };
    }
    // "[NARRATOR]" or "[WIDE SHOT]" with nothing after it: a direction, not speech.
  }

  const label = LEGACY_LABEL.exec(line);
  if (label) {
    const speaker = speakerKey(label[1]);
    let rest = line.slice(label[0].length);
    let emotion = "";
    const cue = /^\[([^\]]{1,40})\]\s*/.exec(rest);
    if (cue) { emotion = cue[1].trim(); rest = rest.slice(cue[0].length); }
    const after = stripFlags(rest);
    if (after.text) {
      const isNarrator = speaker === NARRATOR;
      return {
        kind: "speech",
        speaker,
        emotion: isNarrator ? "" : emotion,
        text: after.text,
        dramatized: !isNarrator && !(after.source ?? leadSource),
        source: after.source ?? leadSource,
      };
    }
  }

  // A line that is only brackets is a visual direction.
  if (/^\[[^\]]*\]$/.test(line)) return { kind: "direction", text: line.slice(1, -1).trim() };
  // Anything else is narration. A [DRAMATIZED] flag in front of plain narration does nothing.
  return { kind: "speech", speaker: NARRATOR, emotion: "", text: line, dramatized: false };
}

export function parseScreenplay(script: string): ScreenplayEvent[] {
  return script
    .split(/\n+/)
    .map(parseScreenplayLine)
    .filter((e): e is ScreenplayEvent => e !== null);
}

/** Speaker labels other than the narrator, in order of first appearance. */
export function screenplaySpeakers(script: string): string[] {
  const found = new Set<string>();
  for (const e of parseScreenplay(script)) if (e.kind === "speech" && e.speaker !== NARRATOR) found.add(e.speaker);
  return [...found];
}

/** Share of the spoken words that belong to characters rather than the narrator, 0-1. */
export function dialogueShare(events: ScreenplayEvent[]): number {
  const words = (t: string) => t.split(/\s+/).filter(Boolean).length;
  let total = 0;
  let dialogue = 0;
  for (const e of events) {
    if (e.kind !== "speech") continue;
    const n = words(e.text);
    total += n;
    if (e.speaker !== NARRATOR) dialogue += n;
  }
  return total ? dialogue / total : 0;
}

/** Cues that sit between spoken lines, anchored to the line that follows them. */
export interface Cue {
  kind: "sfx" | "music" | "ambience" | "chapter" | "pause";
  text?: string;
  ms?: number;
  /** First words of the spoken line this cue comes before; empty when it trails the script */
  before: string;
}

export interface PreparedScript {
  /** The script as the scene planner reads it: spoken lines only, "NAME: [emotion] text" */
  spoken: string;
  cues: Cue[];
  /** Spoken lines that are reconstructions, as normalised labels + the first words of the line */
  dramatizedLines: number;
  speakers: string[];
}

const firstWords = (t: string, n = 6) => t.replace(/\[[^\]]*\]/g, " ").split(/\s+/).filter(Boolean).slice(0, n).join(" ");

/**
 * Turns a screenplay into what the scene planner understands (spoken lines in the labelled
 * "NAME: [cue] text" form) plus the sound cues, each anchored to the line it precedes.
 * Visual directions are kept as bracketed lines for the planner.
 */
export function prepareScript(script: string): PreparedScript {
  const events = parseScreenplay(script);
  const lines: string[] = [];
  const cues: Cue[] = [];
  const pending: Omit<Cue, "before">[] = [];
  let dramatizedLines = 0;
  for (const e of events) {
    if (e.kind === "sfx" || e.kind === "music" || e.kind === "ambience" || e.kind === "chapter") pending.push({ kind: e.kind, text: e.text });
    else if (e.kind === "pause") pending.push({ kind: "pause", ms: e.ms });
    else if (e.kind === "direction") lines.push(`[${e.text}]`);
    else {
      for (const p of pending.splice(0)) cues.push({ ...p, before: firstWords(e.text) });
      if (e.dramatized) dramatizedLines++;
      lines.push(e.speaker === NARRATOR ? e.text : `${e.speaker}: ${e.emotion ? `[${e.emotion}] ` : ""}${e.text}`);
    }
  }
  for (const p of pending) cues.push({ ...p, before: "" });
  return { spoken: lines.join("\n"), cues, dramatizedLines, speakers: screenplaySpeakers(script) };
}

const norm = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, " ").replace(/\s+/g, " ").trim();

/**
 * Finds the scene each cue belongs to: the first scene (from the previous cue's scene onwards)
 * whose narration contains the start of the line the cue precedes. Trailing cues attach to the
 * last scene. Returns scene indexes; a cue whose line can't be found goes to the same scene as
 * the one before it.
 */
export function anchorCues(cues: Cue[], narrations: string[]): number[] {
  const scenes = narrations.map(norm);
  const out: number[] = [];
  let from = 0;
  for (const cue of cues) {
    if (!cue.before) { out.push(Math.max(0, scenes.length - 1)); continue; }
    const key = norm(cue.before);
    let found = -1;
    for (let i = from; i < scenes.length && found < 0; i++) if (scenes[i].includes(key)) found = i;
    // The planner may reword the opening of a line; match on its first three words instead.
    if (found < 0) {
      const short = key.split(" ").slice(0, 3).join(" ");
      for (let i = from; i < scenes.length && found < 0; i++) if (short && scenes[i].includes(short)) found = i;
    }
    if (found < 0) found = Math.min(from, Math.max(0, scenes.length - 1));
    out.push(found);
    from = found;
  }
  return out;
}
