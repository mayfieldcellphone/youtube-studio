import fs from "node:fs";
import { google } from "googleapis";
import { db, type Channel, type Video } from "./db";
import { appUrl } from "./settings";

const SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube.readonly",
];

export const youtubeConfigured = () =>
  Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);

export const redirectUri = () => `${appUrl()}/api/youtube/callback`;

function oauthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    redirectUri(),
  );
}

export function authUrl(state: string) {
  return oauthClient().generateAuthUrl({
    access_type: "offline",
    // Always ask for consent so Google returns a refresh token and shows the channel picker.
    prompt: "consent select_account",
    scope: SCOPES,
    state,
  });
}

/** Exchanges the OAuth code and links the chosen YouTube channel to a studio channel. */
export async function completeAuth(channelId: string, code: string) {
  const auth = oauthClient();
  const { tokens } = await auth.getToken(code);
  if (!tokens.refresh_token) throw new Error("Google did not return a refresh token. Please try connecting again.");
  auth.setCredentials(tokens);

  const res = await google.youtube({ version: "v3", auth }).channels.list({
    part: ["snippet", "statistics"],
    mine: true,
  });
  const yt = res.data.items?.[0];
  if (!yt?.id) throw new Error("This Google account has no YouTube channel. Create one on youtube.com first.");

  db.updateChannel(channelId, {
    youtube: {
      channelId: yt.id,
      title: yt.snippet?.title ?? "",
      thumbnail: yt.snippet?.thumbnails?.default?.url ?? undefined,
      refreshToken: tokens.refresh_token,
      connectedAt: new Date().toISOString(),
    },
    stats: statsFrom(yt.statistics),
  });
}

function api(channel: Channel) {
  if (!channel.youtube) throw new Error("Connect this channel to YouTube first.");
  const auth = oauthClient();
  auth.setCredentials({ refresh_token: channel.youtube.refreshToken });
  return google.youtube({ version: "v3", auth });
}

function statsFrom(s?: { subscriberCount?: string | null; viewCount?: string | null; videoCount?: string | null } | null) {
  return {
    subscribers: Number(s?.subscriberCount ?? 0),
    views: Number(s?.viewCount ?? 0),
    videos: Number(s?.videoCount ?? 0),
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Uploads the video and hands scheduling to YouTube: the video is uploaded as private
 * with `publishAt`, and YouTube makes it public at that time even if this app is offline.
 */
export async function uploadAndSchedule(video: Video) {
  const channel = db.channel(video.channelId);
  if (!channel) throw new Error("Channel not found.");
  if (!video.videoFile) throw new Error("Upload the video file first.");
  if (!video.title.trim()) throw new Error("Add a title first.");

  const youtube = api(channel);
  const publishAt = video.scheduledAt && new Date(video.scheduledAt) > new Date() ? video.scheduledAt : undefined;

  const res = await youtube.videos.insert({
    part: ["snippet", "status"],
    requestBody: {
      snippet: {
        title: video.title.slice(0, 100),
        description: video.description.slice(0, 5000),
        tags: video.tags,
        categoryId: channel.categoryId || "22",
      },
      status: {
        ...(publishAt ? { privacyStatus: "private", publishAt } : { privacyStatus: "public" }),
        selfDeclaredMadeForKids: false,
        // YouTube requires disclosing realistic AI-generated footage.
        ...(video.aiFootageUsed && { containsSyntheticMedia: true }),
      },
    },
    media: { body: fs.createReadStream(video.videoFile.path) },
  });

  const youtubeVideoId = res.data.id;
  if (!youtubeVideoId) throw new Error("YouTube did not return a video ID.");
  console.log(
    `Uploaded "${video.title}" to YouTube (${youtubeVideoId}): ${res.data.status?.privacyStatus ?? "?"}` +
      (publishAt ? `, publish at ${res.data.status?.publishAt ?? "not accepted"}` : ""),
  );

  let thumbnailError: string | undefined;
  if (video.thumbnailFile) {
    try {
      await youtube.thumbnails.set({
        videoId: youtubeVideoId,
        media: { mimeType: video.thumbnailFile.mimeType, body: fs.createReadStream(video.thumbnailFile.path) },
      });
    } catch (err) {
      // Custom thumbnails need a phone-verified YouTube account; the upload itself still succeeded.
      thumbnailError = `Video uploaded, but the thumbnail was rejected: ${(err as Error).message}`;
    }
  }

  return db.updateVideo(video.id, {
    youtubeVideoId,
    status: publishAt ? "scheduled" : "published",
    scheduledAt: publishAt ?? new Date().toISOString(),
    error: thumbnailError,
  });
}

/**
 * Google keeps videos uploaded by apps it hasn't reviewed private, even when they are scheduled.
 * Shown on a video whose publish time has passed while YouTube still has it as private.
 */
export const LOCKED_PRIVATE =
  "YouTube kept this video private. Google only lets apps it has reviewed publish videos, and your Google Cloud project hasn't passed YouTube's API audit yet. To post it now: download the video below and upload it yourself in YouTube Studio (copy the title, description and tags from here), then delete the private copy. To fix it for good, request the audit: support.google.com/youtube/contact/yt_api_form";

/** Refreshes channel stats, per-video stats, and marks scheduled videos that have gone live (or stayed private). */
export async function syncChannel(channel: Channel) {
  const youtube = api(channel);

  const ch = await youtube.channels.list({ part: ["statistics"], mine: true });
  db.updateChannel(channel.id, { stats: statsFrom(ch.data.items?.[0]?.statistics) });

  const uploaded = db.videos(channel.id).filter((v) => v.youtubeVideoId);
  for (let i = 0; i < uploaded.length; i += 50) {
    const batch = uploaded.slice(i, i + 50);
    const res = await youtube.videos.list({
      part: ["statistics", "status"],
      id: batch.map((v) => v.youtubeVideoId!),
    });
    for (const item of res.data.items ?? []) {
      const video = batch.find((v) => v.youtubeVideoId === item.id);
      if (!video) continue;
      const isPublic = item.status?.privacyStatus === "public";
      const overdue = video.status === "scheduled" && video.scheduledAt && Date.now() - new Date(video.scheduledAt).getTime() > 15 * 60 * 1000;
      db.updateVideo(video.id, {
        status: isPublic ? "published" : video.status,
        ...(isPublic && video.error === LOCKED_PRIVATE && { error: undefined }),
        ...(!isPublic && overdue && { error: LOCKED_PRIVATE }),
        stats: {
          views: Number(item.statistics?.viewCount ?? 0),
          likes: Number(item.statistics?.likeCount ?? 0),
          comments: Number(item.statistics?.commentCount ?? 0),
          updatedAt: new Date().toISOString(),
        },
      });
    }
  }
}
