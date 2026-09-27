import { db, type Channel, type StopAfter, type Video } from "./db";
import { generateMetadata, generateScript, research } from "./ai";
import { startRender } from "./render";
import { uploadAndSchedule } from "./youtube";

/**
 * Produces videos automatically: research → script → video → title/description → schedule,
 * stopping after the step the user chose. Videos are worked on one at a time, in order.
 */

const active = new Set<string>();
const cancelled = new Set<string>();
let chain: Promise<unknown> = Promise.resolve();

export const inPipeline = (videoId: string) => active.has(videoId);

class Cancelled extends Error {}

export function startPipeline(videoIds: string[], stopAfter: StopAfter) {
  const queued: string[] = [];
  for (const id of videoIds) {
    const video = db.video(id);
    if (!video || active.has(id) || video.youtubeVideoId) continue;
    active.add(id);
    cancelled.delete(id);
    db.updateVideo(id, { pipeline: { stopAfter, step: "Waiting in line", startedAt: new Date().toISOString() } });
    chain = chain.then(() => run(id, stopAfter));
    queued.push(id);
  }
  return queued;
}

export function cancelPipeline(videoId: string) {
  if (!active.has(videoId)) return;
  cancelled.add(videoId);
  // A job still waiting in line is stopped right away; a running one stops after its current step.
  const video = db.video(videoId);
  if (video?.pipeline?.step === "Waiting in line") finish(videoId, { error: "Cancelled." });
}

/** Marks jobs that were running when the app stopped. */
export function recoverInterruptedPipelines() {
  for (const v of db.videos()) {
    if (v.pipeline && !v.pipeline.finishedAt) {
      db.updateVideo(v.id, {
        pipeline: { ...v.pipeline, error: "Stopped because the app restarted. Start it again.", finishedAt: new Date().toISOString() },
      });
    }
  }
}

function finish(videoId: string, outcome: { result?: string; error?: string }) {
  active.delete(videoId);
  cancelled.delete(videoId);
  const video = db.video(videoId);
  if (video?.pipeline) {
    db.updateVideo(videoId, { pipeline: { ...video.pipeline, ...outcome, finishedAt: new Date().toISOString() } });
  }
}

async function run(videoId: string, stopAfter: StopAfter) {
  if (!active.has(videoId)) return; // cancelled while waiting
  const step = (name: string) => {
    if (cancelled.has(videoId)) throw new Cancelled();
    const v = db.video(videoId);
    if (!v) throw new Error("The video was deleted.");
    db.updateVideo(videoId, { pipeline: { ...v.pipeline!, step: name } });
    return v;
  };
  const channelOf = (v: Video) => {
    const channel = db.channel(v.channelId);
    if (!channel) throw new Error("Channel not found.");
    return channel;
  };

  try {
    let video = step("Researching");
    if (!video.research) {
      const found = await research(channelOf(video), video);
      video = db.updateVideo(videoId, { research: { ...found, createdAt: new Date().toISOString() } })!;
    }

    video = step("Writing script");
    if (!video.script.trim()) {
      const script = await generateScript(channelOf(video), video);
      video = db.updateVideo(videoId, { script, status: video.status === "idea" ? "scripted" : video.status })!;
    }
    if (stopAfter === "script") return finish(videoId, { result: "Script ready for your review" });

    video = step("Making the video");
    if (!video.videoFile) {
      await startRender(videoId);
      video = db.video(videoId)!;
      if (video.render?.error) throw new Error(video.render.error);
    }

    video = step("Writing title and description");
    if (!video.description.trim()) {
      const meta = await generateMetadata(channelOf(video), video);
      video = db.updateVideo(videoId, {
        titleOptions: meta.titles,
        title: meta.titles[0] || video.title,
        description: meta.description,
        tags: meta.tags,
      })!;
    }
    if (stopAfter === "video") return finish(videoId, { result: "Ready for your review" });

    video = step("Scheduling on YouTube");
    const channel = channelOf(video);
    if (!channel.youtube) throw new Error("Connect this channel to YouTube to schedule automatically.");
    const scheduledAt = nextFreeSlot(channel).toISOString();
    video = db.updateVideo(videoId, { scheduledAt })!;
    const uploaded = await uploadAndSchedule(video);
    finish(videoId, { result: `Scheduled for ${new Date(uploaded?.scheduledAt ?? scheduledAt).toLocaleString()}` });
  } catch (err) {
    finish(videoId, { error: err instanceof Cancelled ? "Cancelled." : (err as Error).message });
  }
}

/**
 * The next posting day/time on the channel's schedule with no other video booked, at least
 * 30 minutes from now. Times are in this computer's local time, like the posting time setting.
 */
export function nextFreeSlot(channel: Channel, from = new Date()) {
  const [h, m] = channel.postingTime.split(":").map(Number);
  const days = channel.postingDays.length ? channel.postingDays : [0, 1, 2, 3, 4, 5, 6];
  const taken = new Set(
    db
      .videos(channel.id)
      .filter((v) => v.scheduledAt && (v.youtubeVideoId || v.status === "scheduled"))
      .map((v) => new Date(v.scheduledAt!).toDateString()),
  );
  const d = new Date(from);
  d.setHours(h, m, 0, 0);
  const earliest = from.getTime() + 30 * 60 * 1000;
  for (let i = 0; i < 366; i++) {
    if (days.includes(d.getDay()) && d.getTime() > earliest && !taken.has(d.toDateString())) return d;
    d.setDate(d.getDate() + 1);
  }
  return d;
}
