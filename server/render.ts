import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import ffmpegPath from "ffmpeg-static";
import { DATA_DIR, db, UPLOAD_DIR, type VideoLook } from "./db";
import { planScenes } from "./ai";
import { download, findFootage, type Footage, type Word } from "./media";
import { synthesizeScenes, voiceFor } from "./voices";

const FONT_DIR = path.resolve("assets/fonts");
const FPS = 30;
/** Silence after each scene so sentences don't run into each other. */
const GAP = 0.25;

export const ffmpegAvailable = () => Boolean(ffmpegPath && fs.existsSync(ffmpegPath));

const rendering = new Set<string>();
let queue: Promise<unknown> = Promise.resolve();

export const isRendering = (videoId: string) => rendering.has(videoId);

/**
 * Renders are CPU-heavy, so they run one at a time. The returned promise settles when this
 * video is finished (callers that don't wait should attach a catch).
 */
export function startRender(videoId: string): Promise<void> {
  if (rendering.has(videoId)) throw new Error("This video is already being made.");
  rendering.add(videoId);
  db.updateVideo(videoId, { render: { stage: "Waiting to start", progress: 0, startedAt: new Date().toISOString() } });
  const job = queue.then(() => render(videoId));
  queue = job
    .catch((err: Error) => {
      console.error(`[${new Date().toLocaleTimeString()}] Making video ${videoId} failed: ${err.message}`);
      const video = db.video(videoId);
      if (video?.render) db.updateVideo(videoId, { render: { ...video.render, error: err.message, finishedAt: new Date().toISOString() } });
    })
    .finally(() => rendering.delete(videoId));
  return job;
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
    const voice = voiceFor(channel);
    const narrated = await synthesizeScenes(
      scenes.map((s) => s.narration),
      voice,
      path.join(work, "voice"),
      (done, total) => stage(`Recording voiceover (${done + 1}/${total})`, 6 + (29 * done) / total),
    );
    const voices = narrated.map((v) => ({ ...v, duration: Math.max(v.duration, 0.5) + GAP }));

    // 2. Plan shots: each scene's time is split between its shots. Frame counts come from
    //    cumulative times so the picture never drifts from the narration.
    const shots: { query: string; fallback: string; frames: number }[] = [];
    let elapsed = 0;
    for (const [i, scene] of scenes.entries()) {
      const each = voices[i].duration / scene.shots.length;
      for (const query of scene.shots) {
        const frames = Math.round((elapsed + each) * FPS) - Math.round(elapsed * FPS);
        elapsed += each;
        shots.push({ query, fallback: scene.fallbackQuery, frames: Math.max(frames, 1) });
      }
    }
    const total = elapsed;

    // 3. Stock footage for each shot, never reusing a clip within the video.
    const used = new Set<string>();
    const visuals: ((Footage & { file: string }) | null)[] = [];
    for (const [i, shot] of shots.entries()) {
      stage(`Finding footage (${i + 1}/${shots.length})`, 35 + (20 * i) / shots.length);
      const found = (await findFootage(shot.query, portrait, used)) ?? (await findFootage(shot.fallback, portrait, used));
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

    // 4. Edit each shot: crop to fit, slow camera movement, color grade.
    const look = LOOKS[channel.look ?? "clean"];
    const segments: string[] = [];
    for (const [i, shot] of shots.entries()) {
      stage(`Editing shots (${i + 1}/${shots.length})`, 55 + (25 * i) / shots.length);
      const out = path.join(work, `shot-${i}.mp4`);
      await ffmpeg(shotArgs(visuals[i], shot.frames, i, W, H, look, out));
      segments.push(out);
    }

    // 5. One continuous narration track, each scene padded to its exact length.
    stage("Mixing audio", 80);
    const voiceParts: string[] = [];
    for (const [i, voice] of voices.entries()) {
      const out = path.join(work, `narration-${i}.wav`);
      await ffmpeg(["-i", voice.file, "-af", "aresample=44100,apad", "-t", voice.duration.toFixed(3), "-ac", "2", out]);
      voiceParts.push(out);
    }

    // 6. Join shots, burn in captions, add narration and music.
    // The final step runs inside the work folder and refers to files by bare name: FFmpeg's
    // filter syntax treats ":" as a separator, so Windows paths like C:\... break it.
    stage("Adding captions and finishing", 82);
    const writeList = (name: string, files: string[]) =>
      fs.writeFileSync(path.join(work, name), files.map((f) => `file '${path.basename(f)}'`).join("\n"));
    writeList("shots.txt", segments);
    writeList("voice.txt", voiceParts);
    fs.mkdirSync(path.join(work, "fonts"));
    for (const font of fs.readdirSync(FONT_DIR).filter((f) => /\.(ttf|otf)$/i.test(f))) {
      fs.copyFileSync(path.join(FONT_DIR, font), path.join(work, "fonts", font));
    }
    fs.writeFileSync(path.join(work, "captions.ass"), buildCaptions(voices, portrait, W, H));

    const music = channel.musicFile && fs.existsSync(channel.musicFile.path) ? channel.musicFile.path : null;
    const fadeOut = Math.max(0, total - 2.5).toFixed(2);
    const audioGraph = music
      ? // Music sits quietly under the voice and ducks further whenever the narrator speaks.
        `[2:a]aresample=44100,volume=0.25,afade=t=in:d=1.5,afade=t=out:st=${fadeOut}:d=2.5[m];` +
        `[1:a]asplit=2[n1][n2];[m][n1]sidechaincompress=threshold=0.02:ratio=10:attack=15:release=400[duck];` +
        `[n2][duck]amix=inputs=2:duration=first:normalize=0[a]`
      : `[1:a]anull[a]`;
    const output = path.join(UPLOAD_DIR, `${crypto.randomUUID()}.mp4`);
    await ffmpeg(
      [
        "-f", "concat", "-safe", "0", "-i", "shots.txt",
        "-f", "concat", "-safe", "0", "-i", "voice.txt",
        ...(music ? ["-stream_loop", "-1", "-i", music] : []),
        "-filter_complex", `[0:v]ass=captions.ass:fontsdir=fonts[v];${audioGraph}`,
        "-map", "[v]", "-map", "[a]",
        "-t", total.toFixed(3),
        // Capped near YouTube's recommended 1080p bitrate so uploads stay reasonably small.
        "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-maxrate", "10M", "-bufsize", "20M", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "192k",
        "-movflags", "+faststart",
        output,
      ],
      (seconds) => stage("Adding captions and finishing", 82 + Math.min(17, (17 * seconds) / total)),
      work,
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

/** Color grades per channel look. Applied to every shot. */
const LOOKS: Record<VideoLook, string> = {
  // Moody documentary: darker, desaturated, with a vignette. (No film grain: it makes files
  // several times bigger because grain can't be compressed.)
  cinematic: "eq=contrast=1.12:saturation=0.72:brightness=-0.035,vignette=PI/4.5",
  // Bright and crisp for tech/tutorial content.
  clean: "eq=contrast=1.05:saturation=1.08",
  // Friendly and warm for lifestyle/money content.
  warm: "eq=contrast=1.06:saturation=1.1,colorbalance=rs=0.05:gs=0.01:bs=-0.05,vignette=PI/6",
};

function shotArgs(
  visual: (Footage & { file: string }) | null,
  frames: number,
  index: number,
  W: number,
  H: number,
  look: string,
  out: string,
) {
  const seconds = frames / FPS;
  // Alternate the direction of movement so consecutive shots don't all drift the same way.
  const forward = index % 2 === 0;
  let input: string[];
  let video: string;
  if (visual?.kind === "video") {
    // Slightly oversize, then pan slowly across: reads as a deliberate camera move.
    const [bw, bh] = [Math.round(W * 1.08), Math.round(H * 1.08)];
    const progress = forward ? `(t/${seconds.toFixed(3)})` : `(1-t/${seconds.toFixed(3)})`;
    input = ["-stream_loop", "-1", "-i", visual.file];
    video =
      `[0:v]fps=${FPS},scale=${bw}:${bh}:force_original_aspect_ratio=increase,crop=${bw}:${bh},` +
      `crop=${W}:${H}:x='(iw-ow)*min(1,${progress})':y='(ih-oh)/2'`;
  } else if (visual?.kind === "photo") {
    // Slow zoom (in or out) so still photos don't look frozen.
    const [bw, bh] = [Math.round(W * 1.5), Math.round(H * 1.5)];
    const zoom = forward ? `min(1+0.0009*on,1.25)` : `max(1.25-0.0009*on,1)`;
    input = ["-loop", "1", "-i", visual.file];
    video =
      `[0:v]scale=${bw}:${bh}:force_original_aspect_ratio=increase,crop=${bw}:${bh},` +
      `zoompan=z='${zoom}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${W}x${H}:fps=${FPS}`;
  } else {
    input = ["-f", "lavfi", "-i", `color=c=0x111111:s=${W}x${H}:r=${FPS}`];
    video = "[0:v]null";
  }
  return [
    ...input,
    "-filter_complex", `${video},${look},setsar=1,format=yuv420p[v]`,
    "-map", "[v]",
    "-frames:v", String(frames),
    "-an",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-r", String(FPS),
    out,
  ];
}

const GOLD = "&H004AB8E8&";
const WHITE = "&H00FFFFFF&";

/**
 * Word-timed captions. Shorts: 3 big words at a time with the spoken word in gold and a small
 * pop when a new line appears. Long videos: clean subtitle lines.
 */
function buildCaptions(voices: { words: Word[]; duration: number }[], portrait: boolean, W: number, H: number) {
  const perLine = portrait ? 3 : 7;
  const style = portrait
    ? "Style: Default,Anton,118,&H00FFFFFF,&H00FFFFFF,&H00000000,&H96000000,0,0,0,0,100,100,1,0,1,7,3,5,60,60,0,1"
    : "Style: Default,Anton,72,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,0,0,0,0,100,100,1,0,1,4,1,2,120,120,70,1";
  const clean = (t: string) => {
    const text = t.replace(/[{}\\]/g, "");
    return portrait ? text.toUpperCase() : text;
  };
  const lines: string[] = [];
  let offset = 0;
  for (const voice of voices) {
    for (let i = 0; i < voice.words.length; i += perLine) {
      const chunk = voice.words.slice(i, i + perLine);
      const next = voice.words[i + perLine];
      // Hold each line until the next one starts, so captions don't flicker between words.
      const chunkEnd = offset + (next ? next.start : chunk[chunk.length - 1].end + 0.25);
      if (!portrait) {
        const text = chunk.map((w) => clean(w.text)).join(" ");
        lines.push(`Dialogue: 0,${assTime(offset + chunk[0].start)},${assTime(chunkEnd)},Default,,0,0,0,,${text}`);
        continue;
      }
      chunk.forEach((word, j) => {
        const start = offset + word.start;
        const end = j + 1 < chunk.length ? offset + chunk[j + 1].start : chunkEnd;
        const text = chunk
          .map((w, k) => (k === j ? `{\\c${GOLD}}${clean(w.text)}{\\c${WHITE}}` : clean(w.text)))
          .join(" ");
        const pop = j === 0 ? "{\\fscx112\\fscy112\\t(0,120,\\fscx100\\fscy100)}" : "";
        lines.push(`Dialogue: 0,${assTime(start)},${assTime(end)},Default,,0,0,0,,${pop}${text}`);
      });
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

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "video";

function ffmpeg(args: string[], onProgress?: (seconds: number) => void, cwd?: string) {
  return new Promise<void>((resolve, reject) => {
    const proc = spawn(ffmpegPath!, ["-y", "-hide_banner", "-nostdin", ...args], { cwd });
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
