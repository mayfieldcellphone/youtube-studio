import fs from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { isAudioTag } from "./speakers";
import { MAX_SETTINGS_LEVEL, settingsFor, supportsAudioTags, type VoicePreset } from "./voicePresets";

// ---------- ElevenLabs (voiceover) ----------

/** "George": a warm narrator voice available on every ElevenLabs account. */
export const DEFAULT_VOICE_ID = "JBFqnCBsd6RMkjVDRZzb";
const ELEVEN_MODEL = "eleven_multilingual_v2";

export const voiceConfigured = () => Boolean(process.env.ELEVENLABS_API_KEY);

/** An ElevenLabs failure with the HTTP status and raw body kept, so callers can tell a rejected setting from a missing model. */
export class ElevenError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
  }
}

export async function eleven(path: string, init?: RequestInit) {
  const res = await fetch(`https://api.elevenlabs.io${path}`, {
    ...init,
    headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY ?? "", "Content-Type": "application/json", ...init?.headers },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new ElevenError(elevenError(res.status, body), res.status, body);
  }
  return res.json();
}

/**
 * ElevenLabs answers 401 for several different problems (used-up quota, blocked free
 * account, missing key permission, wrong key), so the reason has to be read from the body.
 */
function elevenError(status: number, body: string) {
  let reason = "";
  let message = "";
  try {
    const detail = JSON.parse(body).detail;
    reason = String(detail?.status ?? detail?.code ?? "");
    message = String(detail?.message ?? (typeof detail === "string" ? detail : ""));
  } catch {
    message = body.slice(0, 200);
  }
  const text = `${reason} ${message}`.toLowerCase();

  if (text.includes("quota") || text.includes("credits") || status === 402) {
    return "ElevenLabs: you've used up this month's voice characters. Switch this channel's Voice engine to Gemini or Kokoro (free) under Edit channel, upgrade your ElevenLabs plan (Starter is about $5/month), or wait for the monthly reset. Your key is fine.";
  }
  if (text.includes("unusual_activity") || text.includes("unusual activity")) {
    return "ElevenLabs blocked free-plan use from this connection (\"unusual activity\"). This happens with VPNs or several free accounts. Turn off any VPN, or upgrade to a paid ElevenLabs plan. Your key is fine.";
  }
  if (text.includes("permission")) {
    return `ElevenLabs: your API key is missing a permission. In ElevenLabs → API Keys, edit the key and allow Text to Speech, Voices (read and write) and User (read), plus Text to Voice if it is listed (needed to design character voices). (${message})`;
  }
  if (text.includes("invalid_api_key") || text.includes("invalid api key") || (status === 401 && !reason)) {
    return "Your ElevenLabs API key was rejected. Create a new key in ElevenLabs → API Keys and paste it on the Setup page.";
  }
  if (status === 429) {
    return "ElevenLabs is busy or you've hit its request limit. Wait a minute and try again.";
  }
  return `ElevenLabs error ${status}${reason ? ` (${reason})` : ""}: ${message || body.slice(0, 200)}`;
}

/** Characters left this month, or null if the key can't read the subscription. */
export async function voiceCharactersLeft(): Promise<{ used: number; limit: number; resetsAt?: string } | null> {
  try {
    const sub = await eleven("/v1/user/subscription");
    return {
      used: Number(sub.character_count ?? 0),
      limit: Number(sub.character_limit ?? 0),
      resetsAt: sub.next_character_count_reset_unix ? new Date(sub.next_character_count_reset_unix * 1000).toISOString() : undefined,
    };
  } catch {
    return null;
  }
}

export interface Voice {
  id: string;
  name: string;
  description: string;
  previewUrl?: string;
}

export async function listVoices(): Promise<Voice[]> {
  const data = await eleven("/v1/voices");
  return (data.voices ?? []).map((v: any) => ({
    id: v.voice_id,
    name: v.name,
    description: [v.labels?.accent, v.labels?.gender, v.labels?.age, v.labels?.description ?? v.labels?.use_case]
      .filter(Boolean)
      .join(", "),
    previewUrl: v.preview_url ?? undefined,
  }));
}

export interface DesignedVoice {
  /** Pass to createDesignedVoice to keep this voice */
  generatedVoiceId: string;
  /** A short sample, as a data: URL the browser can play */
  audio: string;
}

/**
 * ElevenLabs Voice Design: makes new voices from a description and returns a few previews
 * to choose from. Nothing is saved to the account until createDesignedVoice is called.
 */
export async function designVoice(description: string, text: string): Promise<DesignedVoice[]> {
  const body = (model: string) =>
    JSON.stringify({
      voice_description: description.trim().slice(0, 1000),
      // Voice Design reads 100-1000 characters; for a shorter line it writes its own sample.
      ...(text.trim().length >= 100 ? { text: text.trim().slice(0, 1000) } : { auto_generate_text: true }),
      model_id: model,
    });
  let data: any;
  try {
    // v3 voices act audio tags best, which the character lines use.
    data = await eleven("/v1/text-to-voice/design?output_format=mp3_44100_128", { method: "POST", body: body("eleven_ttv_v3") });
  } catch (err) {
    if (/quota|credits|permission|rejected|blocked/i.test((err as Error).message)) throw err;
    data = await eleven("/v1/text-to-voice/design?output_format=mp3_44100_128", {
      method: "POST",
      body: body("eleven_multilingual_ttv_v2"),
    });
  }
  return (data.previews ?? []).map((p: any) => ({
    generatedVoiceId: p.generated_voice_id,
    audio: `data:${p.media_type || "audio/mpeg"};base64,${p.audio_base_64 ?? p.audio_base64}`,
  }));
}

/** Saves a designed voice to the ElevenLabs account and returns its voice ID. */
export async function createDesignedVoice(name: string, description: string, generatedVoiceId: string) {
  const data = await eleven("/v1/text-to-voice", {
    method: "POST",
    body: JSON.stringify({
      voice_name: name.slice(0, 100),
      voice_description: description.trim().padEnd(20, ".").slice(0, 1000),
      generated_voice_id: generatedVoiceId,
      labels: { use_case: "characters" },
    }),
  });
  if (!data.voice_id) throw new Error("ElevenLabs didn't return the new voice. Try again.");
  return String(data.voice_id);
}

export interface Word {
  text: string;
  start: number;
  end: number;
}

/** Eleven v3 follows [audio tags] such as [whispering] for acted character lines. */
export const ELEVEN_ACTING_MODEL = "eleven_v3";

/**
 * ElevenLabs narration with exact word timings (used for captions) and the spoken duration.
 * `model` defaults to the narration model; Eleven v3 only accepts fixed stability steps.
 */
export async function elevenSpeak(text: string, voiceId: string, outFile: string, model = ELEVEN_MODEL) {
  const data = await eleven(`/v1/text-to-speech/${voiceId}/with-timestamps?output_format=mp3_44100_128`, {
    method: "POST",
    body: JSON.stringify({
      text,
      model_id: model,
      voice_settings:
        model === ELEVEN_ACTING_MODEL
          ? { stability: 0.5, similarity_boost: 0.8, use_speaker_boost: true }
          : // Less "stability" and some "style" make narration more expressive and less monotone.
            { stability: 0.38, similarity_boost: 0.8, style: 0.35, use_speaker_boost: true },
    }),
  });
  fs.writeFileSync(outFile, Buffer.from(data.audio_base64, "base64"));

  const words = wordsFromAlignment(data.alignment ?? data.normalized_alignment);
  const duration = words.length ? words[words.length - 1].end : 0;
  return { words, duration };
}

export interface Alignment {
  characters: string[];
  character_start_times_seconds: number[];
  character_end_times_seconds: number[];
}

/**
 * Turns ElevenLabs' per-character timings into words. Audio tags like [firm] steer the
 * delivery but aren't spoken, so they are kept out of the words (and so out of captions).
 */
export function wordsFromAlignment(a: Alignment | null | undefined): Word[] {
  const words: Word[] = [];
  let current: Word | null = null;
  a?.characters?.forEach((ch: string, i: number) => {
    if (/\s/.test(ch)) {
      if (current) words.push(current);
      current = null;
    } else if (current) {
      current.text += ch;
      current.end = a.character_end_times_seconds[i];
    } else {
      current = { text: ch, start: a.character_start_times_seconds[i], end: a.character_end_times_seconds[i] };
    }
  });
  if (current) words.push(current);
  return words.filter((w) => !isAudioTag(w.text));
}

// ---------- Narration chunks: presets, model fallback, context ----------

export interface ChunkSpeech {
  words: Word[];
  /** Seconds into the raw file where the first spoken word starts (undefined if no timings came back) */
  speechStart?: number;
  /** Seconds into the raw file where the last spoken word ends */
  speechEnd?: number;
  /** The model that actually spoke it */
  model: string;
}

/** What this process has learned about the account's models, so a rejection is only discovered once. */
const modelDownUntil = new Map<string, number>();
const noContext = new Set<string>();
const settingsLevelFor = new Map<string, number>();

/** False once this process has learned that the model rejects previous_text / next_text. */
export const contextSupported = (model: string) => !noContext.has(model);

/** The models worth trying right now: the ones not recently found to be unavailable to this account. */
export const usableModels = (models: string[]) => models.filter((m) => (modelDownUntil.get(m) ?? 0) <= Date.now());

/** Forgets what was learned about models (for tests, and after the account or key changes). */
export function resetModelMemory() {
  modelDownUntil.clear();
  noContext.clear();
  settingsLevelFor.clear();
}

/** True when the failure means "this account can't use this model", as opposed to a quota or key problem. */
export function modelUnavailable(err: ElevenError) {
  const body = err.body.toLowerCase();
  if (/quota|credits|unusual_activity|invalid_api_key/.test(body)) return false;
  if (err.status === 404) return true;
  if (![400, 401, 403, 422].includes(err.status)) return false;
  return /model/.test(body) && /(not found|not available|unavailable|invalid|unknown|unsupported|not supported|access|upgrade|plan|tier|does not exist|only available|not allowed)/.test(body);
}

/**
 * Speaks one chunk of narration with a voice preset. It tries the models in order, and within a
 * model it steps down through settings the model rejects and drops previous_text/next_text if
 * the model doesn't take them (the ElevenLabs docs don't list this per model). What it learns is
 * remembered for the rest of the process.
 */
export async function speakChunk(
  text: string,
  voiceId: string,
  outFile: string,
  opts: { models: string[]; preset: Pick<VoicePreset, "stability" | "similarity" | "style" | "speed">; previousText?: string; nextText?: string },
): Promise<ChunkSpeech> {
  const problems: string[] = [];
  for (const model of opts.models) {
    if ((modelDownUntil.get(model) ?? 0) > Date.now()) continue;
    let level = settingsLevelFor.get(model) ?? 0;
    let useContext = !noContext.has(model);
    for (;;) {
      try {
        const data = await eleven(`/v1/text-to-speech/${voiceId}/with-timestamps?output_format=mp3_44100_128`, {
          method: "POST",
          body: JSON.stringify({
            // Models without audio tags would read "[firm]" aloud, so the tags are dropped for them.
            text: supportsAudioTags(model) ? text : text.replace(/\[[^\]]*\]\s*/g, "").trim(),
            model_id: model,
            voice_settings: settingsFor(model, opts.preset, level),
            ...(useContext && opts.previousText ? { previous_text: opts.previousText } : {}),
            ...(useContext && opts.nextText ? { next_text: opts.nextText } : {}),
          }),
        });
        settingsLevelFor.set(model, level);
        fs.writeFileSync(outFile, Buffer.from(data.audio_base64, "base64"));
        const words = wordsFromAlignment(data.alignment ?? data.normalized_alignment);
        return { words, speechStart: words[0]?.start, speechEnd: words[words.length - 1]?.end, model };
      } catch (err) {
        if (!(err instanceof ElevenError)) throw err;
        const body = err.body.toLowerCase();
        if ([400, 422].includes(err.status)) {
          if (useContext && /previous_text|next_text|previous_request|next_request|stitch/.test(body)) {
            useContext = false;
            noContext.add(model);
            continue;
          }
          if (level < MAX_SETTINGS_LEVEL && /voice_settings|stability|style|speed|similarity|setting/.test(body)) {
            level++;
            continue;
          }
        }
        if (modelUnavailable(err)) {
          modelDownUntil.set(model, Date.now() + 10 * 60 * 1000);
          problems.push(`${model}: ${err.message}`);
          console.warn(`ElevenLabs model ${model} isn't available (${err.status}); trying the next one.`);
          break;
        }
        throw err;
      }
    }
  }
  throw new Error(`No ElevenLabs model could voice this line.${problems.length ? ` ${problems.join(" ")}` : ""}`);
}

// ---------- Pexels (stock footage) ----------

export const footageConfigured = () => Boolean(process.env.PEXELS_API_KEY);

async function pexels(path: string) {
  const res = await fetch(`https://api.pexels.com${path}`, {
    headers: { Authorization: process.env.PEXELS_API_KEY ?? "" },
  });
  if (res.status === 401 || res.status === 403) throw new Error("Your Pexels key was rejected. Check box 3 on the Setup page.");
  if (res.status === 429) throw new Error("Pexels rate limit reached. Try again in an hour.");
  if (!res.ok) throw new Error(`Pexels error ${res.status}`);
  return res.json();
}

export interface Footage {
  id: string;
  kind: "video" | "photo";
  url: string;
}

/**
 * Finds a stock clip for a search, preferring video, then photo. Skips anything in `used`
 * so the same shot isn't repeated in one video.
 */
export async function findFootage(query: string, portrait: boolean, used: Set<string>): Promise<Footage | null> {
  const orientation = portrait ? "portrait" : "landscape";
  const q = encodeURIComponent(query);
  const target = portrait ? 1920 : 1080;

  const videos = await pexels(`/videos/search?query=${q}&orientation=${orientation}&per_page=15&size=medium`);
  for (const v of videos.videos ?? []) {
    const id = `v${v.id}`;
    if (used.has(id)) continue;
    const files = (v.video_files ?? []).filter((f: any) => f.file_type === "video/mp4" && f.height && f.width);
    if (!files.length) continue;
    // Smallest file that is at least full-HD on the long side; otherwise the biggest available.
    const big = files
      .filter((f: any) => Math.max(f.width, f.height) >= target)
      .sort((a: any, b: any) => a.width * a.height - b.width * b.height);
    const file = big[0] ?? files.sort((a: any, b: any) => b.width * b.height - a.width * a.height)[0];
    return { id, kind: "video", url: file.link };
  }

  const photos = await pexels(`/v1/search?query=${q}&orientation=${orientation}&per_page=15`);
  for (const p of photos.photos ?? []) {
    const id = `p${p.id}`;
    if (used.has(id)) continue;
    return { id, kind: "photo", url: p.src?.large2x ?? p.src?.original };
  }
  return null;
}

export async function download(url: string, outFile: string) {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status})`);
  await pipeline(Readable.fromWeb(res.body as any), fs.createWriteStream(outFile));
}
