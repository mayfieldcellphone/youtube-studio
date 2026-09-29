import { useCallback, useEffect, useState } from "react";
import { 
  BarChart3, 
  BookOpen, 
  Check, 
  ChevronDown, 
  ChevronUp, 
  Eye, 
  Film, 
  Link2, 
  Music, 
  Pencil, 
  Play, 
  Plus, 
  RefreshCw, 
  Sparkles, 
  Square, 
  Unlink, 
  Volume2, 
  Wand2, 
  Zap 
} from "lucide-react";
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
  const [count, setCount] = useState(3);
  const [focus, setFocus] = useState("");
  const [newTitle, setNewTitle] = useState("");
  const [newFormat, setNewFormat] = useState<VideoFormat>("short");
  const [showAdd, setShowAdd] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [stopAfter, setStopAfter] = useState<StopAfter>("video");
  const [newlyCreatedIds, setNewlyCreatedIds] = useState<Set<string>>(new Set());

  // Story-to-Series state
  const [showSeries, setShowSeries] = useState(false);
  const [storyText, setStoryText] = useState("");
  const [seriesParts, setSeriesParts] = useState(3);
  const [seriesFormat, setSeriesFormat] = useState<VideoFormat>("short");
  const [seriesStyle, setSeriesStyle] = useState(
    "Cinematic historical documentary still, moody candlelit atmosphere, dramatic chiaroscuro lighting, 19th century textures, 35mm grain, no text"
  );
  const [autoProduceSeries, setAutoProduceSeries] = useState(false);

  // Background Music presets
  const [musicPresets, setMusicPresets] = useState<Array<{ id: string; name: string; description: string }>>([]);
  const [selectedMusicPreset, setSelectedMusicPreset] = useState("dark-mystery.mp3");
  const [playingMusicPreset, setPlayingMusicPreset] = useState<string | null>(null);

  const { busy, error, setError, run } = useAction();

  const load = useCallback(async () => setVideos(await api.videos(channelId)), [channelId]);
  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, [load, setError]);

  useEffect(() => {
    api.musicPresets().then((list) => {
      setMusicPresets(list);
      if (list.length > 0) setSelectedMusicPreset(list[0].id);
    }).catch(() => {});
  }, []);

  // While videos are being produced automatically, refresh their progress.
  const working = videos.some((v) => (v.pipeline && !v.pipeline.finishedAt) || (v.render && !v.render.finishedAt));
  useEffect(() => {
    if (!working) return;
    const timer = setInterval(() => load().catch(() => {}), 2000);
    return () => clearInterval(timer);
  }, [working, load]);

  const youtubeResult = params.get("youtube");
  const youtubeMessage = params.get("message");

  if (!channel) return <p className="muted">Channel not found.</p>;

  const generate = (customCount?: number) =>
    run("ideas", async () => {
      setNotice(null);
      const targetCount = customCount || count;
      const ideas = await api.generateIdeas(channel.id, targetCount, focus);
      setFocus("");
      await load();
      setNotice(`✨ Added ${ideas.length} new ideas! Look at the top of the "Ideas" column below.`);
    });

  const handleApplyMusic = (presetId: string) => {
    run("music", async () => {
      await api.applyMusicPreset(channel.id, presetId);
      await reloadChannels();
      setNotice(`🎵 Background music applied: "${musicPresets.find(p => p.id === presetId)?.name || presetId}".`);
    });
  };

  const handleCreateSeries = () =>
    run("series", async () => {
      if (!storyText.trim()) return;
      setNotice(null);
      const res = await api.splitStoryIntoSeries({
        channelId: channel.id,
        story: storyText.trim(),
        parts: seriesParts,
        format: seriesFormat,
        visualStyle: seriesStyle.trim() || undefined,
        autoProduce: autoProduceSeries,
      });
      setStoryText("");
      setShowSeries(false);
      await load();
      const ids = new Set(res.episodes.map((e) => e.id));
      setNewlyCreatedIds(ids);
      setNotice(
        `🎉 Successfully created ${res.episodes.length} serialized episodes for "${channel.name}"! Look at the "Scripted" column below.`
      );
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

      {/* Standard Background Music Selector & Audio Preview */}
      <div className="card mb-6 border-white/10 bg-[#121524]/60 backdrop-blur-md">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-pink-500/10 text-pink-400 border border-pink-500/20">
              <Music className="h-4 w-4" />
            </div>
            <div>
              <p className="text-xs font-semibold text-white flex items-center gap-2">
                <span>Standard Royalty-Free Background Music</span>
                {channel.musicFile && (
                  <span className="rounded-full bg-emerald-500/20 text-emerald-300 text-[10px] px-2 py-0.5 font-medium">
                    Active: {channel.musicFile.name}
                  </span>
                )}
              </p>
              <p className="text-[11px] text-zinc-400">
                Plays quietly under narration and ducks automatically when speaking.
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {musicPresets.length > 0 && (
              <>
                <select
                  value={selectedMusicPreset}
                  onChange={(e) => setSelectedMusicPreset(e.target.value)}
                  className="text-xs max-w-[260px]"
                >
                  {musicPresets.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>

                <button
                  type="button"
                  className="btn-secondary text-xs py-1.5 px-3 flex items-center gap-1.5"
                  onClick={() => {
                    if (playingMusicPreset === selectedMusicPreset) {
                      setPlayingMusicPreset(null);
                    } else {
                      setPlayingMusicPreset(selectedMusicPreset);
                    }
                  }}
                >
                  {playingMusicPreset === selectedMusicPreset ? (
                    <>
                      <Square className="h-3 w-3 text-pink-400" /> Stop
                    </>
                  ) : (
                    <>
                      <Play className="h-3 w-3 text-emerald-400" /> Preview
                    </>
                  )}
                </button>

                <button
                  type="button"
                  className="btn-primary text-xs py-1.5 px-3"
                  disabled={busy === "music"}
                  onClick={() => handleApplyMusic(selectedMusicPreset)}
                >
                  {busy === "music" ? <Spinner className="h-3 w-3" /> : "Use Track"}
                </button>
              </>
            )}
            <a href={`#/channels/${channel.id}/edit`} className="btn-ghost text-xs py-1.5 px-2 text-zinc-400">
              Upload custom MP3
            </a>
          </div>
        </div>

        {playingMusicPreset && (
          <div className="mt-3 pt-3 border-t border-white/[0.08] flex items-center gap-3">
            <span className="text-xs text-pink-300 shrink-0">
              🎵 Previewing: {musicPresets.find((p) => p.id === playingMusicPreset)?.name}
            </span>
            <audio
              controls
              autoPlay
              src={api.musicPreviewUrl(playingMusicPreset)}
              className="h-7 w-full max-w-md"
              onEnded={() => setPlayingMusicPreset(null)}
            />
          </div>
        )}
      </div>

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
          <div className="mb-3 flex items-center justify-between">
            <span className="flex items-center gap-2 font-medium">
              <Sparkles className="h-4 w-4 text-red-600" /> Get video ideas
            </span>
            <span className="text-[11px] text-zinc-400">
              For {channel.name}
            </span>
          </div>
          {status.ai ? (
            <div className="space-y-3">
              <input value={focus} onChange={(e) => setFocus(e.target.value)} placeholder="Optional focus, e.g. Lighthouse disappearance, Victorian mystery..." />
              <div className="flex flex-wrap items-center gap-2">
                <select className="max-w-28 text-xs" value={count} onChange={(e) => setCount(Number(e.target.value))}>
                  {[2, 3, 5, 10, 15, 20].map((n) => (
                    <option key={n} value={n}>
                      {n} ideas
                    </option>
                  ))}
                </select>
                <button className="btn-primary text-xs" onClick={() => generate()} disabled={!!busy}>
                  {busy === "ideas" ? <Spinner className="h-3 w-3" /> : <Sparkles className="h-3 w-3" />}
                  {busy === "ideas" ? "Thinking…" : "Generate ideas"}
                </button>
                <button className="btn-ghost text-xs" onClick={() => setShowAdd(!showAdd)}>
                  <Plus className="h-3 w-3" /> Add my own
                </button>
              </div>

              {/* Quick 1-click generators */}
              <div className="flex flex-wrap items-center gap-1.5 pt-1 border-t border-white/[0.06]">
                <span className="text-[11px] text-zinc-400 mr-1">Quick:</span>
                <button
                  type="button"
                  className="rounded-lg border border-pink-500/30 bg-pink-500/10 px-2.5 py-1 text-xs font-semibold text-pink-300 hover:bg-pink-500/20 transition flex items-center gap-1"
                  disabled={!!busy}
                  onClick={() => generate(2)}
                >
                  <Zap className="h-3 w-3" /> 2 Ideas
                </button>
                <button
                  type="button"
                  className="rounded-lg border border-purple-500/30 bg-purple-500/10 px-2.5 py-1 text-xs font-semibold text-purple-300 hover:bg-purple-500/20 transition flex items-center gap-1"
                  disabled={!!busy}
                  onClick={() => generate(3)}
                >
                  <Zap className="h-3 w-3" /> 3 Ideas
                </button>
                <button
                  type="button"
                  className="rounded-lg border border-cyan-500/30 bg-cyan-500/10 px-2.5 py-1 text-xs font-semibold text-cyan-300 hover:bg-cyan-500/20 transition flex items-center gap-1"
                  disabled={!!busy}
                  onClick={() => generate(5)}
                >
                  <Zap className="h-3 w-3" /> 5 Ideas
                </button>
              </div>
            </div>
          ) : (
            <p className="muted">
              Add your Anthropic or Gemini API key on the <a className="underline" href="#/setup">Setup</a> page to generate ideas.{" "}
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

      {/* Story-to-Series Generator (Episodic Multi-Part Shorts) */}
      <div className="card mb-6 border-pink-500/30 bg-gradient-to-br from-[#121524] to-[#1d142b] shadow-[0_0_25px_rgba(255,0,153,0.08)]">
        <div
          className="flex cursor-pointer items-center justify-between"
          onClick={() => setShowSeries(!showSeries)}
        >
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-pink-500 to-purple-600 text-white shadow-md">
              <BookOpen className="h-5 w-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="font-display text-sm font-bold text-white">
                  Story-to-Series (Episodic Multi-Part Shorts)
                </h3>
                <span className="rounded-full bg-pink-500/20 px-2 py-0.5 text-[10px] font-semibold text-pink-300 uppercase tracking-wider">
                  Continuous Story
                </span>
              </div>
              <p className="text-xs text-zinc-400">
                Paste any story in any language &rarr; AI turns it into 2-4 continuous parts with narrative cliffhangers
              </p>
            </div>
          </div>
          <button
            type="button"
            className="btn-secondary text-xs py-1.5 px-3 flex items-center gap-1.5"
            onClick={(e) => {
              e.stopPropagation();
              setShowSeries(!showSeries);
            }}
          >
            {showSeries ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            {showSeries ? "Close Story Panel" : "Open Story Panel"}
          </button>
        </div>

        {showSeries && (
          <div className="mt-4 pt-4 border-t border-white/[0.08] space-y-4">
            <div>
              <label className="mb-1.5 block text-xs font-semibold text-zinc-200">
                Story Text / Document (Any Language):
              </label>
              <textarea
                rows={5}
                className="w-full text-xs font-mono"
                placeholder="Paste your story here in English, Urdu, Hindi, Spanish, French, etc... The AI will craft continuous episodes in the channel's target language with hooks and cliffhangers."
                value={storyText}
                onChange={(e) => setStoryText(e.target.value)}
              />
            </div>

            <div className="grid gap-3 sm:grid-cols-3">
              <div>
                <label className="mb-1 block text-xs font-medium text-zinc-300">Episodes / Parts</label>
                <select
                  value={seriesParts}
                  onChange={(e) => setSeriesParts(Number(e.target.value))}
                  className="text-xs w-full"
                >
                  <option value={2}>2 Parts (Shorts)</option>
                  <option value={3}>3 Parts (Shorts)</option>
                  <option value={4}>4 Parts (Shorts)</option>
                </select>
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium text-zinc-300">Format</label>
                <select
                  value={seriesFormat}
                  onChange={(e) => setSeriesFormat(e.target.value as VideoFormat)}
                  className="text-xs w-full"
                >
                  <option value="short">YouTube Short (vertical 9:16)</option>
                  <option value="long">Long-form Video (16:9)</option>
                </select>
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium text-zinc-300">Visual Style</label>
                <input
                  value={seriesStyle}
                  onChange={(e) => setSeriesStyle(e.target.value)}
                  placeholder="Atmospheric historical style..."
                  className="text-xs w-full"
                />
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
              <label className="flex items-center gap-2 text-xs text-zinc-300 cursor-pointer">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-[#ff0099]"
                  checked={autoProduceSeries}
                  onChange={(e) => setAutoProduceSeries(e.target.checked)}
                />
                <span>Auto-make full video files right away (voiceover + pictures)</span>
              </label>

              <button
                type="button"
                className="btn-primary text-xs py-2 px-4 flex items-center gap-2"
                disabled={busy === "series" || !storyText.trim()}
                onClick={handleCreateSeries}
              >
                {busy === "series" ? <Spinner className="h-4 w-4" /> : <Sparkles className="h-4 w-4" />}
                {busy === "series" ? "Splitting & Scripting Episodes…" : `Create ${seriesParts} Episodic Shorts`}
              </button>
            </div>
          </div>
        )}
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
                          : newlyCreatedIds.has(v.id)
                          ? "border-emerald-500/80 bg-[#122221] shadow-[0_0_20px_rgba(52,211,153,0.25)]"
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
                          <div className="flex items-start justify-between gap-1 mb-1.5">
                            <p className="font-medium leading-snug text-zinc-200 group-hover:text-pink-300 transition">
                              {v.title}
                            </p>
                            {newlyCreatedIds.has(v.id) && (
                              <span className="shrink-0 rounded-full bg-emerald-500/20 border border-emerald-500/40 text-emerald-300 text-[9px] font-bold px-1.5 py-0.5">
                                ✨ NEW
                              </span>
                            )}
                          </div>
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
