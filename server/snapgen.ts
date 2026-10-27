import { download } from "./media";
import type { Tier } from "./aiBudget";

const BASE = "https://api.snapgen.ai";

export const snapgenConfigured = () => Boolean(process.env.SNAPGEN_API_KEY);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Maps quality tier to default Veo model name in SnapGen, unless overridden by SNAPGEN_MODEL.
 * - best -> veo-3.1
 * - fast -> veo-3.1-fast
 * - lite -> veo-3.1-lite
 */
export function modelForTier(tier: Tier): string {
  if (process.env.SNAPGEN_MODEL) return process.env.SNAPGEN_MODEL;
  switch (tier) {
    case "lite":
      return "veo-3.1-lite";
    case "best":
      return "veo-3.1";
    case "fast":
    default:
      return "veo-3.1-fast";
  }
}

/**
 * SnapGen client. Generates a video clip via SnapGen's Veo endpoint and saves to outFile.
 * POST https://api.snapgen.ai/uapi/v1/video-gen/veo (multipart, x-api-key),
 * then polls GET /uapi/v1/history/{uuid} until status 2 and downloads generated_video[0].video_url.
 */
export async function makeSnapgenClip(
  prompt: string,
  outFile: string,
  tier: Tier,
  portrait: boolean,
  opts?: { pollIntervalMs?: number; deadlineMs?: number },
): Promise<void> {
  const apiKey = process.env.SNAPGEN_API_KEY;
  if (!apiKey) throw new Error("SnapGen API key is missing.");

  const model = modelForTier(tier);
  const form = new FormData();
  form.append("prompt", prompt);
  form.append("model", model);
  form.append("aspect_ratio", portrait ? "9:16" : "16:9");

  const res = await fetch(`${BASE}/uapi/v1/video-gen/veo`, {
    method: "POST",
    headers: { "x-api-key": apiKey },
    body: form,
  });

  const text = await res.text();
  let data: any = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {}

  if (!res.ok) {
    const message = String(data?.error?.message ?? data?.error ?? data?.message ?? data?.detail ?? text ?? "").slice(0, 300);
    if (res.status === 401 || res.status === 403) {
      throw new Error("SnapGen rejected the API key. Create a new key in SnapGen and paste it on the Setup page.");
    }
    if (res.status === 402 || /balance|credit/i.test(message)) {
      throw new Error("SnapGen: not enough credits. Top up at snapgen.ai.");
    }
    throw new Error(`SnapGen error ${res.status}: ${message || "request failed"}`);
  }

  const uuid = data?.uuid ?? data?.data?.uuid ?? data?.id ?? data?.task_id;
  if (!uuid) throw new Error("SnapGen started but returned no task UUID.");

  // Poll GET /uapi/v1/history/{uuid} until status 2 (completed). Timeout after 10 minutes.
  const interval = opts?.pollIntervalMs ?? 5_000;
  const deadline = Date.now() + (opts?.deadlineMs ?? 10 * 60 * 1000);
  while (Date.now() < deadline) {
    await sleep(interval);
    const pollRes = await fetch(`${BASE}/uapi/v1/history/${uuid}`, {
      headers: { "x-api-key": apiKey },
    });

    if (!pollRes.ok) {
      if (pollRes.status === 401 || pollRes.status === 403) {
        throw new Error("SnapGen rejected the API key during status check.");
      }
      continue;
    }

    const pollText = await pollRes.text();
    let history: any = {};
    try {
      history = pollText ? JSON.parse(pollText) : {};
    } catch {
      continue;
    }

    const item = history?.data ?? history;
    const status = Number(item?.status);

    if (status === 2) {
      const videoUrl = item?.generated_video?.[0]?.video_url ?? item?.video_url;
      if (!videoUrl) throw new Error("SnapGen finished but returned no video URL.");
      await download(videoUrl, outFile);
      return;
    }

    if (status === 3 || status === -1 || item?.failed_reason || (status !== 1 && status !== 0 && item?.error)) {
      const reason = item?.failed_reason ?? item?.error?.message ?? item?.error ?? "generation failed";
      throw new Error(`SnapGen failed: ${reason}`);
    }
  }

  throw new Error("SnapGen took too long to generate the clip.");
}
