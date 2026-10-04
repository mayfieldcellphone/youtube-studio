import type { CastMember, Channel } from "./db";

/**
 * Character dialogue in scripts. A line that starts with an uppercase speaker label is spoken
 * by that character in their own voice; every other line is the narrator:
 *
 *   NARRATOR: In March 1431, the court read out Article 7.
 *   PROSECUTOR: [cold] You carried a mandrake, hoping it would bring you riches.
 *   JOAN: [firm] I deny it entirely.
 *
 * The optional [cue] straight after the label is a delivery direction for the voice, not a
 * visual direction.
 */
export const NARRATOR = "NARRATOR";

/** "JOAN OF ARC:" at the start of a line: up to 40 capital letters, spaces and . ' - (no digits, so "AD 1431:" stays narration). */
const LABEL = /^\s*([A-Z][A-Z .'’-]{0,39}):\s*/;

/** Same comparison for labels in scripts and names in the channel's cast. */
export const speakerKey = (name: string) =>
  name
    .trim()
    .toUpperCase()
    .replace(/[’']/g, "'")
    .replace(/\s+/g, " ");

export interface DialogueLine {
  speaker: string;
  /** Delivery cue such as "firm" or "whispering", without brackets */
  delivery: string;
  text: string;
}

/** Splits one script line into speaker, delivery cue and spoken text. */
export function parseLine(line: string): DialogueLine {
  const match = LABEL.exec(line);
  const speaker = match ? speakerKey(match[1]) : NARRATOR;
  let rest = match ? line.slice(match[0].length) : line.trim();
  let delivery = "";
  const cue = /^\[([^\]]{1,40})\]\s*/.exec(rest);
  if (match && cue) {
    delivery = cue[1].trim();
    rest = rest.slice(cue[0].length);
  }
  return { speaker, delivery, text: rest.trim() };
}

/** Speaker labels used in a script, other than the narrator. */
export function scriptSpeakers(script: string) {
  const found = new Set<string>();
  for (const line of script.split(/\n+/)) {
    const { speaker } = parseLine(line);
    if (speaker !== NARRATOR) found.add(speaker);
  }
  return [...found];
}

/** The cast member for a speaker label, if the channel has one with a voice. */
export function castVoice(channel: Channel, speaker: string): CastMember | undefined {
  const key = speakerKey(speaker || NARRATOR);
  if (key === NARRATOR) return undefined;
  return channel.cast?.find((c) => c.voiceId && speakerKey(c.name) === key);
}

/** Removes [audio tags] that ElevenLabs v3 reads as directions, so they don't appear in captions. */
export const isAudioTag = (word: string) => /^\[[^\]]*\]?[.,!?]*$/.test(word) || /^[^[]*\]$/.test(word);
