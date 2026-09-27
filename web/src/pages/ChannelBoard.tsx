import { useCallback, useEffect, useState } from "react";
import { BarChart3, Eye, Link2, Pencil, Plus, RefreshCw, Sparkles, Unlink } from "lucide-react";
import { api, compact, formatDateTime, STATUS_LABELS, type Video, type VideoFormat, type VideoStatus } from "../api";
import { navigate, useApp } from "../App";
import { ErrorBox, FormatBadge, PageHeader, Spinner, useAction } from "../components/ui";

const COLUMNS: { title: string; statuses: VideoStatus[]; hint: string }[] = [
  { title: "Ideas", statuses: ["idea"], hint: "Pick one and write the script" },
  { title: "Scripted", statuses: ["scripted"], hint: "Film it, then upload the file" },
  { title: "Ready to post", statuses: ["ready", "failed"], hint: "Add title and schedule" },
  { title: "Scheduled", statuses: ["scheduled"], hint: "YouTube will publish these" },
  { title: "Published", statuses: ["published"], hint: "Live on YouTube" },
];

export default function ChannelBoard({ channelId, params }: { channelId: string; params: URLSearchParams }) {
  const { channels, status, reloadChannels } = useApp();
  const channel = channels.find((c) => c.id === channelId);
  const [videos, setVideos] = useState<Video[]>([]);
  const [count, setCount] = useState(10);
  const [focus, setFocus] = useState("");
  const [newTitle, setNewTitle] = useState("");
  const [newFormat, setNewFormat] = useState<VideoFormat>("short");
  const [showAdd, setShowAdd] = useState(false);
  const { busy, error, setError, run } = useAction();

  const load = useCallback(async () => setVideos(await api.videos(channelId)), [channelId]);
  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, [load, setError]);

  const youtubeResult = params.get("youtube");
  const youtubeMessage = params.get("message");

  if (!channel) return <p className="muted">Channel not found.</p>;

  const generate = () =>
    run("ideas", async () => {
      await api.generateIdeas(channel.id, count, focus);
      setFocus("");
      await load();
    });

  const addIdea = () =>
    run("add", async () => {
      const video = await api.createVideo({ channelId: channel.id, title: newTitle, format: newFormat });
      navigate(`/videos/${video.id}`);
    });

  const sync = () =>
    run("sync", async () => {
      await api.syncChannel(channel.id);
      await Promise.all([reloadChannels(), load()]);
    });

  const disconnect = () =>
    run("disconnect", async () => {
      if (!confirm("Disconnect this channel from YouTube? You can connect it again later.")) return;
      await api.disconnectYouTube(channel.id);
      await reloadChannels();
    });

  return (
    <div>
      <PageHeader
        title={channel.name}
        subtitle={channel.niche}
        actions={
          <a className="btn-secondary" href={`#/channels/${channel.id}/edit`}>
            <Pencil className="h-4 w-4" /> Edit channel
          </a>
        }
      />

      {youtubeResult === "connected" && (
        <div className="mb-4 rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800 dark:border-green-900 dark:bg-green-950/40 dark:text-green-300">
          YouTube connected. You can now schedule uploads from this app.
        </div>
      )}
      {youtubeResult === "error" && <div className="mb-4"><ErrorBox error={`Could not connect YouTube: ${youtubeMessage}`} /></div>}

      {error && (
        <div className="mb-4">
          <ErrorBox error={error} onClose={() => setError(null)} />
        </div>
      )}

      <div className="mb-6 grid gap-4 lg:grid-cols-2">
        <div className="card">
          <div className="mb-3 flex items-center gap-2 font-medium">
            <BarChart3 className="h-4 w-4 text-red-600" /> YouTube
          </div>
          {channel.youtube ? (
            <>
              <div className="flex items-center gap-3">
                {channel.youtube.thumbnail && <img src={channel.youtube.thumbnail} alt="" className="h-10 w-10 rounded-full" />}
                <div className="min-w-0">
                  <a
                    href={`https://www.youtube.com/channel/${channel.youtube.channelId}`}
                    target="_blank"
                    rel="noreferrer"
                    className="font-medium hover:underline"
                  >
                    {channel.youtube.title}
                  </a>
                  {channel.stats && <p className="muted">Updated {formatDateTime(channel.stats.updatedAt)}</p>}
                </div>
              </div>
              {channel.stats && (
                <div className="mt-4 grid grid-cols-3 gap-2 text-center">
                  <Stat label="Subscribers" value={compact(channel.stats.subscribers)} />
                  <Stat label="Views" value={compact(channel.stats.views)} />
                  <Stat label="Videos" value={compact(channel.stats.videos)} />
                </div>
              )}
              <div className="mt-4 flex flex-wrap gap-2">
                <button className="btn-secondary" onClick={sync} disabled={!!busy}>
                  {busy === "sync" ? <Spinner /> : <RefreshCw className="h-4 w-4" />} Refresh stats
                </button>
                <button className="btn-ghost" onClick={disconnect} disabled={!!busy}>
                  <Unlink className="h-4 w-4" /> Disconnect
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="muted mb-4">
                Connect a YouTube channel so this app can upload and schedule videos and show your stats. If your Google
                account has more than one channel, Google asks you which one.
              </p>
              {status.youtube ? (
                <a className="btn-primary" href={api.connectYouTubeUrl(channel.id)}>
                  <Link2 className="h-4 w-4" /> Connect YouTube
                </a>
              ) : (
                <a className="btn-secondary" href="#/setup">
                  Set up Google access first
                </a>
              )}
            </>
          )}
        </div>

        <div className="card">
          <div className="mb-3 flex items-center gap-2 font-medium">
            <Sparkles className="h-4 w-4 text-red-600" /> Get video ideas
          </div>
          {status.ai ? (
            <div className="space-y-3">
              <input value={focus} onChange={(e) => setFocus(e.target.value)} placeholder="Optional focus, e.g. iPhone 16 problems, beginner tips" />
              <div className="flex flex-wrap items-center gap-2">
                <select className="max-w-32" value={count} onChange={(e) => setCount(Number(e.target.value))}>
                  {[5, 10, 15, 20].map((n) => (
                    <option key={n} value={n}>
                      {n} ideas
                    </option>
                  ))}
                </select>
                <button className="btn-primary" onClick={generate} disabled={!!busy}>
                  {busy === "ideas" ? <Spinner /> : <Sparkles className="h-4 w-4" />}
                  {busy === "ideas" ? "Thinking…" : "Generate ideas"}
                </button>
                <button className="btn-ghost" onClick={() => setShowAdd(!showAdd)}>
                  <Plus className="h-4 w-4" /> Add my own
                </button>
              </div>
            </div>
          ) : (
            <p className="muted">
              Add your Anthropic API key on the <a className="underline" href="#/setup">Setup</a> page to generate ideas.{" "}
              <button className="underline" onClick={() => setShowAdd(true)}>Add an idea yourself</button>
            </p>
          )}
          {showAdd && (
            <form
              className="mt-4 flex flex-wrap gap-2 border-t border-zinc-200 pt-4 dark:border-zinc-800"
              onSubmit={(e) => {
                e.preventDefault();
                addIdea();
              }}
            >
              <input required className="min-w-0 flex-1" value={newTitle} onChange={(e) => setNewTitle(e.target.value)} placeholder="Video title" />
              <select className="w-auto" value={newFormat} onChange={(e) => setNewFormat(e.target.value as VideoFormat)}>
                <option value="short">Short</option>
                <option value="long">Long</option>
              </select>
              <button className="btn-secondary" disabled={!!busy}>Add</button>
            </form>
          )}
        </div>
      </div>

      <div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-5">
        {COLUMNS.map((col) => {
          const items = videos
            .filter((v) => col.statuses.includes(v.status))
            .sort((a, b) => (a.scheduledAt ?? a.createdAt).localeCompare(b.scheduledAt ?? b.createdAt));
          return (
            <section key={col.title} className="rounded-xl bg-zinc-100/70 p-3 dark:bg-zinc-900/60">
              <div className="mb-1 flex items-baseline justify-between px-1">
                <h2 className="text-sm font-semibold">{col.title}</h2>
                <span className="text-xs text-zinc-500">{items.length}</span>
              </div>
              <p className="mb-3 px-1 text-xs text-zinc-500">{col.hint}</p>
              <div className="space-y-2">
                {items.map((v) => (
                  <a
                    key={v.id}
                    href={`#/videos/${v.id}`}
                    className="block rounded-lg border border-zinc-200 bg-white p-3 text-sm shadow-sm transition hover:border-red-300 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-red-800"
                  >
                    <p className="mb-2 font-medium leading-snug">{v.title}</p>
                    <div className="flex flex-wrap items-center gap-1.5 text-xs text-zinc-500">
                      <FormatBadge format={v.format} />
                      {v.status === "failed" && <span className="text-red-600">{STATUS_LABELS.failed}</span>}
                      {v.scheduledAt && ["scheduled", "published"].includes(v.status) && <span>{formatDateTime(v.scheduledAt)}</span>}
                      {v.stats && (
                        <span className="inline-flex items-center gap-1">
                          <Eye className="h-3 w-3" /> {compact(v.stats.views)}
                        </span>
                      )}
                    </div>
                  </a>
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-zinc-50 py-2 dark:bg-zinc-800/60">
      <div className="text-lg font-semibold">{value}</div>
      <div className="text-xs text-zinc-500">{label}</div>
    </div>
  );
}
