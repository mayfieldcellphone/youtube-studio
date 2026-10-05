import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import ffmpegPath from "ffmpeg-static";
import { db, UPLOAD_DIR, WORK_DIR, type VideoLook } from "./db";
import { planScenes } from "./ai";
import { download, findFootage, voiceConfigured, type Footage, type Word } from "./media";
import { synthesizeScenes, voiceFor, type CharacterLine } from "./voices";
import { castVoice, NARRATOR } from "./speakers";
import { hedraConfigured, talkingClip } from "./hedra";
import { ensurePortrait } from "./portraits";
import { CLIP_SECONDS, makeClips } from "./veo";
import { DEFAULT_PICTURE_STYLES, makePictures } from "./images";

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
  const work = path.join(WORK_DIR, video.id);
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
    //    Scenes spoken by a character use that character's ElevenLabs voice from the channel's cast.
    const notes: string[] = [];
    const unvoiced = new Set<string>();
    const members = scenes.map((scene) => {
      if (scene.speaker === NARRATOR) return undefined;
      const member = castVoice(channel, scene.speaker, video);
      if (!member) unvoiced.add(scene.speaker);
      return member;
    });
    const characters: (CharacterLine | undefined)[] = members.map(
      (member, i) => member && { voiceId: member.voiceId, delivery: scenes[i].delivery },
    );
    if (characters.some(Boolean) && !voiceConfigured()) {
      throw new Error("This script has character lines, which are voiced by ElevenLabs. Add your ElevenLabs key on the Setup page, or remove the speaker labels from the script.");
    }
    for (const name of unvoiced) {
      notes.push(`No voice is set for ${name}, so the narrator read those lines. Add ${name} under Characters on this video's page.`);
    }
    const voice = voiceFor(channel);
    const narrated = await synthesizeScenes(
      scenes.map((s) => s.narration),
      voice,
      path.join(work, "voice"),
      (done, total) => stage(`Recording voiceover (${done + 1}/${total})`, 6 + (29 * done) / total),
      characters,
    );
    const voices = narrated.map((v) => ({ ...v, duration: Math.max(v.duration, 0.5) + GAP }));

    // 1b. Characters appear while they speak: their painted portrait, lip-synced to their line
    //     by Hedra when it's set up, otherwise the portrait with a slow push-in.
    const characterShots = await characterVisuals(video, members, narrated, portrait, work, notes, (name, p) => stage(name, 35 + 6 * p));

    // 2. Plan shots: each scene's time is split between its shots. Frame counts come from
    //    cumulative times so the picture never drifts from the narration. Scenes chosen for
    //    AI footage open with one Veo clip (up to 8 s); any remaining time uses stock shots.
    const aiScenes = pickAiScenes(channel.aiFootage ?? "off", scenes);
    const shots: { query: string; fallback: string; frames: number; picture: string; aiPrompt?: string; fixed?: Visual }[] = [];
    let elapsed = 0;
    const addShot = (seconds: number, shot: Omit<(typeof shots)[number], "frames">) => {
      const frames = Math.round((elapsed + seconds) * FPS) - Math.round(elapsed * FPS);
      elapsed += seconds;
      shots.push({ ...shot, frames: Math.max(frames, 1) });
    };
    for (const [i, scene] of scenes.entries()) {
      const duration = voices[i].duration;
      const speaker = characterShots.get(i);
      if (speaker) {
        addShot(duration, { query: scene.fallbackQuery, picture: "", fallback: scene.fallbackQuery, fixed: speaker });
        continue;
      }
      let planned = scene.shots;
      let remaining = duration;
      if (aiScenes.has(i)) {
        // A clip slightly shorter than the scene just loops for the last moment.
        const aiSeconds = duration - CLIP_SECONDS > 1.5 ? CLIP_SECONDS : duration;
        const first = scene.shots[0];
        addShot(aiSeconds, { query: first.search, picture: first.picture, fallback: scene.fallbackQuery, aiPrompt: scene.aiPrompt });
        remaining -= aiSeconds;
        planned = scene.shots.slice(1).length ? scene.shots.slice(1) : scene.shots.slice(0, 1);
      }
      if (remaining <= 0.01) continue;
      for (const shot of planned) {
        addShot(remaining / planned.length, { query: shot.search, picture: shot.picture, fallback: scene.fallbackQuery });
      }
    }
    const total = elapsed;

    // 3a. AI shots from Veo; any that fail fall back to stock footage below.
    const aiFiles = new Map<number, string>();
    const aiShots = shots.flatMap((s, i) => (s.aiPrompt ? [i] : []));
    if (aiShots.length) {
      const label = (done: number) => `Creating AI shots with Veo (${done}/${aiShots.length}), about 1-3 minutes each`;
      stage(label(0), 35);
      const requests = aiShots.map((i) => ({ prompt: shots[i].aiPrompt!, outFile: path.join(work, `ai-${i}.mp4`) }));
      const results = await makeClips(requests, channel.aiQuality ?? "fast", portrait, (done) =>
        stage(label(done), 35 + (6 * done) / aiShots.length),
      );
      const failures = new Map<string, number>();
      results.forEach((result, k) => {
        if (result === true) aiFiles.set(aiShots[k], requests[k].outFile);
        else failures.set(result, (failures.get(result) ?? 0) + 1);
      });
      for (const [reason, count] of failures) {
        notes.push(`${count} AI shot${count > 1 ? "s" : ""} used stock footage instead. ${reason}`);
      }
    }

    // 3b. AI pictures for the other shots, if the channel uses them; failures use stock footage.
    const pictureFiles = new Map<number, string>();
    if (channel.visuals === "pictures") {
      const wanted = shots.flatMap((s, i) => (aiFiles.has(i) || s.fixed ? [] : [i]));
      const label = (done: number) => `Drawing AI pictures (${done}/${wanted.length})`;
      stage(label(0), 41);
      const style = channel.pictureStyle?.trim() || DEFAULT_PICTURE_STYLES[channel.look ?? "clean"];
      const results = await makePictures(
        wanted.map((i) => ({ prompt: shots[i].picture, outBase: path.join(work, `picture-${i}`) })),
        style,
        portrait,
        (done) => stage(label(done), 41 + (6 * done) / wanted.length),
      );
      const failures = new Map<string, number>();
      results.forEach((result, k) => {
        if (typeof result !== "string") pictureFiles.set(wanted[k], result.file);
        else failures.set(result, (failures.get(result) ?? 0) + 1);
      });
      for (const [reason, count] of failures) {
        notes.push(`${count} AI picture${count > 1 ? "s" : ""} used stock footage instead. ${reason}`);
      }
    }

    // 3c. Stock footage for every other shot, never reusing a clip within the video.
    const used = new Set<string>();
    const visuals: (Visual | null)[] = [];
    for (const [i, shot] of shots.entries()) {
      if (shot.fixed) {
        visuals.push(shot.fixed);
        continue;
      }
      const aiFile = aiFiles.get(i);
      if (aiFile) {
        visuals.push({ id: `ai-${i}`, kind: "video", url: "", file: aiFile });
        continue;
      }
      const pictureFile = pictureFiles.get(i);
      if (pictureFile) {
        visuals.push({ id: `picture-${i}`, kind: "photo", url: "", file: pictureFile });
        continue;
      }
      stage(`Finding footage (${i + 1}/${shots.length})`, 47 + (8 * i) / shots.length);
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
    fs.writeFileSync(
      path.join(work, "captions.ass"),
      buildCaptions(voices.map((v, i) => ({ ...v, speaker: characters[i] ? members[i]?.name : undefined })), portrait, W, H),
    );

    const music = channel.musicFile && fs.existsSync(channel.musicFile.path) ? channel.musicFile.path : null;
    const fadeOut = Math.max(0, total - 2.5).toFixed(2);
    const audioGraph = music
      ? // Music sits quietly under the voice and ducks further whenever the narrator speaks.
        `[2:a]aresample=44100,volume=0.25,afade=t=in:d=1.5,afade=t=out:st=${fadeOut}:d=2.5[m];` +
        `[1:a]asplit=2[n1][n2];[m][n1]sidechaincompress=threshold=0.02:ratio=10:attack=15:release=400[duck];` +
        `[n2][duck]amix=inputs=2:duration=first:normalize=0[a]`
      : `[1:a]anull[a]`;
    // Rendered in the work folder, then moved: "+faststart" briefly needs twice the file size.
    const rendered = path.join(work, "final.mp4");
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
        "final.mp4",
      ],
      (seconds) => stage("Adding captions and finishing", 82 + Math.min(17, (17 * seconds) / total)),
      work,
    );

    const output = path.join(UPLOAD_DIR, `${crypto.randomUUID()}.mp4`);
    moveFile(rendered, output);
    const size = fs.statSync(output).size;
    const previous = video.videoFile;
    db.updateVideo(videoId, {
      videoFile: { path: output, name: `${slug(video.title)}.mp4`, size, mimeType: "video/mp4" },
      status: ["idea", "scripted"].includes(video.status) ? "ready" : video.status,
      // Realistic AI video, pictures and character voices all need YouTube's altered/synthetic content label.
      aiFootageUsed: aiFiles.size > 0 || pictureFiles.size > 0 || characters.some(Boolean),
      characterVoicesUsed: characters.some(Boolean),
      render: { ...video.render!, stage: "Done", progress: 100, notes, finishedAt: new Date().toISOString() },
    });
    if (previous) fs.rm(previous.path, { force: true }, () => {});
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

/** Up to this many Veo clips in one video, to keep costs predictable. */
export const MAX_AI_SHOTS = 12;

/** Scene numbers that get an AI shot: the opening hook, the key moments, or all. */
export function pickAiScenes(mode: "off" | "hook" | "key" | "all", scenes: { keyMoment?: boolean }[]) {
  if (mode === "off" || !scenes.length) return new Set<number>();
  if (mode === "all") return new Set(scenes.map((_, i) => i).slice(0, MAX_AI_SHOTS));
  const picked = [0];
  if (mode === "key") picked.push(...scenes.flatMap((s, i) => (s.keyMoment && i > 0 ? [i] : [])).slice(0, 2));
  return new Set(picked);
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

/** What fills the screen for one shot. `hold` = a speaking character: no camera pan, last frame held. */
type Visual = Footage & { file: string; hold?: boolean };

function shotArgs(
  visual: Visual | null,
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
  if (visual?.kind === "video" && visual.hold) {
    // A talking clip: framed still, and its last frame held for the short pause after the line.
    input = ["-i", visual.file];
    video =
      `[0:v]fps=${FPS},scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},` +
      `tpad=stop_mode=clone:stop_duration=${(seconds + 1).toFixed(2)}`;
  } else if (visual?.kind === "video") {
    // Slightly oversize, then pan slowly across: reads as a deliberate camera move.
    const [bw, bh] = [Math.round(W * 1.08), Math.round(H * 1.08)];
    const progress = forward ? `(t/${seconds.toFixed(3)})` : `(1-t/${seconds.toFixed(3)})`;
    input = ["-stream_loop", "-1", "-i", visual.file];
    video =
      `[0:v]fps=${FPS},scale=${bw}:${bh}:force_original_aspect_ratio=increase,crop=${bw}:${bh},` +
      `crop=${W}:${H}:x='(iw-ow)*min(1,${progress})':y='(ih-oh)/2'`;
  } else if (visual?.kind === "photo") {
    // Slow camera moves so stills don't look frozen, rotating between zoom in, pan right,
    // zoom out and pan left. The picture is enlarged first so the movement stays smooth.
    const [bw, bh] = [Math.round(W * 1.5), Math.round(H * 1.5)];
    const t = `min(on/${Math.max(frames - 1, 1)},1)`;
    const moves = [
      { z: `1+0.18*${t}`, x: "iw/2-(iw/zoom/2)" },
      { z: "1.15", x: `(iw-iw/zoom)*${t}` },
      { z: `1.18-0.18*${t}`, x: "iw/2-(iw/zoom/2)" },
      { z: "1.15", x: `(iw-iw/zoom)*(1-${t})` },
    ];
    // A speaking character's portrait always pushes in slowly towards the face.
    const move = visual.hold ? moves[0] : moves[index % moves.length];
    input = ["-loop", "1", "-i", visual.file];
    video =
      `[0:v]scale=${bw}:${bh}:force_original_aspect_ratio=increase,crop=${bw}:${bh},` +
      `zoompan=z='${move.z}':x='${move.x}':y='ih/2-(ih/zoom/2)':d=${frames}:s=${W}x${H}:fps=${FPS}`;
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
export function buildCaptions(
  voices: { words: Word[]; duration: number; speaker?: string }[],
  portrait: boolean,
  W: number,
  H: number,
) {
  const perLine = portrait ? 3 : 7;
  const style = portrait
    ? "Style: Default,Anton,118,&H00FFFFFF,&H00FFFFFF,&H00000000,&H96000000,0,0,0,0,100,100,1,0,1,7,3,5,60,60,0,1"
    : "Style: Default,Anton,72,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,0,0,0,0,100,100,1,0,1,4,1,2,120,120,70,1";
  const labelStyle = portrait
    ? "Style: Label,Anton,52,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,0,0,0,0,100,100,4,0,3,10,0,7,60,60,200,1"
    : "Style: Label,Anton,30,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,0,0,0,0,100,100,3,0,3,8,0,7,60,60,50,1";
  const clean = (t: string) => {
    const text = t.replace(/[{}\\]/g, "");
    return portrait ? text.toUpperCase() : text;
  };
  const lines: string[] = [];
  let offset = 0;
  // A small "DRAMATISATION" label in the top corner while a character speaks.
  const label = (start: number, end: number, speaker: string) =>
    `Dialogue: 1,${assTime(start)},${assTime(end)},Label,,0,0,0,,${speaker.replace(/[{}\\]/g, "").toUpperCase()} · DRAMATISATION`;
  for (const [scene, voice] of voices.entries()) {
    if (voice.speaker && voices[scene - 1]?.speaker !== voice.speaker) {
      // One label per run of lines by the same character.
      let end = offset;
      for (let k = scene; k < voices.length && voices[k].speaker === voice.speaker; k++) end += voices[k].duration;
      lines.push(label(offset, end, voice.speaker));
    }
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
${labelStyle}

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

/** Moves a file, copying when the two folders are on different disks. */
function moveFile(from: string, to: string) {
  try {
    fs.renameSync(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    fs.copyFileSync(from, to);
    fs.rmSync(from, { force: true });
  }
}

// Encoder statistics and progress lines FFmpeg prints on every run; they hide the real error.
const FFMPEG_NOISE = /^\[(libx264|aac) @|^(frame|size)=|^\s*$|^video:\d/;

function ffmpeg(args: string[], onProgress?: (seconds: number) => void, cwd?: string) {
  return new Promise<void>((resolve, reject) => {
    const proc = spawn(ffmpegPath!, ["-y", "-hide_banner", "-nostdin", "-loglevel", "error", "-stats", ...args], { cwd });
    let log = "";
    proc.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      log = (log + text).slice(-20000);
      const match = onProgress && /time=(\d+):(\d+):([\d.]+)/.exec(text);
      if (match) onProgress!(Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]));
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) return resolve();
      const lines = log.split(/[\r\n]+/).filter((line) => !FFMPEG_NOISE.test(line));
      console.error(`FFmpeg failed (exit ${code}):\n${lines.slice(-40).join("\n")}`);
      if (/No space left on device/i.test(log)) {
        return reject(new Error("The app's storage is full, so the video couldn't be saved. Delete videos you no longer need, or give the app more storage (on Railway: upgrade to Hobby for 5 GB)."));
      }
      reject(new Error(`Video editing failed:\n${lines.slice(-8).join("\n").slice(-800)}`));
    });
  });
}

/**
 * The picture for each character scene: a Hedra talking clip of the character's portrait
 * saying the line, or the portrait itself. Scenes left out (no portrait could be made, or the
 * character comes from the channel's recurring cast) use normal footage. Problems become notes.
 */
async function characterVisuals(
  video: { id: string },
  members: ({ name: string } | undefined)[],
  narrated: { file: string; duration: number }[],
  portrait: boolean,
  work: string,
  notes: string[],
  stage: (name: string, progress: number) => void,
) {
  const shots = new Map<number, Visual>();
  const scenes = members.flatMap((m, i) => (m ? [i] : []));
  if (!scenes.length) return shots;
  const orientation = portrait ? "portrait" : "landscape";

  stage("Painting character portraits", 0);
  const portraits = new Map<string, string | null>();
  for (const i of scenes) {
    const name = members[i]!.name;
    if (portraits.has(name)) continue;
    try {
      portraits.set(name, await ensurePortrait(video.id, name, orientation));
    } catch (err) {
      portraits.set(name, null);
      notes.push(`${name} has no portrait, so their lines show normal footage. ${(err as Error).message}`);
    }
  }

  const withPortrait = scenes.filter((i) => portraits.get(members[i]!.name));
  let talkingFailed = !hedraConfigured();
  for (const [k, i] of withPortrait.entries()) {
    const image = portraits.get(members[i]!.name)!;
    if (!talkingFailed) {
      stage(`Animating characters (${k + 1}/${withPortrait.length}), about a minute each`, k / withPortrait.length);
      try {
        const file = await talkingClip(image, narrated[i].file, portrait, path.join(work, `talk-${i}.mp4`));
        shots.set(i, { id: `talk-${i}`, kind: "video", url: "", file, hold: true });
        continue;
      } catch (err) {
        // One failure usually means all would fail (key, credits): show portraits for the rest.
        talkingFailed = true;
        notes.push(`Characters are shown as still portraits instead of talking. ${(err as Error).message}`);
      }
    }
    shots.set(i, { id: `portrait-${i}`, kind: "photo", url: "", file: image, hold: true });
  }
  return shots;
}
