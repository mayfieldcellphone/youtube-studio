import { useEffect, useState } from "react";
import { 
  ArrowRight, 
  CalendarClock, 
  Clapperboard, 
  Eye, 
  Film, 
  Lightbulb, 
  Mic, 
  Plus, 
  Send, 
  Sparkles, 
  TrendingUp, 
  Users, 
  Video as VideoIcon, 
  Wand2, 
  Zap 
} from "lucide-react";
import { api, compact, formatDateTime, type Channel, type StopAfter, type Video, type VideoFormat } from "../api";
import { navigate, useApp } from "../App";
import { ErrorBox, FormatBadge, PageHeader, Spinner, useAction } from "../components/ui";

const FLOW = [
  ["Create a channel", "Pick a ready-made niche (AI tools, money, history) or describe your own."],
  ["Connect YouTube", "One click per channel. Uploads and stats then happen from here."],
  ["Generate ideas", "Get 10 ideas people search for, then pick the best."],
  ["Research and script", "The AI checks facts on the web, then writes a hook-first script. You read and approve it."],
  ["Make the video", "One click: AI voiceover, stock footage and captions. Watch the preview."],
  ["Title and schedule", "AI writes titles, description and tags. Pick a time and it's queued on YouTube."],
  ["Grow", "Check views here each week and reply to comments on YouTube."],
];

export default function Dashboard() {
  const { channels, status } = useApp();
  const [videos, setVideos] = useState<Video[]>([]);
  const [prompt, setPrompt] = useState("");
  const [selectedChannelId, setSelectedChannelId] = useState<string>("");
  const [format, setFormat] = useState<VideoFormat>("short");
  const [mode, setMode] = useState<"agent" | "tools">("agent");
  const [runAction, setRunAction] = useState<"auto" | "idea" | "ideas_pack">("auto");
  const [successNotice, setSuccessNotice] = useState<string | null>(null);
  const { busy, error, setError, run } = useAction();

  useEffect(() => {
    api.videos().then(setVideos).catch((e) => setError(e.message));
  }, [setError]);

  useEffect(() => {
    if (channels.length > 0 && !selectedChannelId) {
      setSelectedChannelId(channels[0].id);
    }
  }, [channels, selectedChannelId]);

  const channelName = (id: string) => channels.find((c) => c.id === id)?.name ?? "";
  const activeChannel = channels.find((c) => c.id === selectedChannelId) ?? channels[0];

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
    .slice(0, 4);

  const handleHeroSubmit = () => {
    if (!activeChannel) return;
    const cleanPrompt = prompt.trim();
    if (!cleanPrompt) return;

    run("create", async () => {
      setSuccessNotice(null);
      if (runAction === "ideas_pack") {
        // Generate ideas pack based on focus prompt
        const ideas = await api.generateIdeas(activeChannel.id, 5, cleanPrompt);
        setPrompt("");
        setVideos(await api.videos());
        setSuccessNotice(`Generated ${ideas.length} new video ideas for "${activeChannel.name}"!`);
      } else {
        // Create video card
        const video = await api.createVideo({
          channelId: activeChannel.id,
          title: cleanPrompt,
          format: format,
        });

        if (runAction === "auto") {
          // Trigger automated research & script pipeline
          await api.startPipeline([video.id], "video");
          navigate(`/videos/${video.id}`);
        } else {
          // Open editor directly
          navigate(`/videos/${video.id}`);
        }
      }
    });
  };

  const handleQuickBatch = (channelId: string) => {
    run("batch", async () => {
      const channelVideos = videos.filter((v) => v.channelId === channelId && v.status === "idea");
      const targetIds = channelVideos.slice(0, 3).map((v) => v.id);
      if (targetIds.length === 0) {
        // Generate ideas first
        const newIdeas = await api.generateIdeas(channelId, 3);
        const ids = newIdeas.slice(0, 3).map((v) => v.id);
        if (ids.length > 0) {
          await api.startPipeline(ids, "video");
          setSuccessNotice(`Auto-producing ${ids.length} videos in the background!`);
        }
      } else {
        await api.startPipeline(targetIds, "video");
        setSuccessNotice(`Auto-producing ${targetIds.length} videos in the background!`);
      }
      setVideos(await api.videos());
    });
  };

  if (channels.length === 0) {
    return (
      <div className="mx-auto max-w-4xl py-6">
        <div className="mb-8 text-center">
          <div className="inline-flex items-center gap-2 rounded-full border border-pink-500/30 bg-pink-500/10 px-3.5 py-1 text-xs font-semibold text-pink-300 shadow-[0_0_15px_rgba(255,0,153,0.2)]">
            <Sparkles className="h-3.5 w-3.5" /> Welcome to OpenArt Studio Suite
          </div>
          <h1 className="font-display mt-4 text-3xl font-extrabold tracking-tight text-white sm:text-5xl">
            What are we making today?
          </h1>
          <p className="mx-auto mt-3 max-w-xl text-zinc-400">
            Plan, write, render and schedule videos across multiple YouTube channels using state-of-the-art AI.
          </p>
        </div>

        {(!status.ai || !status.youtube) && (
          <div className="mb-6 rounded-2xl border border-amber-500/30 bg-amber-950/30 p-4 text-sm text-amber-200 backdrop-blur-md">
            Some features require API keys. Visit <a className="font-semibold underline" href="#/setup">Setup</a> to add keys.
          </div>
        )}

        <div className="card space-y-4">
          <h2 className="font-display text-lg font-bold text-white">How it works:</h2>
          <ol className="space-y-3">
            {FLOW.map(([title, body], i) => (
              <li key={title} className="flex gap-3.5">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-gradient-to-r from-pink-500 to-purple-600 text-xs font-bold text-white shadow-[0_0_10px_rgba(255,0,153,0.3)]">
                  {i + 1}
                </span>
                <div>
                  <p className="font-semibold text-zinc-200">{title}</p>
                  <p className="text-xs text-zinc-400">{body}</p>
                </div>
              </li>
            ))}
          </ol>
          <div className="pt-2">
            <a className="btn-primary" href="#/channels/new">
              <Plus className="h-4 w-4" /> Create your first channel
            </a>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-10 pb-12">
      <ErrorBox error={error} />

      {successNotice && (
        <div className="flex items-center justify-between rounded-xl border border-emerald-500/30 bg-emerald-950/40 p-4 text-sm text-emerald-200 backdrop-blur-md shadow-[0_4px_20px_rgba(16,185,129,0.15)]">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-emerald-400" />
            <span>{successNotice}</span>
          </div>
          <button className="text-emerald-400 hover:text-emerald-200" onClick={() => setSuccessNotice(null)}>
            Dismiss
          </button>
        </div>
      )}

      {/* HERO SECTION ("What are we making today?") */}
      <section className="relative flex flex-col items-center pt-2 text-center">
        {/* Glow ambient background element */}
        <div className="pointer-events-none absolute -top-12 h-64 w-96 rounded-full bg-pink-500/15 blur-3xl" />

        <div className="relative mb-3 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3.5 py-1 text-xs font-medium text-pink-300 shadow-[inset_0_1px_0_rgba(255,255,255,0.1)]">
          <Sparkles className="h-3 w-3 text-pink-400 animate-pulse" />
          <span>OpenArt Creator Studio</span>
        </div>

        <h1 className="font-display relative text-3xl font-extrabold tracking-tight text-white sm:text-5xl md:text-6xl">
          What are we making today?
        </h1>
        <p className="relative mt-2 max-w-xl text-sm text-zinc-400">
          Chat with creative agents, direct full YouTube videos, or generate AI footage & voiceovers.
        </p>

        {/* Mode Toggle Switcher */}
        <div className="relative mt-6 inline-flex rounded-full border border-white/10 bg-black/40 p-1 backdrop-blur-md">
          <button
            type="button"
            onClick={() => setMode("agent")}
            className={`flex items-center gap-1.5 rounded-full px-4 py-1.5 text-xs font-semibold transition ${
              mode === "agent"
                ? "bg-gradient-to-r from-pink-500/80 to-purple-600/80 text-white shadow-[0_0_12px_rgba(255,0,153,0.3)]"
                : "text-zinc-400 hover:text-white"
            }`}
          >
            <Sparkles className="h-3.5 w-3.5" />
            Agents Mode
          </button>
          <button
            type="button"
            onClick={() => setMode("tools")}
            className={`flex items-center gap-1.5 rounded-full px-4 py-1.5 text-xs font-semibold transition ${
              mode === "tools"
                ? "bg-gradient-to-r from-cyan-500/80 to-blue-600/80 text-white shadow-[0_0_12px_rgba(6,182,212,0.3)]"
                : "text-zinc-400 hover:text-white"
            }`}
          >
            <Wand2 className="h-3.5 w-3.5" />
            Tools Mode
          </button>
        </div>

        {/* Hero Prompt Box */}
        <div className="relative mt-6 w-full max-w-3xl">
          <div className="group relative rounded-2xl border border-white/12 bg-[#0e101a]/85 p-3 backdrop-blur-2xl shadow-[0_12px_40px_rgba(0,0,0,0.6),inset_0_1px_0_rgba(255,255,255,0.1)] transition focus-within:border-pink-500/50 focus-within:shadow-[0_12px_45px_rgba(255,0,153,0.15)] sm:p-4">
            <textarea
              rows={2}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleHeroSubmit();
                }
              }}
              placeholder={
                mode === "agent"
                  ? "Describe a video idea, hook, or question (e.g. '5 AI tools replacing design agencies in 2026', 'The secret history of coffee')..."
                  : "Enter a topic to generate 5 tailored ideas, hook scripts, or thumbnails..."
              }
              className="w-full resize-none border-0 bg-transparent p-1 text-sm text-zinc-100 placeholder-zinc-500 outline-none focus:ring-0 sm:text-base"
            />

            {/* Bottom Controls Row inside Prompt Box */}
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-white/[0.06] pt-3">
              <div className="flex flex-wrap items-center gap-2">
                {/* Channel Selector */}
                <div className="flex items-center gap-1 rounded-xl border border-white/10 bg-white/[0.04] px-2.5 py-1 text-xs font-medium text-zinc-300">
                  <span className="text-zinc-500">Channel:</span>
                  <select
                    value={selectedChannelId}
                    onChange={(e) => setSelectedChannelId(e.target.value)}
                    className="border-0 bg-transparent p-0 text-xs font-semibold text-zinc-200 outline-none focus:ring-0"
                  >
                    {channels.map((c) => (
                      <option key={c.id} value={c.id} className="bg-zinc-900 text-white">
                        {c.name}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Format Toggle */}
                <div className="flex rounded-xl border border-white/10 bg-white/[0.04] p-0.5 text-xs">
                  <button
                    type="button"
                    onClick={() => setFormat("short")}
                    className={`rounded-lg px-2.5 py-1 font-medium transition ${
                      format === "short" ? "bg-white/15 text-white" : "text-zinc-400 hover:text-zinc-200"
                    }`}
                  >
                    📱 Short
                  </button>
                  <button
                    type="button"
                    onClick={() => setFormat("long")}
                    className={`rounded-lg px-2.5 py-1 font-medium transition ${
                      format === "long" ? "bg-white/15 text-white" : "text-zinc-400 hover:text-zinc-200"
                    }`}
                  >
                    🎬 Long
                  </button>
                </div>

                {/* Action Mode Toggle */}
                <div className="hidden sm:flex rounded-xl border border-white/10 bg-white/[0.04] p-0.5 text-xs">
                  <button
                    type="button"
                    onClick={() => setRunAction("auto")}
                    className={`rounded-lg px-2 py-1 transition ${
                      runAction === "auto" ? "bg-pink-500/20 text-pink-300 font-medium" : "text-zinc-400 hover:text-zinc-200"
                    }`}
                    title="Generate script and produce video automatically"
                  >
                    ⚡ Auto-Produce
                  </button>
                  <button
                    type="button"
                    onClick={() => setRunAction("idea")}
                    className={`rounded-lg px-2 py-1 transition ${
                      runAction === "idea" ? "bg-white/15 text-white font-medium" : "text-zinc-400 hover:text-zinc-200"
                    }`}
                    title="Create video card and edit manually"
                  >
                    📝 Manual Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => setRunAction("ideas_pack")}
                    className={`rounded-lg px-2 py-1 transition ${
                      runAction === "ideas_pack" ? "bg-purple-500/20 text-purple-300 font-medium" : "text-zinc-400 hover:text-zinc-200"
                    }`}
                    title="Generate 5 ideas around this topic"
                  >
                    💡 5 Ideas
                  </button>
                </div>
              </div>

              {/* Submit Button */}
              <button
                type="button"
                disabled={!prompt.trim() || !!busy}
                onClick={handleHeroSubmit}
                className="btn-primary shrink-0 rounded-full px-4 py-1.5 text-xs font-semibold"
              >
                {busy === "create" ? (
                  <Spinner className="h-3.5 w-3.5" />
                ) : (
                  <>
                    <span>Generate</span>
                    <Sparkles className="h-3.5 w-3.5" />
                  </>
                )}
              </button>
            </div>
          </div>

          {/* Quick Launch Chips below prompt bar */}
          <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
            <button
              onClick={() => {
                setFormat("short");
                setRunAction("auto");
                setPrompt("Top 5 viral life hacks nobody tells you about");
              }}
              className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1 text-xs text-zinc-300 transition hover:border-pink-500/40 hover:bg-white/[0.08]"
            >
              <Zap className="h-3 w-3 text-pink-400" />
              <span>Viral Short</span>
            </button>

            <button
              onClick={() => {
                setFormat("long");
                setRunAction("idea");
                setPrompt("The hidden economics behind smartphone trade-ins");
              }}
              className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1 text-xs text-zinc-300 transition hover:border-cyan-500/40 hover:bg-white/[0.08]"
            >
              <Film className="h-3 w-3 text-cyan-400" />
              <span>Documentary</span>
            </button>

            {activeChannel && (
              <button
                disabled={!!busy}
                onClick={() => handleQuickBatch(activeChannel.id)}
                className="inline-flex items-center gap-1.5 rounded-full border border-purple-500/30 bg-purple-500/10 px-3 py-1 text-xs text-purple-200 transition hover:bg-purple-500/20"
              >
                {busy === "batch" ? <Spinner className="h-3 w-3" /> : <Sparkles className="h-3 w-3 text-purple-400" />}
                <span>Auto-Produce Next Batch ({activeChannel.name})</span>
              </button>
            )}

            <a
              href="#/calendar"
              className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1 text-xs text-zinc-300 transition hover:border-white/20 hover:bg-white/[0.08]"
            >
              <CalendarClock className="h-3 w-3 text-amber-400" />
              <span>Schedule Queue</span>
            </a>
          </div>
        </div>
      </section>

      {/* CHANNELS SECTION (Project Cards) */}
      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="font-display flex items-center gap-2 text-lg font-bold text-white sm:text-xl">
            <Clapperboard className="h-5 w-5 text-pink-500" />
            Your Channels ({channels.length})
          </h2>
          <a href="#/channels/new" className="btn-secondary text-xs">
            <Plus className="h-3.5 w-3.5" />
            New Channel
          </a>
        </div>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {channels.map((c) => {
            const mine = videos.filter((v) => v.channelId === c.id);
            const count = (s: Video["status"]) => mine.filter((v) => v.status === s).length;
            const inProgress = count("scripted") + count("ready");
            const scheduled = count("scheduled");

            return (
              <a
                key={c.id}
                href={`#/channels/${c.id}`}
                className="card card-hover block group relative overflow-hidden"
              >
                <div className="mb-3 flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate font-display font-bold text-white group-hover:text-pink-300 transition">
                      {c.name}
                    </p>
                    <p className="truncate text-xs text-zinc-400">{c.niche || "YouTube Channel"}</p>
                  </div>
                  {c.youtube ? (
                    <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-300">
                      <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" /> Connected
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-300">
                      Unlinked
                    </span>
                  )}
                </div>

                {c.stats && (
                  <div className="mb-3 flex gap-4 text-xs text-zinc-300">
                    <span className="flex items-center gap-1">
                      <Users className="h-3.5 w-3.5 text-zinc-400" />
                      {compact(c.stats.subscribers)} subs
                    </span>
                    <span className="flex items-center gap-1">
                      <Eye className="h-3.5 w-3.5 text-zinc-400" />
                      {compact(c.stats.views)} views
                    </span>
                  </div>
                )}

                <div className="flex items-center justify-between border-t border-white/[0.06] pt-3 text-xs text-zinc-400">
                  <div className="flex gap-2">
                    <span className="text-zinc-300 font-medium">{count("idea")}</span> ideas ·{" "}
                    <span className="text-cyan-300 font-medium">{inProgress}</span> active ·{" "}
                    <span className="text-pink-300 font-medium">{scheduled}</span> queued
                  </div>
                  <span className="text-pink-400 opacity-0 group-hover:opacity-100 transition flex items-center gap-0.5">
                    Open <ArrowRight className="h-3 w-3" />
                  </span>
                </div>
              </a>
            );
          })}
        </div>
      </section>

      {/* PIPELINE STATUS: COMING UP & IN PROGRESS */}
      <div className="grid gap-6 lg:grid-cols-2">
        {/* Coming Up */}
        <section className="card">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="font-display flex items-center gap-2 font-bold text-white">
              <CalendarClock className="h-4 w-4 text-pink-400" />
              Scheduled for YouTube
            </h2>
            <a href="#/calendar" className="text-xs text-pink-400 hover:underline">
              View Calendar
            </a>
          </div>

          {upcoming.length === 0 ? (
            <p className="muted py-4 text-center text-xs">
              No videos scheduled yet. Open a ready video and schedule its upload slot.
            </p>
          ) : (
            <VideoList videos={upcoming} channelName={channelName} detail={(v) => formatDateTime(v.scheduledAt!)} />
          )}
        </section>

        {/* Ready & In Progress */}
        <section className="card">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="font-display flex items-center gap-2 font-bold text-white">
              <Sparkles className="h-4 w-4 text-cyan-400" />
              In Progress / Ready to Post
            </h2>
            <span className="text-xs text-zinc-500">{nextUp.length} items</span>
          </div>

          {nextUp.length === 0 ? (
            <p className="muted py-4 text-center text-xs">
              No videos in progress. Select a channel above to generate ideas.
            </p>
          ) : (
            <VideoList
              videos={nextUp}
              channelName={channelName}
              detail={(v) =>
                v.status === "scripted"
                  ? "Scripted (Needs Render)"
                  : v.status === "failed"
                  ? "Upload Failed (Retry)"
                  : "Ready to Post"
              }
            />
          )}
        </section>

        {/* Top Performing Videos */}
        {top.length > 0 && (
          <section className="card lg:col-span-2">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="font-display flex items-center gap-2 font-bold text-white">
                <TrendingUp className="h-4 w-4 text-emerald-400" />
                Top Performing Content
              </h2>
              <span className="text-xs text-zinc-400">Based on live YouTube metrics</span>
            </div>
            <VideoList videos={top} channelName={channelName} detail={(v) => `${compact(v.stats!.views)} views`} />
          </section>
        )}
      </div>
    </div>
  );
}

function VideoList({
  videos,
  channelName,
  detail,
}: {
  videos: Video[];
  channelName: (id: string) => string;
  detail: (v: Video) => string;
}) {
  return (
    <ul className="divide-y divide-white/[0.06]">
      {videos.map((v) => (
        <li key={v.id}>
          <a
            href={`#/videos/${v.id}`}
            className="group flex items-center justify-between gap-3 py-3 transition hover:text-pink-300"
          >
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-zinc-200 group-hover:text-pink-300 transition">
                {v.title}
              </p>
              <p className="text-xs text-zinc-500">{channelName(v.channelId)}</p>
            </div>
            <div className="flex shrink-0 items-center gap-2.5 text-xs text-zinc-400">
              <FormatBadge format={v.format} />
              <span className="rounded-md border border-white/5 bg-white/[0.03] px-2 py-0.5 text-zinc-300">
                {detail(v)}
              </span>
            </div>
          </a>
        </li>
      ))}
    </ul>
  );
}
