import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import ffmpegPath from "ffmpeg-static";
import { DATA_DIR, db, UPLOAD_DIR, type Video } from "./db";
import { planScenes } from "./ai";
import { DEFAULT_VOICE_ID, download, findFootage, speak, type Footage, type Word } from "./media";

const FONT_DIR = path.resolve("assets/fonts");
const FPS = 30;
/** Silence after each scene so sentences don't run into each other. */
const GAP = 0.25;

export const ffmpegAvailable = () => Boolean(ffmpegPath && fs.existsSync(ffmpegPath));

const rendering = new Set<string>();
let queue: Promise<unknown> = Promise.resolve();

export const isRendering = (videoId: string) => rendering.has(videoId);

/** Renders are CPU-heavy, so they run one at a time. */
export function startRender(videoId: string) {
  if (rendering.has(videoId)) throw new Error("This video is already being made.");
  rendering.add(videoId);
  db.updateVideo(videoId, { render: { stage: "Waiting to start", progress: 0, startedAt: new Date().toISOString() } });
  queue = queue
    .then(() => render(videoId))
    .catch((err: Error) => {
      console.error(`Render ${videoId} failed:`, err);
      const video = db.video(videoId);
      if (video?.render) db.updateVideo(videoId, { render: { ...video.render, error: err.message, finishedAt: new Date().toISOString() } });
    })
    .finally(() => rendering.delete(videoId));
}

/** Marks renders that were running when the server stopped as failed. */
export function recoverInterruptedRenders() {
  for (const v of db.videos()) {
    if (v.render && !v.render.finishedAt) {
      db.updateVideo(v.id, { render: { ...v.render, error: "Stopped because the app restarted. Try again.", finishedAt: new Date().toISOString() } });
    }
  }
}

async function render(videoId: string) {
  let video = db.video(videoId);
  if (!video) return;
  const channel = db.channel(video.channelId);
  if (!channel) throw new Error("Channel not found.");
  if (!video.script.trim()) throw new Error("Write the script first.");

  const portrait = video.format === "short";
  const [W, H] = portrait ? [1080, 1920] : [1920, 1080];
  const work = path.join(DATA_DIR, "work", video.id);
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });

  const stage = (name: string, progress: number) => {
    video = db.updateVideo(videoId, { render: { ...video!.render!, stage: name, progress: Math.round(progress) } })!;
  };

  try {
    stage("Splitting the script into scenes", 3);
    const scenes = await planScenes(channel, video);
    const n = scenes.length;

    // 1. Voiceover for each scene (per-scene audio gives exact scene lengths and caption timings).
    const voices: { file: string; words: Word[]; duration: number }[] = [];
    for (const [i, scene] of scenes.entries()) {
      stage(`Recording voiceover (${i + 1}/${n})`, 8 + (30 * i) / n);
      const file = path.join(work, `voice-${i}.mp3`);
      const { words, duration } = await speak(scene.narration, channel.voiceId || DEFAULT_VOICE_ID, file);
      voices.push({ file, words, duration: Math.max(duration, 0.5) + GAP });
    }

    // 2. Stock footage for each scene.
    const used = new Set<string>();
    const visuals: (Footage & { file: string } | null)[] = [];
    for (const [i, scene] of scenes.entries()) {
      stage(`Finding footage (${i + 1}/${n})`, 38 + (17 * i) / n);
      const found =
        (await findFootage(scene.query, portrait, used)) ?? (await findFootage(scene.fallbackQuery, portrait, used));
      if (!found) {
        visuals.push(null);
        continue;
      }
      used.add(found.id);
      const file = path.join(work, `visual-${i}${found.kind === "video" ? ".mp4" : ".jpg"}`);
      try {
        await download(found.url, file);
        visuals.push({ ...found, file });
      } catch {
        visuals.push(null);
      }
    }

    // 3. One clip per scene: footage cropped to fit, with its narration.
    const segments: string[] = [];
    for (const [i, voice] of voices.entries()) {
      stage(`Editing scenes (${i + 1}/${n})`, 55 + (25 * i) / n);
      const out = path.join(work, `segment-${i}.mp4`);
      await ffmpeg(segmentArgs(visuals[i], voice.file, voice.duration, W, H, out));
      segments.push(out);
    }

    // 4. Join scenes and burn in captions.
    stage("Adding captions and finishing", 80);
    const list = path.join(work, "segments.txt");
    fs.writeFileSync(list, segments.map((s) => `file '${s.replace(/'/g, "'\\''")}'`).join("\n"));
    const captions = path.join(work, "captions.ass");
    fs.writeFileSync(captions, buildCaptions(voices, portrait, W, H));
    const total = voices.reduce((sum, v) => sum + v.duration, 0);
    const output = path.join(UPLOAD_DIR, `${crypto.randomUUID()}.mp4`);
    await ffmpeg(
      [
        "-f", "concat", "-safe", "0", "-i", list,
        "-vf", `ass=${filterPath(captions)}:fontsdir=${filterPath(FONT_DIR)}`,
        "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "192k",
        "-movflags", "+faststart",
        output,
      ],
      (seconds) => stage("Adding captions and finishing", 80 + Math.min(19, (19 * seconds) / total)),
    );

    const size = fs.statSync(output).size;
    const previous = video.videoFile;
    db.updateVideo(videoId, {
      videoFile: { path: output, name: `${slug(video.title)}.mp4`, size, mimeType: "video/mp4" },
      status: ["idea", "scripted"].includes(video.status) ? "ready" : video.status,
      render: { ...video.render!, stage: "Done", progress: 100, finishedAt: new Date().toISOString() },
    });
    if (previous) fs.rm(previous.path, { force: true }, () => {});
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

function segmentArgs(visual: (Footage & { file: string }) | null, audio: string, duration: number, W: number, H: number, out: string) {
  const fit = `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}`;
  let input: string[];
  let video: string;
  if (visual?.kind === "video") {
    input = ["-stream_loop", "-1", "-i", visual.file];
    video = `[0:v]${fit},fps=${FPS}`;
  } else if (visual?.kind === "photo") {
    // Slow zoom so still photos don't look frozen.
    const frames = Math.ceil(duration * FPS);
    const big = `scale=${W * 1.5}:${H * 1.5}:force_original_aspect_ratio=increase,crop=${W * 1.5}:${H * 1.5}`;
    input = ["-loop", "1", "-i", visual.file];
    video = `[0:v]${big},zoompan=z='min(zoom+0.0007,1.2)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${W}x${H}:fps=${FPS}`;
  } else {
    input = ["-f", "lavfi", "-i", `color=c=0x111111:s=${W}x${H}:r=${FPS}`];
    video = "[0:v]null";
  }
  return [
    ...input,
    "-i", audio,
    "-filter_complex", `${video},setsar=1,format=yuv420p[v];[1:a]aresample=44100,apad[a]`,
    "-map", "[v]", "-map", "[a]",
    "-t", duration.toFixed(3),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-r", String(FPS),
    "-c:a", "aac", "-b:a", "192k", "-ar", "44100", "-ac", "2",
    out,
  ];
}

/** Word-timed captions: big, few words at a time for Shorts; subtitle-style for long videos. */
function buildCaptions(voices: { words: Word[]; duration: number }[], portrait: boolean, W: number, H: number) {
  const perLine = portrait ? 3 : 7;
  const style = portrait
    ? "Style: Default,Anton,115,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,0,0,0,0,100,100,1,0,1,6,2,5,60,60,0,1"
    : "Style: Default,Anton,72,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,0,0,0,0,100,100,1,0,1,4,1,2,120,120,70,1";
  const lines: string[] = [];
  let offset = 0;
  for (const voice of voices) {
    for (let i = 0; i < voice.words.length; i += perLine) {
      const chunk = voice.words.slice(i, i + perLine);
      const next = voice.words[i + perLine];
      const start = offset + chunk[0].start;
      // Hold each caption until the next one starts, so they don't flicker between words.
      const end = offset + (next ? next.start : chunk[chunk.length - 1].end + 0.2);
      let text = chunk.map((w) => w.text).join(" ").replace(/[{}\\]/g, "");
      if (portrait) text = text.toUpperCase();
      lines.push(`Dialogue: 0,${assTime(start)},${assTime(end)},Default,,0,0,0,,${text}`);
    }
    offset += voice.duration;
  }
  return `[Script Info]
ScriptType: v4.00+
PlayResX: ${W}
PlayResY: ${H}
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
${style}

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${lines.join("\n")}
`;
}

function assTime(seconds: number) {
  const cs = Math.max(0, Math.round(seconds * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
}

/** Escapes a path for use inside an FFmpeg filter argument. */
const filterPath = (p: string) => p.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'").replace(/,/g, "\\,");

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "video";

function ffmpeg(args: string[], onProgress?: (seconds: number) => void) {
  return new Promise<void>((resolve, reject) => {
    const proc = spawn(ffmpegPath!, ["-y", "-hide_banner", "-nostdin", ...args]);
    let log = "";
    proc.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      log = (log + text).slice(-4000);
      const match = onProgress && /time=(\d+):(\d+):([\d.]+)/.exec(text);
      if (match) onProgress!(Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]));
    });
    proc.on("error", reject);
    proc.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`Video editing failed:\n${log.slice(-800)}`))));
  });
}
