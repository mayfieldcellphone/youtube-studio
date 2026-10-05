import fs from "node:fs";
import path from "node:path";
import { download } from "./media";

/**
 * Hedra: turns a character's portrait and their recorded line into a talking clip (lips,
 * eyes and head move with the voice). Used for character lines in dramatised scenes.
 * Priced by the second of video (about $0.05/s); the line's audio sets the length.
 */
const BASE = "https://api.hedra.com/web-app/public";

export const hedraConfigured = () => Boolean(process.env.HEDRA_API_KEY);

/** Rough list price per second, for estimates only. */
export const HEDRA_PRICE_PER_SECOND = 0.05;

async function hedra(pathname: string, init?: RequestInit) {
  const res = await fetch(`${BASE}${pathname}`, {
    ...init,
    headers: { "X-API-Key": process.env.HEDRA_API_KEY ?? "", ...(init?.body instanceof FormData ? {} : { "Content-Type": "application/json" }), ...init?.headers },
  });
  const text = await res.text();
  let data: any = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {}
  if (!res.ok) throw new Error(hedraError(res.status, data, text));
  return data;
}

function hedraError(status: number, data: any, text: string) {
  const message = String(data?.error?.message ?? data?.message ?? data?.detail ?? text ?? "").slice(0, 300);
  if (status === 401 || status === 403) return "Hedra rejected the API key. Create a new key in Hedra (Settings → API) and paste it on the Setup page.";
  if (status === 402 || /balance|credit/i.test(message)) return "Hedra: not enough credits for this talking clip. Top up in Hedra, then make the video again.";
  if (status === 429) return "Hedra is busy or you've hit its request limit. Wait a minute and try again.";
  return `Hedra error ${status}: ${message || "unknown problem"}`;
}

let modelSlug: Promise<string> | undefined;

/**
 * The model that animates a portrait with speech. HEDRA_MODEL overrides it; otherwise the
 * newest "Character" model the key can use, else Hedra's avatar model.
 */
function talkingModel() {
  if (process.env.HEDRA_MODEL) return Promise.resolve(process.env.HEDRA_MODEL);
  modelSlug ??= hedra("/models?types=video")
    .then((list: any[]) => {
      const models = (Array.isArray(list) ? list : (list as any)?.models ?? []) as any[];
      const label = (m: any) => `${m.slug ?? ""} ${m.name ?? ""}`.toLowerCase();
      const pick =
        models.find((m) => /character[- ]?3/.test(label(m))) ??
        models.find((m) => /character/.test(label(m))) ??
        models.find((m) => /avatar|lip ?sync|talking/.test(label(m)));
      return pick?.slug ?? pick?.id ?? "together/hedra-avatar";
    })
    .catch((err) => {
      modelSlug = undefined;
      throw err;
    });
  return modelSlug;
}

async function upload(file: string, type: "image" | "audio") {
  const asset = await hedra("/assets", { method: "POST", body: JSON.stringify({ name: path.basename(file), type }) });
  const form = new FormData();
  form.append("file", new Blob([fs.readFileSync(file)]), path.basename(file));
  await hedra(`/assets/${asset.id}/upload`, { method: "POST", body: form });
  return String(asset.id);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Makes a talking clip of `image` saying `audio`, saved as an MP4 at `outFile`. */
export async function talkingClip(image: string, audio: string, portrait: boolean, outFile: string) {
  const [model, imageId, audioId] = await Promise.all([talkingModel(), upload(image, "image"), upload(audio, "audio")]);
  const generation = await hedra("/generations", {
    method: "POST",
    body: JSON.stringify({
      type: "video",
      model_slug: model,
      start_keyframe_id: imageId,
      audio_id: audioId,
      generated_video_inputs: {
        text_prompt: "A person speaking with natural, restrained expression, subtle head movement and blinking, steady camera",
        aspect_ratio: portrait ? "9:16" : "16:9",
        resolution: "720p",
      },
    }),
  });
  const id = generation.id ?? generation.generation_id;
  if (!id) throw new Error("Hedra didn't start the talking clip.");
  // Clips take about 1-3 minutes; give up after 12.
  for (let waited = 0; waited < 12 * 60_000; waited += 5_000) {
    await sleep(5_000);
    const status = await hedra(`/generations/${id}/status`);
    if (status.status === "complete") {
      const url = status.download_url ?? status.url;
      if (!url) throw new Error("Hedra finished but returned no video.");
      await download(url, outFile);
      return outFile;
    }
    if (status.status === "error") {
      throw new Error(`Hedra couldn't make the talking clip: ${status.error?.message ?? status.error_message ?? "unknown error"}`);
    }
  }
  throw new Error("Hedra took too long to make the talking clip.");
}
