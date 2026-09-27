import fs from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/**
 * AI video clips from Google's Veo model (the engine behind Google Flow), through the same
 * Gemini API key used for the Gemini voice. Veo needs billing on the key.
 */

const API = "https://generativelanguage.googleapis.com/v1beta";

export type AiQuality = "fast" | "best";

/** Rough list prices per second of video, for the cost estimate only. */
export const PRICE_PER_SECOND: Record<AiQuality, number> = { fast: 0.15, best: 0.4 };
export const CLIP_SECONDS = 8;

const key = () => process.env.GEMINI_API_KEY ?? "";

async function google(path: string, init?: RequestInit) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", "x-goog-api-key": key(), ...init?.headers },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message: string = data?.error?.message ?? `HTTP ${res.status}`;
    const err = new Error(message) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return data;
}

let models: Promise<string[]> | undefined;

/** Veo models this key can use, newest first (asks Google rather than guessing names). */
function veoModels() {
  models ??= google("/models?pageSize=1000")
    .then((data) =>
      (data.models ?? [])
        .filter((m: any) => /veo/i.test(m.name) && (m.supportedGenerationMethods ?? []).includes("predictLongRunning"))
        .map((m: any) => String(m.name).replace(/^models\//, ""))
        .sort((a: string, b: string) => version(b) - version(a)),
    )
    .catch((err) => {
      models = undefined;
      throw err;
    });
  return models;
}

const version = (name: string) => Number(/veo-(\d+(?:\.\d+)?)/.exec(name)?.[1] ?? 0);

async function pickModel(quality: AiQuality) {
  const list = await veoModels();
  if (!list.length) throw new Error("This Gemini key has no access to Veo video models.");
  const newest = version(list[0]);
  const candidates = list.filter((m) => version(m) === newest);
  const fast = candidates.find((m) => /fast/i.test(m));
  const full = candidates.find((m) => !/fast/i.test(m));
  return (quality === "fast" ? fast ?? full : full ?? fast) ?? list[0];
}

/** Starts a clip; returns the operation name to poll. */
async function start(model: string, prompt: string, portrait: boolean) {
  const body = (aspectRatio: string) =>
    JSON.stringify({
      instances: [{ prompt }],
      parameters: {
        aspectRatio,
        negativePrompt: "text, captions, subtitles, watermark, logo, modern clothing, cartoon, low quality, distorted faces",
      },
    });
  for (let attempt = 0; ; attempt++) {
    try {
      const op = await google(`/models/${model}:predictLongRunning`, {
        method: "POST",
        body: body(portrait ? "9:16" : "16:9"),
      });
      return op.name as string;
    } catch (err) {
      const e = err as Error & { status?: number };
      // Some Veo versions only make landscape clips; those get cropped to fit instead.
      if (portrait && e.status === 400 && /aspect/i.test(e.message)) {
        const op = await google(`/models/${model}:predictLongRunning`, { method: "POST", body: body("16:9") });
        return op.name as string;
      }
      if (e.status === 429 && attempt < 3) {
        await sleep(30_000);
        continue;
      }
      throw err;
    }
  }
}

/** Waits for a clip and downloads it. */
async function finish(operation: string, outFile: string) {
  const deadline = Date.now() + 8 * 60 * 1000;
  for (;;) {
    const op = await google(`/${operation}`);
    if (op.done) {
      if (op.error) throw new Error(op.error.message ?? "Veo failed.");
      const response = op.response?.generateVideoResponse ?? op.response;
      const sample = response?.generatedSamples?.[0] ?? response?.generatedVideos?.[0];
      const uri: string | undefined = sample?.video?.uri;
      if (!uri) {
        const reason = response?.raiMediaFilteredReasons?.[0];
        throw new Error(reason ? `Veo blocked this shot: ${reason}` : "Veo returned no video.");
      }
      const res = await fetch(uri, { headers: { "x-goog-api-key": key() } });
      if (!res.ok || !res.body) throw new Error(`Couldn't download the Veo clip (${res.status}).`);
      await pipeline(Readable.fromWeb(res.body as any), fs.createWriteStream(outFile));
      return;
    }
    if (Date.now() > deadline) throw new Error("Veo took too long.");
    await sleep(10_000);
  }
}

export interface ClipRequest {
  prompt: string;
  outFile: string;
}

/**
 * Makes several clips, two at a time. Returns, per request, true when the clip was made or
 * the reason it wasn't (so the caller can fall back to stock footage for that shot).
 */
export async function makeClips(
  requests: ClipRequest[],
  quality: AiQuality,
  portrait: boolean,
  onProgress: (done: number) => void,
): Promise<(true | string)[]> {
  let model: string;
  try {
    model = await pickModel(quality);
  } catch (err) {
    return requests.map(() => `AI footage unavailable: ${(err as Error).message}`);
  }
  const results: (true | string)[] = new Array(requests.length);
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < requests.length) {
      const i = next++;
      try {
        const op = await start(model, requests[i].prompt, portrait);
        await finish(op, requests[i].outFile);
        results[i] = true;
      } catch (err) {
        results[i] = (err as Error).message;
      }
      onProgress(++done);
    }
  };
  await Promise.all([worker(), worker()]);
  return results;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
