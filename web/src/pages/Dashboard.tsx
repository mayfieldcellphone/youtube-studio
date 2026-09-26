import { useEffect, useState } from "react";
import { ArrowRight, CalendarClock, Eye, Plus, Users } from "lucide-react";
import { api, compact, formatDateTime, type Video } from "../api";
import { useApp } from "../App";
import { ErrorBox, FormatBadge, PageHeader } from "../components/ui";

const FLOW = [
  ["Create a channel", "Tell the app what it's about so the AI writes for your audience."],
  ["Connect YouTube", "One click per channel. Uploads and stats then happen from here."],
  ["Generate ideas", "Get 10 ideas people search for, then pick the best."],
  ["Write the script", "The AI writes a hook-first script you read while filming."],
  ["Film and edit", "Record on your phone, edit in CapCut, upload the final file."],
  ["Title and schedule", "AI writes titles, description and tags. Pick a time and it's queued on YouTube."],
  ["Grow", "Check views here each week and reply to comments on YouTube."],
];

export default function Dashboard() {
  const { channels, status } = useApp();
  const [videos, setVideos] = useState<Video[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.videos().then(setVideos).catch((e) => setError(e.message));
  }, []);

  const channelName = (id: string) => channels.find((c) => c.id === id)?.name ?? "";
  const upcoming = videos
    .filter((v) => v.status === "scheduled" && v.scheduledAt)
    .sort((a, b) => a.scheduledAt!.localeCompare(b.scheduledAt!))
    .slice(0, 6);
  const nextUp = videos
    .filter((v) => ["scripted", "ready", "failed"].includes(v.status))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 6);
  const top = videos
    .filter((v) => v.stats)
    .sort((a, b) => b.stats!.views - a.stats!.views)
    .slice(0, 5);

  if (channels.length === 0) {
    return (
      <div className="max-w-3xl">
        <PageHeader title="Welcome" subtitle="Plan, write and schedule videos for all your YouTube channels in one place." />
        {(!status.ai || !status.youtube) && (
          <div className="mb-6 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
            Some features need API keys. See <a className="font-medium underline" href="#/setup">Setup</a>.
          </div>
        )}
        <ol className="card space-y-4">
          {FLOW.map(([title, body], i) => (
            <li key={title} className="flex gap-4">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-red-600 text-sm font-semibold text-white">
                {i + 1}
              </span>
              <div>
                <p className="font-medium">{title}</p>
                <p className="muted">{body}</p>
              </div>
            </li>
          ))}
        </ol>
        <a className="btn-primary mt-6" href="#/channels/new">
          <Plus className="h-4 w-4" /> Create your first channel
        </a>
      </div>
    );
  }

  return (
    <div>
      <PageHeader title="Dashboard" subtitle="All your channels at a glance." />
      <ErrorBox error={error} />

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {channels.map((c) => {
          const mine = videos.filter((v) => v.channelId === c.id);
          const count = (s: Video["status"]) => mine.filter((v) => v.status === s).length;
          return (
            <a key={c.id} href={`#/channels/${c.id}`} className="card block transition hover:border-red-300 dark:hover:border-red-800">
              <div className="mb-3 flex items-center justify-between gap-2">
                <p className="truncate font-semibold">{c.name}</p>
                {!c.youtube && <span className="text-xs text-amber-600">Not connected</span>}
              </div>
              {c.stats ? (
                <div className="mb-3 flex gap-4 text-sm">
                  <span className="flex items-center gap-1"><Users className="h-4 w-4 text-zinc-400" /> {compact(c.stats.subscribers)}</span>
                  <span className="flex items-center gap-1"><Eye className="h-4 w-4 text-zinc-400" /> {compact(c.stats.views)}</span>
                </div>
              ) : null}
              <p className="muted">
                {count("idea")} ideas · {count("scripted") + count("ready")} in progress · {count("scheduled")} scheduled
              </p>
            </a>
          );
        })}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="card">
          <h2 className="mb-3 flex items-center gap-2 font-semibold">
            <CalendarClock className="h-4 w-4 text-red-600" /> Coming up
          </h2>
          {upcoming.length === 0 ? (
            <p className="muted">Nothing scheduled. Pick a video that's ready and schedule it.</p>
          ) : (
            <VideoList videos={upcoming} channelName={channelName} detail={(v) => formatDateTime(v.scheduledAt!)} />
          )}
        </section>

        <section className="card">
          <h2 className="mb-3 flex items-center gap-2 font-semibold">
            <ArrowRight className="h-4 w-4 text-red-600" /> Keep going
          </h2>
          {nextUp.length === 0 ? (
            <p className="muted">No videos in progress. Open a channel and generate some ideas.</p>
          ) : (
            <VideoList
              videos={nextUp}
              channelName={channelName}
              detail={(v) => (v.status === "scripted" ? "Film and upload" : v.status === "failed" ? "Upload failed, retry" : "Add title and schedule")}
            />
          )}
        </section>

        {top.length > 0 && (
          <section className="card lg:col-span-2">
            <h2 className="mb-3 flex items-center gap-2 font-semibold">
              <Eye className="h-4 w-4 text-red-600" /> Top videos
            </h2>
            <VideoList videos={top} channelName={channelName} detail={(v) => `${compact(v.stats!.views)} views`} />
            <p className="mt-3 text-xs text-zinc-500">Make more videos like your top ones. That's what your viewers want.</p>
          </section>
        )}
      </div>
    </div>
  );
}

function VideoList({ videos, channelName, detail }: { videos: Video[]; channelName: (id: string) => string; detail: (v: Video) => string }) {
  return (
    <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
      {videos.map((v) => (
        <li key={v.id}>
          <a href={`#/videos/${v.id}`} className="flex items-center justify-between gap-3 py-2.5 hover:text-red-600">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{v.title}</p>
              <p className="text-xs text-zinc-500">{channelName(v.channelId)}</p>
            </div>
            <div className="flex shrink-0 items-center gap-2 text-xs text-zinc-500">
              <FormatBadge format={v.format} />
              {detail(v)}
            </div>
          </a>
        </li>
      ))}
    </ul>
  );
}
