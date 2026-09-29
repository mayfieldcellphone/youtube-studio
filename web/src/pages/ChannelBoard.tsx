import { useCallback, useEffect, useState } from "react";
import { BarChart3, Eye, Link2, Pencil, Plus, RefreshCw, Sparkles, Unlink, Wand2 } from "lucide-react";
import { api, compact, formatDateTime, STATUS_LABELS, type StopAfter, type Video, type VideoFormat, type VideoStatus } from "../api";
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
  const [notice, setNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [stopAfter, setStopAfter] = useState<StopAfter>("video");
  const { busy, error, setError, run } = useAction();

  const load = useCallback(async () => setVideos(await api.videos(channelId)), [channelId]);
  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, [load, setError]);

  // While videos are being produced automatically, refresh their progress.
  const working = videos.some((v) => (v.pipeline && !v.pipeline.finishedAt) || (v.render && !v.render.finishedAt));
  useEffect(() => {
    if (!working) return;
    const timer = setInterval(() => load().catch(() => {}), 3000);
    return () => clearInterval(timer);
  }, [working, load]);

  const youtubeResult = params.get("youtube");
  const youtubeMessage = params.get("message");

  if (!channel) return <p className="muted">Channel not found.</p>;

  const generate = () =>
    run("ideas", async () => {
      setNotice(null);
      const ideas = await api.generateIdeas(channel.id, count, focus);
      setFocus("");
      await load();
      setNotice(`Added ${ideas.length} new ideas. They're at the top of the Ideas column below.`);
    });

  const addIdea = () =>
    run("add", async () => {
      const video = await api.createVideo({ channelId: channel.id, title: newTitle, format: newFormat });
      navigate(`/videos/${video.id}`);
    });

  const selectable = (v: Video) => !v.youtubeVideoId && !(v.pipeline && !v.pipeline.finishedAt) && ["idea", "scripted", "ready", "failed"].includes(v.status);
  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const selectNext = (n: number) =>
    setSelected(
      new Set(
        videos
          .filter((v) => v.status === "idea" && selectable(v))
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .slice(0, n)
          .map((v) => v.id),
      ),
    );

  const produce = () =>
    run("produce", async () => {
      setNotice(null);
      const { queued } = await api.startPipeline([...selected], stopAfter);
      setSelected(new Set());
      await load();
      setNotice(
        `Started ${queued} video${queued === 1 ? "" : "s"}. They're done one after another; each card shows its progress. You can leave this page.`,
      );
    });

  const cancel = (id: string) => run("cancel", async () => { await api.cancelPipeline(id); await load(); });

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

      {notice && (
        <div className="mb-4 flex justify-between gap-3 rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800 dark:border-green-900 dark:bg-green-950/40 dark:text-green-300">
          <span>{notice}</span>
          <button className="font-medium underline" onClick={() => setNotice(null)}>Dismiss</button>
        </div>
      )}
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

      <div className="card mb-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="flex items-center gap-2 font-medium">
              <Wand2 className="h-4 w-4 text-red-600" /> Make several videos automatically
            </p>
            <p className="muted mt-1">
              Tick ideas below (or pick the next few), choose how far to go, and the app works through them one by one. To do a
              video step by step yourself, just click it.
            </p>
          </div>
          <div className="flex gap-2">
            {[2, 3].map((n) => (
              <button key={n} className="btn-secondary" onClick={() => selectNext(n)}>
                Select next {n} ideas
              </button>
            ))}
          </div>
        </div>
        {selected.size > 0 && (
          <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-zinc-200 pt-4 dark:border-zinc-800">
            <span className="text-sm font-medium">{selected.size} selected ·</span>
            <select className="w-auto" value={stopAfter} onChange={(e) => setStopAfter(e.target.value as StopAfter)}>
              <option value="script">Research and script, then stop so I can review the writing</option>
              <option value="video">Make the full video, then stop so I can watch it (recommended)</option>
              <option value="schedule" disabled={!channel.youtube}>
                Make the video and schedule it in my next posting slots{channel.youtube ? "" : " (connect YouTube first)"}
              </option>
            </select>
            <button className="btn-primary" onClick={produce} disabled={!!busy}>
              {busy === "produce" ? <Spinner /> : <Wand2 className="h-4 w-4" />} Start
            </button>
            <button className="btn-ghost" onClick={() => setSelected(new Set())}>Clear</button>
            {stopAfter === "schedule" && (
              <p className="w-full text-xs text-amber-700 dark:text-amber-400">
                Videos go out without you watching them first. YouTube demonetizes low-quality, mass-produced videos, so check each
                one in YouTube Studio before its publish time.
              </p>
            )}
          </div>
        )}
      </div>

      <div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-5">
        {COLUMNS.map((col) => {
          const items = videos
            .filter((v) => col.statuses.includes(v.status))
            // Newest ideas first, so freshly generated ones are at the top; the rest by date.
            .sort((a, b) =>
              col.title === "Ideas"
                ? b.createdAt.localeCompare(a.createdAt)
                : (a.scheduledAt ?? a.createdAt).localeCompare(b.scheduledAt ?? b.createdAt),
            );
          return (
            <section key={col.title} className="rounded-2xl border border-white/[0.06] bg-[#0c0e18]/80 p-3.5 backdrop-blur-xl shadow-inner">
              <div className="mb-1 flex items-baseline justify-between px-1">
                <h2 className="font-display text-sm font-bold text-white">{col.title}</h2>
                <span className="rounded-full border border-white/10 bg-white/[0.05] px-2 py-0.5 text-[11px] font-semibold text-zinc-300">
                  {items.length}
                </span>
              </div>
              <p className="mb-3 px-1 text-[11px] text-zinc-500">{col.hint}</p>
              <div className="space-y-2.5">
                {items.map((v) => {
                  const job = v.pipeline;
                  const running = job && !job.finishedAt;
                  return (
                    <div
                      key={v.id}
                      className={`group rounded-xl border p-3 text-sm transition ${
                        selected.has(v.id)
                          ? "border-pink-500 bg-[#191c2e] shadow-[0_0_20px_rgba(255,0,153,0.25)]"
                          : "border-white/10 bg-[#121524]/80 hover:border-pink-500/40 hover:bg-[#161a2d] hover:shadow-[0_4px_20px_rgba(0,0,0,0.4)]"
                      }`}
                    >
                      <div className="flex items-start gap-2">
                        {selectable(v) && (
                          <input
                            type="checkbox"
                            className="mt-1 h-4 w-4 accent-[#ff0099]"
                            checked={selected.has(v.id)}
                            onChange={() => toggle(v.id)}
                            aria-label={`Select ${v.title}`}
                          />
                        )}
                        <a href={`#/videos/${v.id}`} className="min-w-0 flex-1">
                          <p className="mb-2 font-medium leading-snug text-zinc-200 group-hover:text-pink-300 transition">
                            {v.title}
                          </p>
                          <div className="flex flex-wrap items-center gap-1.5 text-xs text-zinc-400">
                            <FormatBadge format={v.format} />
                            {v.status === "failed" && <span className="text-rose-400 font-semibold">{STATUS_LABELS.failed}</span>}
                            {v.scheduledAt && ["scheduled", "published"].includes(v.status) && (
                              <span className="text-pink-300">{formatDateTime(v.scheduledAt)}</span>
                            )}
                            {v.stats && (
                              <span className="inline-flex items-center gap-1 text-emerald-400">
                                <Eye className="h-3 w-3" /> {compact(v.stats.views)}
                              </span>
                            )}
                          </div>
                        </a>
                      </div>
                      {job && (
                        <div className="mt-2.5 border-t border-white/[0.08] pt-2 text-xs">
                          {running ? (
                            <div className="flex items-center justify-between gap-2">
                              <span className="flex items-center gap-1.5 text-pink-300 font-medium">
                                <Spinner className="h-3 w-3" />
                                {job.step}
                                {job.step === "Making the video" && v.render && !v.render.finishedAt ? ` (${v.render.progress}%)` : ""}
                              </span>
                              <button className="text-zinc-400 hover:text-zinc-200 underline" onClick={() => cancel(v.id)}>Cancel</button>
                            </div>
                          ) : job.error ? (
                            <span className="text-rose-400" title={job.error}>✗ {job.error.length > 90 ? `${job.error.slice(0, 90)}…` : job.error}</span>
                          ) : (
                            <span className="text-emerald-400">✓ {job.result}</span>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
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
