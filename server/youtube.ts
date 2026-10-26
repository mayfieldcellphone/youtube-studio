import fs from "node:fs";
import { google } from "googleapis";
import { db, type Channel, type Video } from "./db";
import { appUrl } from "./settings";
import {
  analyticsDue,
  analyticsFlag,
  assertLaneMatches,
  assertSlotFree,
  assertVariation,
  buildDescription,
  buildTags,
  checkShortScript,
  finalTitle,
  isHistoryChannel,
  rewriteAdvice,
  SHORT_MAX_SECONDS,
  ANALYTICS_FREEZE_HOURS,
} from "./policy";

const SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube.readonly",
  // Playlists: creating the series playlist and adding each upload to it.
  "https://www.googleapis.com/auth/youtube",
  // 48-hour views, average percentage viewed and subscribers gained.
  "https://www.googleapis.com/auth/yt-analytics.readonly",
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

/** Revokes the channel's Google token. Best effort: the stored data is deleted either way. */
export async function revokeAccess(channel: Channel) {
  if (!channel.youtube?.refreshToken) return;
  try {
    await oauthClient().revokeToken(channel.youtube.refreshToken);
  } catch (err) {
    console.error(`Revoking Google access for ${channel.name} failed (deleting its data anyway): ${(err as Error).message}`);
  }
}

function authFor(channel: Channel) {
  if (!channel.youtube) throw new Error("Connect this channel to YouTube first.");
  const auth = oauthClient();
  auth.setCredentials({ refresh_token: channel.youtube.refreshToken });
  return auth;
}

function api(channel: Channel) {
  return google.youtube({ version: "v3", auth: authFor(channel) });
}

/** Throws if the connected Google login is not the YouTube channel this studio channel was linked to. */
async function assertRightYouTubeChannel(youtube: ReturnType<typeof api>, channel: Channel) {
  const res = await youtube.channels.list({ part: ["id", "snippet"], mine: true });
  const id = res.data.items?.[0]?.id;
  if (id && channel.youtube && id !== channel.youtube.channelId) {
    throw new Error(
      `"${channel.name}" is linked to YouTube channel ${channel.youtube.title}, but its Google login now points at "${res.data.items?.[0]?.snippet?.title}". Reconnect the channel before uploading.`,
    );
  }
}

/** Finds (or creates) the playlist named after the series on this channel. */
async function ensurePlaylist(youtube: ReturnType<typeof api>, channel: Channel, name: string, fresh = false): Promise<string> {
  const cached = channel.playlists?.[name];
  if (cached && !fresh) return cached;
  let pageToken: string | undefined;
  let id: string | undefined;
  do {
    const res = await youtube.playlists.list({ part: ["snippet"], mine: true, maxResults: 50, pageToken });
    id = res.data.items?.find((p) => p.snippet?.title?.trim().toLowerCase() === name.toLowerCase())?.id ?? undefined;
    pageToken = id ? undefined : (res.data.nextPageToken ?? undefined);
  } while (pageToken);
  if (!id) {
    const created = await youtube.playlists.insert({
      part: ["snippet", "status"],
      requestBody: {
        snippet: { title: name, description: `${name}: every episode in order.`, defaultLanguage: "en" },
        status: { privacyStatus: "public" },
      },
    });
    id = created.data.id ?? undefined;
  }
  if (!id) throw new Error(`Could not create the "${name}" playlist.`);
  db.updateChannel(channel.id, { playlists: { ...(db.channel(channel.id)?.playlists ?? {}), [name]: id } });
  return id;
}

async function addToPlaylist(youtube: ReturnType<typeof api>, channel: Channel, name: string, videoId: string) {
  const insert = (playlistId: string) =>
    youtube.playlistItems.insert({
      part: ["snippet"],
      requestBody: { snippet: { playlistId, resourceId: { kind: "youtube#video", videoId } } },
    });
  let playlistId = await ensurePlaylist(youtube, channel, name);
  try {
    await insert(playlistId);
  } catch (err) {
    // A playlist deleted on YouTube leaves a stale ID in the cache: look it up again once.
    if (!/not ?found/i.test((err as Error).message)) throw err;
    playlistId = await ensurePlaylist(youtube, channel, name, true);
    await insert(playlistId);
  }
  return playlistId;
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
const DRAMATISATION_NOTE =
  "Dramatized dialogue based on historical accounts. Character voices are AI-generated and their lines are reconstructions, not verified quotes unless a source is named.";

/** Videos with acted character lines say so in the description, as well as in the video. */
function withDisclosure(video: Video) {
  if (!video.characterVoicesUsed || video.description.includes(DRAMATISATION_NOTE) || video.description.includes("Dramatized dialogue based on historical accounts")) return video.description;
  return `${video.description.trim()}\n\n${DRAMATISATION_NOTE}`.trim();
}

/** Lines in a description that must survive the channel template: links and the dramatisation note. */
function extraLines(video: Video) {
  const lines = video.description.split(/\n+/).map((l) => l.trim());
  const keep = lines.filter((l) => /https?:\/\//i.test(l) || /affiliate/i.test(l));
  if (video.characterVoicesUsed) keep.push(DRAMATISATION_NOTE);
  return [...new Set(keep)];
}

/** Whether the video has AI voice or AI visuals (made by the app, or flagged), which YouTube wants disclosed. */
export const usesSyntheticMedia = (video: Video) =>
  Boolean(video.render || video.aiFootageUsed || video.characterVoicesUsed);

export async function uploadAndSchedule(video: Video) {
  const channel = db.channel(video.channelId);
  if (!channel) throw new Error("Channel not found.");
  if (!video.videoFile) throw new Error("Upload the video file first.");
  if (!video.title.trim()) throw new Error("Add a title first.");

  // Channel separation: Heartbeat Hunt never goes to History's Shadows and vice versa.
  assertLaneMatches(video, channel);

  const youtube = api(channel);
  await assertRightYouTubeChannel(youtube, channel);
  const publishAt = video.scheduledAt && new Date(video.scheduledAt) > new Date() ? video.scheduledAt : undefined;
  const history = isHistoryChannel(channel);

  let title = video.title.slice(0, 100);
  let description = withDisclosure(video).slice(0, 5000);
  let tags = video.tags;
  let categoryId = channel.categoryId || "22";
  if (history) {
    const all = db.videos();
    assertVariation(all, video);
    if (publishAt) assertSlotFree(channel, video, all);
    if (video.format === "short") {
      if ((video.durationSeconds ?? 0) > SHORT_MAX_SECONDS) {
        throw new Error(`This Short runs ${video.durationSeconds}s; Shorts on this channel are 90 seconds at most. Shorten the script and make the video again.`);
      }
      const problems = checkShortScript(video.script);
      if (problems.length) console.warn(`Short "${video.title}" breaks script rules: ${problems.join(" ")}`);
    }
    title = finalTitle(video);
    description = buildDescription(video, extraLines(video), usesSyntheticMedia(video));
    tags = buildTags(video);
    categoryId = "27"; // Education
  }

  const synthetic = history ? usesSyntheticMedia(video) : Boolean(video.aiFootageUsed);

  const res = await youtube.videos.insert({
    part: ["snippet", "status"],
    requestBody: {
      snippet: {
        title,
        description,
        tags,
        categoryId,
        ...(history && { defaultLanguage: "en", defaultAudioLanguage: "en" }),
      },
      status: {
        // YouTube only accepts publishAt on a private video; it turns public at that time.
        ...(publishAt ? { privacyStatus: "private", publishAt } : { privacyStatus: "public" }),
        selfDeclaredMadeForKids: false,
        // YouTube requires disclosing realistic AI-generated footage and voices.
        ...(synthetic && { containsSyntheticMedia: true }),
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

  let playlistId: string | undefined;
  let playlistError: string | undefined;
  if (video.series?.trim()) {
    try {
      playlistId = await addToPlaylist(youtube, channel, video.series.trim(), youtubeVideoId);
    } catch (err) {
      // Needs the playlist permission; channels connected before it was added must reconnect once.
      playlistError = `Video uploaded, but adding it to the "${video.series.trim()}" playlist failed: ${(err as Error).message}. Reconnect the channel (Edit channel → Disconnect, then Connect) to grant playlist access.`;
    }
  }

  return db.updateVideo(video.id, {
    youtubeVideoId,
    title: history ? title : video.title,
    ...(history && { description, tags }),
    ...(playlistId && { playlistId }),
    status: publishAt ? "scheduled" : "published",
    scheduledAt: publishAt ?? new Date().toISOString(),
    error: [thumbnailError, playlistError].filter(Boolean).join(" ") || undefined,
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

/**
 * 48 hours after a video went public, pulls views, average percentage viewed and subscribers
 * gained from the YouTube Analytics API. A Short under 40% viewed is flagged so its hook style
 * gets rewritten. The API lags 2-3 days, so numbers are refreshed until the video is 96 hours old.
 */
export async function pullDueAnalytics(channel: Channel) {
  if (!channel.youtube || !isHistoryChannel(channel)) return;
  const due = db.videos(channel.id).filter((v) => analyticsDue(v));
  if (!due.length) return;
  const analytics = google.youtubeAnalytics({ version: "v2", auth: authFor(channel) });
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  for (const video of due) {
    const publishedAt = Date.parse(video.scheduledAt!);
    try {
      const res = await analytics.reports.query({
        ids: "channel==MINE",
        startDate: day(publishedAt - 24 * 3_600_000),
        endDate: day(Date.now()),
        metrics: "views,averageViewPercentage,subscribersGained",
        filters: `video==${video.youtubeVideoId}`,
      });
      const row = res.data.rows?.[0];
      const views = Number(row?.[0] ?? 0);
      const avg = Number(row?.[1] ?? 0);
      const subs = Number(row?.[2] ?? 0);
      const age = (Date.now() - publishedAt) / 3_600_000;
      const flag = row && analyticsFlag(video, avg) ? ("rewrite-hook" as const) : undefined;
      const updated = db.updateVideo(video.id, {
        analytics: {
          views,
          averageViewPercentage: avg,
          subscribersGained: subs,
          pulledAt: new Date().toISOString(),
          final: age >= ANALYTICS_FREEZE_HOURS,
          flag,
          note: row ? undefined : "YouTube has no analytics for this video yet.",
        },
      })!;
      if (flag) {
        updated.analytics!.note = rewriteAdvice(updated);
        db.updateVideo(video.id, { analytics: updated.analytics });
        console.warn(`Flagged Short "${video.title}": ${updated.analytics!.note}`);
      }
    } catch (err) {
      const message = /insufficient|scope|forbidden|403/i.test((err as Error).message)
        ? `Analytics access missing: reconnect "${channel.name}" and enable the YouTube Analytics API in Google Cloud. (${(err as Error).message})`
        : (err as Error).message;
      db.updateVideo(video.id, {
        analytics: { ...(video.analytics ?? { views: 0, averageViewPercentage: 0, subscribersGained: 0 }), pulledAt: new Date().toISOString(), error: message },
      });
      console.error(`Analytics for "${video.title}" failed: ${message}`);
    }
  }
}
