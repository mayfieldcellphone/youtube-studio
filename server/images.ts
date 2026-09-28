import fs from "node:fs";
import { google } from "./veo";
import type { VideoLook } from "./db";

/**
 * AI pictures from Gemini's image model, through the same Gemini API key as the voice and Veo.
 * Each shot gets a picture drawn for its exact line of narration; the video maker then moves
 * slowly across it so it doesn't look frozen.
 */

/** Rough list price of one picture, for the cost estimate only. */
export const PRICE_PER_PICTURE = 0.04;

/** Style added to every picture, per channel look, unless the channel sets its own. */
export const DEFAULT_PICTURE_STYLES: Record<VideoLook, string> = {
  cinematic:
    "Cinematic film still, photorealistic, historically accurate clothing, architecture and objects for the period, dramatic low-key lighting, muted desaturated colors, subtle film grain, 35mm lens, shallow depth of field, moody and mysterious",
  clean: "Clean, modern, photorealistic image, bright even lighting, crisp detail, uncluttered composition",
  warm: "Warm, photorealistic lifestyle photo, soft golden-hour light, natural colors, inviting and optimistic",
};
const ALWAYS = "No text, letters, numbers, captions, signs, watermarks or logos anywhere in the image.";

let models: Promise<string[]> | undefined;

/** Gemini image models this key can use: the fast "flash" ones first, newest first. */
function imageModels() {
  models ??= google("/models?pageSize=1000")
    .then((data) =>
      (data.models ?? [])
        .filter((m: any) => /gemini.*image/i.test(m.name) && (m.supportedGenerationMethods ?? []).includes("generateContent"))
        .map((m: any) => String(m.name).replace(/^models\//, ""))
        .sort((a: string, b: string) => rank(b) - rank(a)),
    )
    .catch((err) => {
      models = undefined;
      throw err;
    });
  return models;
}

const rank = (name: string) =>
  (/flash/i.test(name) ? 100 : 0) + Number(/gemini-(\d+(?:\.\d+)?)/.exec(name)?.[1] ?? 0) - (/preview/i.test(name) ? 0.01 : 0);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Draws one picture. Returns the saved file, or the reason it failed. */
async function makePicture(model: string, prompt: string, portrait: boolean, outBase: string): Promise<{ file: string } | string> {
  const body = (withAspect: boolean) =>
    JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        responseModalities: ["IMAGE"],
        ...(withAspect && { imageConfig: { aspectRatio: portrait ? "9:16" : "16:9" } }),
      },
    });
  let withAspect = true;
  for (let attempt = 0; ; attempt++) {
    try {
      const data = await google(`/models/${model}:generateContent`, { method: "POST", body: body(withAspect) });
      const parts: any[] = data.candidates?.[0]?.content?.parts ?? [];
      const image = parts.find((p) => p.inlineData?.data);
      if (!image) {
        const reason = data.promptFeedback?.blockReason ?? data.candidates?.[0]?.finishReason;
        return reason ? `Google declined the picture (${reason}).` : "Google returned no picture.";
      }
      const ext = /jpe?g/i.test(image.inlineData.mimeType ?? "") ? "jpg" : "png";
      const file = `${outBase}.${ext}`;
      fs.writeFileSync(file, Buffer.from(image.inlineData.data, "base64"));
      return { file };
    } catch (err) {
      const e = err as Error & { status?: number };
      // Older image models don't take an aspect ratio; the video maker crops those to fit.
      if (e.status === 400 && withAspect && /aspect|imageConfig|image_config/i.test(e.message)) {
        withAspect = false;
        continue;
      }
      if ((e.status === 429 || (e.status ?? 0) >= 500) && attempt < 4) {
        await sleep(e.status === 429 ? 15_000 * (attempt + 1) : 3_000);
        continue;
      }
      return e.message;
    }
  }
}

/**
 * Draws all pictures, a few at a time. Each result is the saved file or the reason it failed,
 * so one refused picture doesn't stop the video (it falls back to stock footage).
 */
export async function makePictures(
  requests: { prompt: string; outBase: string }[],
  style: string,
  portrait: boolean,
  onProgress: (done: number) => void,
) {
  const list = await imageModels();
  if (!list.length) throw new Error("This Gemini key has no access to Gemini image models. Check that billing is on for it in Google AI Studio.");
  const model = list[0];
  const results: ({ file: string } | string)[] = new Array(requests.length);
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < requests.length) {
      const i = next++;
      const { prompt, outBase } = requests[i];
      results[i] = await makePicture(model, `${prompt}\n\nStyle: ${style}. ${ALWAYS}`, portrait, outBase);
      onProgress(++done);
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  return results;
}
