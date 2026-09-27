import fs from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

// ---------- ElevenLabs (voiceover) ----------

/** "George": a warm narrator voice available on every ElevenLabs account. */
export const DEFAULT_VOICE_ID = "JBFqnCBsd6RMkjVDRZzb";
const ELEVEN_MODEL = "eleven_multilingual_v2";

export const voiceConfigured = () => Boolean(process.env.ELEVENLABS_API_KEY);

async function eleven(path: string, init?: RequestInit) {
  const res = await fetch(`https://api.elevenlabs.io${path}`, {
    ...init,
    headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY ?? "", "Content-Type": "application/json", ...init?.headers },
  });
  if (!res.ok) throw new Error(elevenError(res.status, await res.text()));
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
    return "ElevenLabs: you've used up this month's voice characters. Upgrade your ElevenLabs plan (Starter is about $5/month) or wait for the monthly reset. Your key is fine.";
  }
  if (text.includes("unusual_activity") || text.includes("unusual activity")) {
    return "ElevenLabs blocked free-plan use from this connection (\"unusual activity\"). This happens with VPNs or several free accounts. Turn off any VPN, or upgrade to a paid ElevenLabs plan. Your key is fine.";
  }
  if (text.includes("permission")) {
    return `ElevenLabs: your API key is missing a permission. In ElevenLabs → API Keys, edit the key and allow Text to Speech, Voices (read) and User (read). (${message})`;
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

export interface Word {
  text: string;
  start: number;
  end: number;
}

/** Generates narration and returns word timings (used for captions) and the spoken duration. */
export async function speak(text: string, voiceId: string, outFile: string) {
  const data = await eleven(`/v1/text-to-speech/${voiceId}/with-timestamps?output_format=mp3_44100_128`, {
    method: "POST",
    body: JSON.stringify({
      text,
      model_id: ELEVEN_MODEL,
      // Less "stability" and some "style" make narration more expressive and less monotone.
      voice_settings: { stability: 0.38, similarity_boost: 0.8, style: 0.35, use_speaker_boost: true },
    }),
  });
  fs.writeFileSync(outFile, Buffer.from(data.audio_base64, "base64"));

  const a = data.alignment ?? data.normalized_alignment;
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
  const duration = words.length ? words[words.length - 1].end : 0;
  return { words, duration };
}

// ---------- Pexels (stock footage) ----------

export const footageConfigured = () => Boolean(process.env.PEXELS_API_KEY);

async function pexels(path: string) {
  const res = await fetch(`https://api.pexels.com${path}`, {
    headers: { Authorization: process.env.PEXELS_API_KEY ?? "" },
  });
  if (res.status === 401 || res.status === 403) throw new Error("Your Pexels API key is invalid. Check PEXELS_API_KEY.");
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
