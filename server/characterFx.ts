/**
 * Sound treatment for a character's lines, so voices sit in different spaces and don't all
 * sound like they were recorded in the same booth. Pure data: audioPost.ts applies it.
 */
export const CHARACTER_FX = ["none", "warm", "close", "hall", "radio"] as const;
export type CharacterFx = (typeof CHARACTER_FX)[number];

export const FX_LABELS: Record<CharacterFx, string> = {
  none: "None",
  warm: "Warm (rounder, softer top end)",
  close: "Close and intimate (whisper-friendly)",
  hall: "Large room (courtroom, church, hall)",
  radio: "Telephone / old radio",
};

/** FFmpeg audio filters for each treatment; an empty list leaves the voice as recorded. */
export const FX_FILTERS: Record<CharacterFx, string[]> = {
  none: [],
  warm: ["equalizer=f=220:t=q:w=1:g=2", "equalizer=f=5000:t=q:w=1:g=-2.5"],
  close: ["equalizer=f=140:t=q:w=1:g=3", "acompressor=threshold=-26dB:ratio=3:attack=5:release=90"],
  hall: ["aecho=0.8:0.6:70|140:0.22|0.12"],
  radio: ["highpass=f=320", "lowpass=f=3300", "acompressor=threshold=-18dB:ratio=4:attack=5:release=80", "volume=1.2"],
};

export const isCharacterFx = (v: unknown): v is CharacterFx => typeof v === "string" && (CHARACTER_FX as readonly string[]).includes(v);
