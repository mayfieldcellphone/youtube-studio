/**
 * Voice presets for ElevenLabs narration, one per kind of scene, plus the model fallback chain.
 *
 * The numbers below are STARTING POINTS taken from ElevenLabs' documented ranges (speed
 * 0.7-1.2, lower stability = more expressive). They have not been tuned by listening: use
 * Voice presets on the Setup page, the Preview button, and `npm run voice:bench`, then save
 * the values that sound right. Saved values override these defaults.
 */

export type PresetId = "documentary_narration" | "dramatic_reveal" | "fast_short";

export const PRESET_IDS: PresetId[] = ["documentary_narration", "dramatic_reveal", "fast_short"];

export interface VoicePreset {
  label: string;
  description: string;
  /** 0-1. Lower = more emotional range, higher = steadier. */
  stability: number;
  /** 0-1 */
  similarity: number;
  /** 0-1 style exaggeration. Costs a little latency, not supported by every model. */
  style: number;
  /** 0.7-1.2, ElevenLabs' documented range. 1.0 is the voice's natural pace. */
  speed: number;
  /** Natural silence between sentences and scenes, in milliseconds (min, max). */
  gapMs: [number, number];
  /**
   * Optional tempo applied after generation with FFmpeg's atempo (pitch is preserved).
   * Clamped to 1.00-1.08. Leave at 1 unless the voice still sounds slow.
   */
  tempo: number;
}

export const DEFAULT_PRESETS: Record<PresetId, VoicePreset> = {
  documentary_narration: {
    label: "Documentary narration",
    description: "Steady, lively voice-over for facts and story. The default for long videos.",
    stability: 0.45,
    similarity: 0.8,
    style: 0.3,
    speed: 1.08,
    gapMs: [200, 350],
    tempo: 1,
  },
  dramatic_reveal: {
    label: "Dramatic reveal",
    description: "Slower, more emotional, with longer pauses. Used for key moments.",
    stability: 0.3,
    similarity: 0.8,
    style: 0.5,
    speed: 0.96,
    gapMs: [300, 600],
    tempo: 1,
  },
  fast_short: {
    label: "Fast Short",
    description: "Brisk delivery for YouTube Shorts.",
    stability: 0.4,
    similarity: 0.8,
    style: 0.3,
    speed: 1.13,
    gapMs: [150, 250],
    tempo: 1,
  },
};

export const MIN_TEMPO = 1;
export const MAX_TEMPO = 1.08;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const num = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);

/** Merges saved overrides over the defaults and forces every value into its valid range. */
export function resolvePresets(saved?: Partial<Record<PresetId, Partial<VoicePreset>>> | null): Record<PresetId, VoicePreset> {
  const out = {} as Record<PresetId, VoicePreset>;
  for (const id of PRESET_IDS) {
    const base = DEFAULT_PRESETS[id];
    const s = saved?.[id] ?? {};
    const gap = Array.isArray(s.gapMs) ? s.gapMs : base.gapMs;
    const lo = clamp(num(gap[0], base.gapMs[0]), 0, 2000);
    const hi = clamp(num(gap[1], base.gapMs[1]), lo, 3000);
    out[id] = {
      ...base,
      stability: clamp(num(s.stability, base.stability), 0, 1),
      similarity: clamp(num(s.similarity, base.similarity), 0, 1),
      style: clamp(num(s.style, base.style), 0, 1),
      speed: clamp(num(s.speed, base.speed), 0.7, 1.2),
      gapMs: [lo, hi],
      tempo: clamp(num(s.tempo, base.tempo), MIN_TEMPO, MAX_TEMPO),
    };
  }
  return out;
}

/** Which preset a scene uses: Shorts are brisk, key moments are dramatic, the rest is documentary. */
export function presetFor(scene: { keyMoment?: boolean }, format: "short" | "long"): PresetId {
  if (format === "short") return "fast_short";
  return scene.keyMoment ? "dramatic_reveal" : "documentary_narration";
}

// ---------- Models ----------

/** Flagship model with audio-tag support, then older ones. Override with ELEVENLABS_MODEL. */
export const DEFAULT_MODEL = "eleven_v4";
/** Tried in order when a model isn't available to the account. */
export const FALLBACK_MODELS = ["eleven_v3", "eleven_multilingual_v2"];

export const isV3Family = (model: string) => /^eleven_v3/.test(model);
/** Models whose speech accepts [audio tags] such as [whispering]. */
export const supportsAudioTags = (model: string) => /^eleven_v[34]/.test(model);

/**
 * The model chain for a scene: the configured model first, then the fallbacks. Shorts can use
 * a cheaper, faster model (ELEVENLABS_SHORT_MODEL, e.g. eleven_flash_v2_5) when cost matters.
 */
export function modelChain(env: Record<string, string | undefined>, format: "short" | "long"): string[] {
  const main = env.ELEVENLABS_MODEL?.trim() || DEFAULT_MODEL;
  const first = format === "short" && env.ELEVENLABS_SHORT_MODEL?.trim() ? env.ELEVENLABS_SHORT_MODEL.trim() : main;
  return [...new Set([first, main, ...FALLBACK_MODELS])];
}

/** Eleven v3 takes only three stability steps (Creative, Natural, Robust). */
export const snapStability = (s: number) => (s < 0.25 ? 0 : s < 0.75 ? 0.5 : 1);

export interface ElevenVoiceSettings {
  stability: number;
  similarity_boost: number;
  style?: number;
  speed?: number;
  use_speaker_boost: boolean;
}

/**
 * Voice settings for a model. `level` lets a failed request be retried with less: 0 sends
 * everything, 1 drops style, 2 also snaps stability to v3's steps, 3 also drops speed.
 * (The docs don't say which settings every model accepts, so the caller walks this ladder
 * on a validation error instead of guessing.)
 */
export function settingsFor(model: string, preset: Pick<VoicePreset, "stability" | "similarity" | "style" | "speed">, level = 0): ElevenVoiceSettings {
  const settings: ElevenVoiceSettings = {
    stability: preset.stability,
    similarity_boost: preset.similarity,
    use_speaker_boost: true,
  };
  if (!isV3Family(model) && level < 1) settings.style = preset.style;
  if (isV3Family(model) || level >= 2) settings.stability = snapStability(preset.stability);
  if (level < 3) settings.speed = preset.speed;
  return settings;
}

export const MAX_SETTINGS_LEVEL = 3;

/** Deterministic gap in seconds for the n-th boundary, inside the preset's range. */
export function gapSeconds(preset: Pick<VoicePreset, "gapMs">, n: number): number {
  // A small seeded hash instead of Math.random, so the same script always sounds the same.
  let h = (n + 1) * 2654435761;
  h = ((h ^ (h >>> 15)) * 2246822519) >>> 0;
  const unit = (h % 10000) / 10000;
  const [lo, hi] = preset.gapMs;
  return (lo + (hi - lo) * unit) / 1000;
}
