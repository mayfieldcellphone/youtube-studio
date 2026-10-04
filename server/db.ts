import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const DATA_DIR = path.resolve(process.env.DATA_DIR ?? "data");
export const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
/** Temporary files while making videos. Online this can point at the server's larger scratch disk. */
export const WORK_DIR = path.resolve(process.env.WORK_DIR ?? path.join(DATA_DIR, "work"));
const DB_FILE = path.join(DATA_DIR, "db.json");

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

export type VideoStatus = "idea" | "scripted" | "ready" | "scheduled" | "published" | "failed";
export type VideoFormat = "short" | "long";
export type VideoLook = "cinematic" | "clean" | "warm";

export interface YouTubeLink {
  channelId: string;
  title: string;
  thumbnail?: string;
  refreshToken: string;
  connectedAt: string;
}

export interface Channel {
  id: string;
  name: string;
  niche: string;
  audience: string;
  tone: string;
  language: string;
  /** 0 = Sunday … 6 = Saturday */
  postingDays: number[];
  /** "HH:MM" in the browser's local time */
  postingTime: string;
  categoryId: string;
  /** Narration engine; unset means the first one that's set up */
  voiceEngine?: "elevenlabs" | "gemini" | "kokoro";
  /** Voice within the engine */
  voiceId?: string;
  /** Gemini only: how the narrator should read, e.g. "slow, suspenseful documentary narrator" */
  voiceStyle?: string;
  /** Affiliate/product links the AI may add to descriptions, one per line */
  affiliateLinks?: string;
  /** Color grade for automatically made videos */
  look?: VideoLook;
  /** Stock footage, or an AI picture drawn for every shot */
  visuals?: "stock" | "pictures";
  /** How AI pictures should look; empty uses a style that fits the look */
  pictureStyle?: string;
  /** Which shots are made with Google Veo AI video instead of stock footage */
  aiFootage?: "off" | "hook" | "key" | "all";
  /** Veo model tier: fast is cheaper, best looks better */
  aiQuality?: "fast" | "best";
  /** Background music mixed quietly under the narration */
  musicFile?: StoredFile;
  /**
   * Characters who speak in dramatised scenes, each with their own ElevenLabs voice.
   * Script lines that start with a matching label ("JOAN: I deny it.") use that voice.
   */
  cast?: CastMember[];
  youtube?: YouTubeLink;
  stats?: { subscribers: number; views: number; videos: number; updatedAt: string };
  createdAt: string;
}

export interface CastMember {
  /** Speaker label used in scripts, e.g. "Joan" for lines starting "JOAN:" */
  name: string;
  /** ElevenLabs voice ID (a library, Voice Design or cloned voice) */
  voiceId: string;
}

export interface StoredFile {
  path: string;
  name: string;
  size: number;
  mimeType: string;
}

export interface Research {
  notes: string;
  sources: { title: string; url: string }[];
  createdAt: string;
}

export interface RenderJob {
  stage: string;
  /** 0-100 */
  progress: number;
  error?: string;
  /** Things that didn't go as planned but didn't stop the video (e.g. an AI shot fell back to stock). */
  notes?: string[];
  startedAt: string;
  finishedAt?: string;
}

export type StopAfter = "script" | "video" | "schedule";

/** Automatic production of a video through several steps (see pipeline.ts). */
export interface PipelineJob {
  stopAfter: StopAfter;
  step: string;
  result?: string;
  error?: string;
  startedAt: string;
  finishedAt?: string;
}

export interface Video {
  id: string;
  channelId: string;
  status: VideoStatus;
  format: VideoFormat;
  title: string;
  hook: string;
  keyword: string;
  angle: string;
  script: string;
  research?: Research;
  render?: RenderJob;
  /** The last made video contains AI-generated footage (disclosed to YouTube on upload). */
  aiFootageUsed?: boolean;
  /** The last made video has dramatised scenes voiced by AI characters (disclosed on upload). */
  characterVoicesUsed?: boolean;
  pipeline?: PipelineJob;
  titleOptions: string[];
  description: string;
  tags: string[];
  videoFile?: StoredFile;
  thumbnailFile?: StoredFile;
  scheduledAt?: string;
  youtubeVideoId?: string;
  error?: string;
  stats?: { views: number; likes: number; comments: number; updatedAt: string };
  createdAt: string;
  updatedAt: string;
}

interface Data {
  channels: Channel[];
  videos: Video[];
}

function load(): Data {
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { channels: [], videos: [] };
    throw err;
  }
}

const data: Data = load();

/** Writes the whole store atomically so a crash mid-write can't corrupt it. */
function save() {
  const tmp = `${DB_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

export const newId = () => crypto.randomUUID();
const now = () => new Date().toISOString();

export const db = {
  channels: () => data.channels,
  channel: (id: string) => data.channels.find((c) => c.id === id),

  createChannel(input: Omit<Channel, "id" | "createdAt">): Channel {
    const channel: Channel = { ...input, id: newId(), createdAt: now() };
    data.channels.push(channel);
    save();
    return channel;
  },

  updateChannel(id: string, patch: Partial<Channel>): Channel | undefined {
    const channel = db.channel(id);
    if (!channel) return undefined;
    Object.assign(channel, patch, { id });
    save();
    return channel;
  },

  deleteChannel(id: string) {
    for (const v of data.videos.filter((v) => v.channelId === id)) removeFiles(v);
    const music = db.channel(id)?.musicFile;
    if (music) fs.rm(music.path, { force: true }, () => {});
    data.channels = data.channels.filter((c) => c.id !== id);
    data.videos = data.videos.filter((v) => v.channelId !== id);
    save();
  },

  videos: (channelId?: string) =>
    channelId ? data.videos.filter((v) => v.channelId === channelId) : data.videos,
  video: (id: string) => data.videos.find((v) => v.id === id),

  createVideo(input: Partial<Video> & Pick<Video, "channelId" | "title">): Video {
    const video: Video = {
      status: "idea",
      format: "short",
      hook: "",
      keyword: "",
      angle: "",
      script: "",
      titleOptions: [],
      description: "",
      tags: [],
      ...input,
      id: newId(),
      createdAt: now(),
      updatedAt: now(),
    };
    data.videos.push(video);
    save();
    return video;
  },

  updateVideo(id: string, patch: Partial<Video>): Video | undefined {
    const video = db.video(id);
    if (!video) return undefined;
    Object.assign(video, patch, { id, updatedAt: now() });
    save();
    return video;
  },

  deleteVideo(id: string) {
    const video = db.video(id);
    if (video) removeFiles(video);
    data.videos = data.videos.filter((v) => v.id !== id);
    save();
  },
};

function removeFiles(video: Video) {
  for (const file of [video.videoFile, video.thumbnailFile]) {
    if (file) fs.rm(file.path, { force: true }, () => {});
  }
}

/** Strips secrets (the YouTube refresh token) before sending a channel to the browser. */
export function publicChannel(channel: Channel) {
  const { youtube, musicFile, ...rest } = channel;
  return {
    ...rest,
    musicFile: musicFile && { name: musicFile.name, size: musicFile.size, mimeType: musicFile.mimeType },
    youtube: youtube && {
      channelId: youtube.channelId,
      title: youtube.title,
      thumbnail: youtube.thumbnail,
      connectedAt: youtube.connectedAt,
    },
  };
}

/** Hides server file paths from the browser. */
export function publicVideo(video: Video) {
  const strip = (f?: StoredFile) => f && { name: f.name, size: f.size, mimeType: f.mimeType };
  return { ...video, videoFile: strip(video.videoFile), thumbnailFile: strip(video.thumbnailFile) };
}
