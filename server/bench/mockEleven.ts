import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runFfmpeg } from "../audioPost";

/**
 * A fake ElevenLabs for testing the bench harness without an API key: speech-like tone with
 * 0.35 s of silence before and 0.5 s after (what a raw, untrimmed clip looks like), character
 * timings, and dialogue segments. It says nothing about how real voices sound.
 */
export function installMockEleven(): () => void {
  const real = globalThis.fetch;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mock-eleven-"));
  const cache = new Map<number, string>();
  const clip = async (speech: number) => {
    const key = Math.round(speech * 10);
    const hit = cache.get(key);
    if (hit) return hit;
    const f = path.join(dir, `c${key}.wav`);
    await runFfmpeg([
      "-f", "lavfi", "-i", `sine=f=170:d=${speech}:r=44100,tremolo=f=4:d=0.8,volume=0.2`,
      "-af", "adelay=350:all=1,apad=pad_dur=0.5", "-ac", "1", f,
    ]);
    const b64 = fs.readFileSync(f).toString("base64");
    cache.set(key, b64);
    return b64;
  };
  globalThis.fetch = (async (url: any, init: any) => {
    const body = JSON.parse(init.body);
    if (String(url).includes("text-to-dialogue")) {
      const per = 2;
      const n = body.inputs.length;
      const audio = await clip(per * n + 0.2 * (n - 1));
      const voice_segments = body.inputs.map((_: unknown, i: number) => ({
        voice_id: body.inputs[i].voice_id,
        start_time_seconds: 0.35 + i * (per + 0.2),
        end_time_seconds: 0.35 + i * (per + 0.2) + per,
        dialogue_input_index: i,
      }));
      return new Response(JSON.stringify({ audio_base64: audio, voice_segments }), { status: 200 });
    }
    const text: string = body.text.replace(/\[[^\]]*\]\s*/g, "");
    const words = text.split(/\s+/).filter(Boolean).length;
    // ~2.4 words a second, like a slow documentary read.
    const speech = Math.max(0.6, words / 2.4);
    const chars = [...text];
    const step = speech / chars.length;
    return new Response(
      JSON.stringify({
        audio_base64: await clip(speech),
        alignment: {
          characters: chars,
          character_start_times_seconds: chars.map((_, i) => 0.35 + i * step),
          character_end_times_seconds: chars.map((_, i) => 0.35 + (i + 1) * step),
        },
      }),
      { status: 200 },
    );
  }) as typeof fetch;
  return () => {
    globalThis.fetch = real;
    fs.rmSync(dir, { recursive: true, force: true });
  };
}
