import { useEffect, useState } from "react";
import { 
  AlertCircle,
  ArrowRight, 
  BookOpen, 
  CalendarClock, 
  Check, 
  CheckCircle2, 
  Clapperboard, 
  Clock, 
  Eye, 
  Film, 
  Layers, 
  Lightbulb, 
  ListOrdered, 
  Mic, 
  Pencil, 
  Plus, 
  Send, 
  Sparkles, 
  TrendingUp, 
  Upload, 
  Users, 
  Video as VideoIcon, 
  Wand2, 
  X, 
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

interface LiveProgressState {
  active: boolean;
  title: string;
  step: string;
  stepIndex: number;
  totalSteps: number;
  elapsedSeconds: number;
}

export default function Dashboard() {
  const { channels, status, reloadChannels } = useApp();
  const [videos, setVideos] = useState<Video[]>([]);
  const [tab, setTab] = useState<"prompt" | "series" | "ideas">("prompt");
  
  // Prompt mode state
  const [prompt, setPrompt] = useState("");
  const [selectedChannelId, setSelectedChannelId] = useState<string>("");
  const [format, setFormat] = useState<VideoFormat>("short");
  const [runAction, setRunAction] = useState<"auto" | "idea" | "ideas_pack">("auto");
  
  // Story-to-Series state
  const [storyText, setStoryText] = useState("");
  const [seriesParts, setSeriesParts] = useState(3);
  const [seriesFormat, setSeriesFormat] = useState<VideoFormat>("short");
  const [seriesStyle, setSeriesStyle] = useState(
    "Cinematic historical documentary still, moody candlelit atmosphere, dramatic chiaroscuro lighting, 19th century textures, 35mm grain, no text"
  );
  const [autoProduceSeries, setAutoProduceSeries] = useState(false);
  const [createdSeriesEpisodes, setCreatedSeriesEpisodes] = useState<Video[]>([]);

  // Feedback & Progress state
  const [successNotice, setSuccessNotice] = useState<string | null>(null);
  const [progressState, setProgressState] = useState<LiveProgressState | null>(null);
  const { busy, error, setError, run } = useAction();

  useEffect(() => {
    api.videos().then(setVideos).catch((e) => setError(e.message));
  }, [setError]);

  useEffect(() => {
    if (channels.length > 0 && !selectedChannelId) {
      setSelectedChannelId(channels[0].id);
    }
  }, [channels, selectedChannelId]);

  // Live timer for progress card
  useEffect(() => {
    if (!progressState?.active) return;
    const timer = setInterval(() => {
      setProgressState((prev) => prev ? { ...prev, elapsedSeconds: prev.elapsedSeconds + 1 } : null);
    }, 1000);
    return () => clearInterval(timer);
  }, [progressState?.active]);

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

  // Smart prompt intent parser
  const handleSmartPromptSubmit = () => {
    const raw = prompt.trim();
    if (!raw) return;

    // Check if the user is asking to generate ideas
    const ideasMatch = raw.match(/(?:create|generate|give me|suggest|find)\s*(\d+)?\s*(?:unique|viral|new|fresh)?\s*(?:video\s+)?ideas?(?:\s+for\s+(?:my\s+)?(?:channel\s+)?["']?([^"']+)["']?)?/i);
    
    // Check if channel is mentioned in prompt
    let targetChannel = activeChannel;
    if (ideasMatch && ideasMatch[2]) {
      const mentioned = ideasMatch[2].toLowerCase();
      const found = channels.find((c) => c.name.toLowerCase().includes(mentioned) || mentioned.includes(c.name.toLowerCase()));
      if (found) targetChannel = found;
    } else {
      // General scan for channel name in prompt
      for (const c of channels) {
        if (raw.toLowerCase().includes(c.name.toLowerCase())) {
          targetChannel = c;
          break;
        }
      }
    }

    // Check if prompt is a request for a series/story
    if (/(\bstory|\bseries|\bparts|\bepisodes|\bsplit into)/i.test(raw)) {
      setStoryText(raw);
      setTab("series");
      return;
    }

    if (ideasMatch || runAction === "ideas_pack") {
      const count = ideasMatch && ideasMatch[1] ? Math.min(10, Math.max(2, parseInt(ideasMatch[1], 10))) : 5;
      const focus = raw
        .replace(/(?:create|generate|give me|suggest|find)\s*\d*\s*(?:unique|viral|new|fresh)?\s*(?:video\s+)?ideas?(?:\s+for\s+(?:my\s+)?(?:channel\s+)?["']?[^"']+["']?)?/i, "")
        .replace(/^[,\s;:-]+/, "")
        .trim();

      handleGenerateIdeas(targetChannel?.id || activeChannel.id, count, focus || undefined);
    } else {
      // Standard video creation
      handleCreateVideo(targetChannel?.id || activeChannel.id, raw);
    }
  };

  const handleGenerateIdeas = (channelId: string, count: number, focus?: string) => {
    run("ideas", async () => {
      setError(null);
      setSuccessNotice(null);
      setProgressState({
        active: true,
        title: `Generating ${count} Viral Ideas`,
        step: "Searching trends & historical curiosities on the web...",
        stepIndex: 1,
        totalSteps: 3,
        elapsedSeconds: 0,
      });

      try {
        setTimeout(() => {
          setProgressState((prev) => prev ? { ...prev, step: "Crafting hooks, curiosity gaps & cliffhangers...", stepIndex: 2 } : null);
        }, 4000);

        const ideas = await api.generateIdeas(channelId, count, focus);
        setProgressState((prev) => prev ? { ...prev, step: `Finalizing ${ideas.length} ideas...`, stepIndex: 3 } : null);

        setPrompt("");
        const refreshed = await api.videos();
        setVideos(refreshed);
        const ch = channels.find((c) => c.id === channelId);
        setSuccessNotice(`Successfully created ${ideas.length} new ideas for "${ch?.name || 'your channel'}"! They are ready in your channel board.`);
      } finally {
        setProgressState(null);
      }
    });
  };

  const handleCreateVideo = (channelId: string, title: string) => {
    run("create", async () => {
      setError(null);
      setSuccessNotice(null);
      setProgressState({
        active: true,
        title: `Creating Video: "${title}"`,
        step: "Setting up video card & format specifications...",
        stepIndex: 1,
        totalSteps: runAction === "auto" ? 4 : 2,
        elapsedSeconds: 0,
      });

      try {
        const video = await api.createVideo({
          channelId,
          title,
          format,
        });

        if (runAction === "auto") {
          setProgressState((prev) => prev ? { ...prev, step: "AI Research & Writing hook-first script...", stepIndex: 2 } : null);
          await api.startPipeline([video.id], "video");
        }

        setPrompt("");
        navigate(`/videos/${video.id}`);
      } finally {
        setProgressState(null);
      }
    });
  };

  // Story to Multi-Part Series
  const handleSplitStory = () => {
    if (!activeChannel) return;
    if (!storyText.trim()) return;

    run("series", async () => {
      setError(null);
      setSuccessNotice(null);
      setCreatedSeriesEpisodes([]);
      setProgressState({
        active: true,
        title: `Transforming Story into ${seriesParts}-Part Series`,
        step: "Translating & structuring narrative arc into continuous parts...",
        stepIndex: 1,
        totalSteps: 4,
        elapsedSeconds: 0,
      });

      try {
        setTimeout(() => {
          setProgressState((prev) => prev ? { ...prev, step: "Writing 50-second Short scripts with cliffhangers...", stepIndex: 2 } : null);
        }, 6000);

        setTimeout(() => {
          setProgressState((prev) => prev ? { ...prev, step: "Locking in visual style anchor for consistent imagery...", stepIndex: 3 } : null);
        }, 12000);

        const res = await api.splitStoryIntoSeries({
          channelId: activeChannel.id,
          story: storyText.trim(),
          parts: seriesParts,
          format: seriesFormat,
          visualStyle: seriesStyle,
          autoProduce: autoProduceSeries,
        });

        setProgressState((prev) => prev ? { ...prev, step: "Done! Created all episodes.", stepIndex: 4 } : null);

        setCreatedSeriesEpisodes(res.episodes);
        setVideos(await api.videos());
        setSuccessNotice(
          `Created ${res.episodes.length}-part series for "${activeChannel.name}"! Each part ends on a cliffhanger to maximize retention.`
        );
      } finally {
        setProgressState(null);
      }
    });
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (evt) => {
      const content = evt.target?.result as string;
      if (content) setStoryText(content);
    };
    reader.readAsText(file);
  };

  // Quick switch channel visuals to AI Pictures
  const handleSetAiPictures = async (channel: Channel) => {
    run("upgrade_visuals", async () => {
      await api.updateChannel(channel.id, {
        visuals: "pictures",
        look: "cinematic",
        pictureStyle: "Cinematic film still, photorealistic, historically accurate for the period, moody chiaroscuro lighting, 35mm grain, no modern objects, no text",
      });
      await reloadChannels();
      setSuccessNotice(`Upgraded "${channel.name}" to AI Pictures (Gemini)! Every shot will now be drawn as authentic historical artwork instead of stock footage.`);
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
          <p className="mx-auto mt-3 max-w-xl text-zinc-300">
            Plan, write, render and schedule videos across multiple YouTube channels using state-of-the-art AI.
          </p>
        </div>

        {(!status.ai || !status.youtube) && (
          <div className="mb-6 rounded-2xl border border-amber-500/30 bg-amber-950/30 p-4 text-sm text-amber-200 backdrop-blur-md">
            Some features require API keys. Visit <a className="font-semibold text-pink-300 underline" href="#/setup">Setup</a> to add keys.
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
                  <p className="font-semibold text-zinc-100">{title}</p>
                  <p className="text-xs text-zinc-300">{body}</p>
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
      <ErrorBox error={error} onClose={() => setError(null)} />

      {successNotice && (
        <div className="flex items-center justify-between rounded-xl border border-emerald-500/30 bg-emerald-950/40 p-4 text-sm text-emerald-200 backdrop-blur-md shadow-[0_4px_20px_rgba(16,185,129,0.15)]">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-emerald-400 shrink-0" />
            <span>{successNotice}</span>
          </div>
          <button className="text-emerald-400 hover:text-emerald-200 text-xs underline font-semibold" onClick={() => setSuccessNotice(null)}>
            Dismiss
          </button>
        </div>
      )}

      {/* LIVE PROGRESS MODAL / OVERLAY */}
      {progressState && (
        <div className="rounded-2xl border border-pink-500/40 bg-[#121526]/95 p-5 shadow-[0_10px_40px_rgba(255,0,153,0.25)] backdrop-blur-2xl transition">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-pink-500/20 text-pink-400 shadow-[0_0_15px_rgba(255,0,153,0.3)]">
                <Spinner className="h-5 w-5" />
              </div>
              <div>
                <h3 className="font-display font-bold text-white text-base sm:text-lg">
                  {progressState.title}
                </h3>
                <p className="text-xs text-pink-300 flex items-center gap-1.5 mt-0.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-pink-400 animate-ping" />
                  {progressState.step}
                </p>
              </div>
            </div>
            <div className="text-right">
              <span className="flex items-center gap-1 text-xs text-zinc-400 font-mono">
                <Clock className="h-3 w-3" /> {progressState.elapsedSeconds}s
              </span>
              <span className="text-[11px] text-zinc-500">
                Step {progressState.stepIndex} of {progressState.totalSteps}
              </span>
            </div>
          </div>
          <div className="mt-4 h-1.5 w-full overflow-hidden rounded-full bg-white/10">
            <div
              className="h-full bg-gradient-to-r from-pink-500 to-purple-600 transition-all duration-500"
              style={{ width: `${(progressState.stepIndex / progressState.totalSteps) * 100}%` }}
            />
          </div>
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
        <p className="relative mt-2 max-w-xl text-sm text-zinc-300">
          Create viral YouTube Shorts, break long stories into multi-part series, or direct full cinematic videos.
        </p>

        {/* Studio Mode Selector Pills */}
        <div className="relative mt-6 inline-flex rounded-full border border-white/12 bg-black/50 p-1 backdrop-blur-md">
          <button
            type="button"
            onClick={() => setTab("prompt")}
            className={`flex items-center gap-1.5 rounded-full px-4 py-2 text-xs font-semibold transition ${
              tab === "prompt"
                ? "bg-gradient-to-r from-pink-500 to-purple-600 text-white shadow-[0_0_15px_rgba(255,0,153,0.35)]"
                : "text-zinc-300 hover:text-white"
            }`}
          >
            <Sparkles className="h-3.5 w-3.5" />
            Fast Creation & Ideas
          </button>
          
          <button
            type="button"
            onClick={() => setTab("series")}
            className={`flex items-center gap-1.5 rounded-full px-4 py-2 text-xs font-semibold transition ${
              tab === "series"
                ? "bg-gradient-to-r from-purple-500 to-indigo-600 text-white shadow-[0_0_15px_rgba(168,85,247,0.35)]"
                : "text-zinc-300 hover:text-white"
            }`}
          >
            <BookOpen className="h-3.5 w-3.5" />
            Story-to-Series (Episodic Parts)
          </button>
        </div>

        {/* TAB 1: FAST PROMPT & IDEAS CONSOLE */}
        {tab === "prompt" && (
          <div className="relative mt-6 w-full max-w-3xl">
            <div className="group relative rounded-2xl border border-white/12 bg-[#0e101a]/90 p-4 backdrop-blur-2xl shadow-[0_12px_40px_rgba(0,0,0,0.6),inset_0_1px_0_rgba(255,255,255,0.1)] transition focus-within:border-pink-500/50 focus-within:shadow-[0_12px_45px_rgba(255,0,153,0.15)]">
              <textarea
                rows={2}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    handleSmartPromptSubmit();
                  }
                }}
                placeholder="Ask anything or enter a topic (e.g. 'create 3 unique ideas for History\'s Shadows', 'The mystery of the lost Roman legion', '5 AI tools replacing design agencies')..."
                className="w-full resize-none border-0 bg-transparent p-1 text-sm text-white placeholder-zinc-400 outline-none focus:ring-0 sm:text-base"
              />

              {/* Bottom Controls Row inside Prompt Box */}
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2.5 border-t border-white/[0.08] pt-3">
                <div className="flex flex-wrap items-center gap-2">
                  {/* Channel Selector */}
                  <div className="flex items-center gap-1 rounded-xl border border-white/10 bg-white/[0.04] px-2.5 py-1.5 text-xs font-medium text-zinc-200">
                    <span className="text-zinc-400">Channel:</span>
                    <select
                      value={selectedChannelId}
                      onChange={(e) => setSelectedChannelId(e.target.value)}
                      className="border-0 bg-transparent p-0 text-xs font-semibold text-white outline-none focus:ring-0"
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
                        format === "short" ? "bg-white/20 text-white font-semibold" : "text-zinc-300 hover:text-white"
                      }`}
                    >
                      📱 Short
                    </button>
                    <button
                      type="button"
                      onClick={() => setFormat("long")}
                      className={`rounded-lg px-2.5 py-1 font-medium transition ${
                        format === "long" ? "bg-white/20 text-white font-semibold" : "text-zinc-300 hover:text-white"
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
                      className={`rounded-lg px-2.5 py-1 transition ${
                        runAction === "auto" ? "bg-pink-500/25 text-pink-300 font-semibold" : "text-zinc-300 hover:text-white"
                      }`}
                      title="Generate script and produce video automatically"
                    >
                      ⚡ Auto-Produce
                    </button>
                    <button
                      type="button"
                      onClick={() => setRunAction("idea")}
                      className={`rounded-lg px-2.5 py-1 transition ${
                        runAction === "idea" ? "bg-white/20 text-white font-semibold" : "text-zinc-300 hover:text-white"
                      }`}
                      title="Create video card and edit manually"
                    >
                      📝 Manual Card
                    </button>
                    <button
                      type="button"
                      onClick={() => setRunAction("ideas_pack")}
                      className={`rounded-lg px-2.5 py-1 transition ${
                        runAction === "ideas_pack" ? "bg-purple-500/25 text-purple-300 font-semibold" : "text-zinc-300 hover:text-white"
                      }`}
                      title="Generate viral ideas for channel"
                    >
                      💡 Ideas Pack
                    </button>
                  </div>
                </div>

                {/* Submit Button */}
                <button
                  type="button"
                  disabled={!prompt.trim() || !!busy}
                  onClick={handleSmartPromptSubmit}
                  className="btn-primary shrink-0 rounded-full px-5 py-2 text-xs font-semibold"
                >
                  {busy ? (
                    <Spinner className="h-4 w-4" />
                  ) : (
                    <>
                      <span>Execute</span>
                      <Sparkles className="h-3.5 w-3.5" />
                    </>
                  )}
                </button>
              </div>
            </div>

            {/* Quick Action Chips */}
            <div className="mt-3.5 flex flex-wrap items-center justify-center gap-2">
              <button
                onClick={() => {
                  setPrompt("Generate 3 unique viral ideas for History's Shadows");
                  handleGenerateIdeas(activeChannel.id, 3, "unsolved historical mysteries with a shocking twist");
                }}
                className="inline-flex items-center gap-1.5 rounded-full border border-purple-500/30 bg-purple-500/10 px-3 py-1.5 text-xs text-purple-200 transition hover:bg-purple-500/20"
              >
                <Lightbulb className="h-3.5 w-3.5 text-purple-300" />
                <span>Get 3 Unique Ideas for {activeChannel.name}</span>
              </button>

              <button
                onClick={() => setTab("series")}
                className="inline-flex items-center gap-1.5 rounded-full border border-pink-500/30 bg-pink-500/10 px-3 py-1.5 text-xs text-pink-200 transition hover:bg-pink-500/20"
              >
                <BookOpen className="h-3.5 w-3.5 text-pink-300" />
                <span>Create Multi-Part Story Series</span>
              </button>

              <a
                href="#/calendar"
                className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs text-zinc-300 transition hover:bg-white/[0.08]"
              >
                <CalendarClock className="h-3.5 w-3.5 text-amber-300" />
                <span>Schedule Queue</span>
              </a>
            </div>
          </div>
        )}

        {/* TAB 2: STORY-TO-SERIES / EPISODIC GENERATOR */}
        {tab === "series" && (
          <div className="relative mt-6 w-full max-w-3xl text-left">
            <div className="card space-y-5 border-purple-500/30 shadow-[0_12px_45px_rgba(168,85,247,0.15)]">
              <div>
                <div className="flex items-center justify-between">
                  <h2 className="font-display flex items-center gap-2 text-lg font-bold text-white">
                    <BookOpen className="h-5 w-5 text-purple-400" />
                    Story-to-Series: Multi-Part Episodic Shorts
                  </h2>
                  <span className="rounded-full border border-purple-500/30 bg-purple-500/10 px-2.5 py-0.5 text-xs font-semibold text-purple-300">
                    High Retention
                  </span>
                </div>
                <p className="mt-1 text-xs text-zinc-300">
                  Paste or upload any story in <b>any language</b> (English, Spanish, Hindi, French, Arabic, etc.). The AI translates, adapts, and breaks it into continuous, serialized episodes with cliffhangers and consistent visual anchors.
                </p>
              </div>

              {/* Story Input Area */}
              <div>
                <div className="mb-1.5 flex items-center justify-between">
                  <label className="text-xs font-semibold text-zinc-200">
                    Paste Story Text or Upload File
                  </label>
                  <label className="cursor-pointer text-xs font-medium text-pink-400 hover:text-pink-300 flex items-center gap-1">
                    <Upload className="h-3.5 w-3.5" />
                    <span>Upload .txt / .md</span>
                    <input type="file" accept=".txt,.md,.text" className="hidden" onChange={handleFileUpload} />
                  </label>
                </div>
                <textarea
                  rows={6}
                  value={storyText}
                  onChange={(e) => setStoryText(e.target.value)}
                  placeholder="Paste your story here (can be in any language). E.g. 'In December 1872, a British merchant brig discovered the Mary Celeste drifting off Portugal. Her sails were set, six months of provisions were untouched, but the captain and entire crew were gone without a struggle...' or a myth, true crime investigation, or folktale..."
                  className="w-full text-xs sm:text-sm"
                />
              </div>

              {/* Controls Row */}
              <div className="grid gap-4 sm:grid-cols-3">
                <div>
                  <label className="text-xs font-semibold text-zinc-200">Target Channel</label>
                  <select
                    value={selectedChannelId}
                    onChange={(e) => setSelectedChannelId(e.target.value)}
                    className="text-xs"
                  >
                    {channels.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="text-xs font-semibold text-zinc-200">Number of Parts / Episodes</label>
                  <select
                    value={seriesParts}
                    onChange={(e) => setSeriesParts(parseInt(e.target.value, 10))}
                    className="text-xs"
                  >
                    <option value={2}>2 Parts (Short Tale)</option>
                    <option value={3}>3 Parts (Standard Trilogy - Recommended)</option>
                    <option value={4}>4 Parts (Detailed Deep Dive)</option>
                    <option value={5}>5 Parts (Epic Narrative Arc)</option>
                  </select>
                </div>

                <div>
                  <label className="text-xs font-semibold text-zinc-200">Episode Format</label>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => setSeriesFormat("short")}
                      className={`btn flex-1 text-xs py-2 ${
                        seriesFormat === "short" ? "btn-primary" : "btn-secondary"
                      }`}
                    >
                      📱 Shorts (50s)
                    </button>
                    <button
                      type="button"
                      onClick={() => setSeriesFormat("long")}
                      className={`btn flex-1 text-xs py-2 ${
                        seriesFormat === "long" ? "btn-primary" : "btn-secondary"
                      }`}
                    >
                      🎬 Long
                    </button>
                  </div>
                </div>
              </div>

              {/* Visual Consistency Anchor */}
              <div>
                <label className="text-xs font-semibold text-zinc-200">
                  Shared Visual Consistency Anchor (Style for All Episodes)
                </label>
                <input
                  value={seriesStyle}
                  onChange={(e) => setSeriesStyle(e.target.value)}
                  placeholder="e.g. Victorian dark mystery, rainy cobblestones, candlelight, 35mm cinematic grain..."
                  className="text-xs"
                />
                <p className="mt-1 text-[11px] text-zinc-400">
                  This anchor is injected into every shot prompt across all episodes to ensure actors, lighting, and period clothes stay visually identical.
                </p>
              </div>

              {/* Auto produce checkbox */}
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="auto_produce_chk"
                  checked={autoProduceSeries}
                  onChange={(e) => setAutoProduceSeries(e.target.checked)}
                />
                <label htmlFor="auto_produce_chk" className="text-xs text-zinc-300 font-medium cursor-pointer mb-0">
                  Automatically start AI background rendering for all parts as soon as scripted
                </label>
              </div>

              {/* Submit Button */}
              <div className="pt-2 flex justify-end gap-3">
                <button
                  type="button"
                  disabled={!storyText.trim() || !!busy}
                  onClick={handleSplitStory}
                  className="btn-primary w-full sm:w-auto"
                >
                  {busy === "series" ? <Spinner /> : <Sparkles className="h-4 w-4" />}
                  <span>Generate {seriesParts}-Part Series</span>
                </button>
              </div>

              {/* Resulting Episodes Preview */}
              {createdSeriesEpisodes.length > 0 && (
                <div className="mt-6 border-t border-white/[0.08] pt-5 space-y-3">
                  <h3 className="font-display text-sm font-bold text-emerald-300 flex items-center gap-2">
                    <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                    Series Created ({createdSeriesEpisodes.length} Episodes Ready)
                  </h3>
                  <div className="grid gap-3">
                    {createdSeriesEpisodes.map((ep, idx) => (
                      <div
                        key={ep.id}
                        className="rounded-xl border border-white/10 bg-white/[0.03] p-3 flex items-center justify-between gap-3"
                      >
                        <div className="min-w-0">
                          <p className="font-semibold text-xs sm:text-sm text-white truncate">
                            {ep.title}
                          </p>
                          <p className="text-[11px] text-zinc-400 line-clamp-1 mt-0.5">
                            Hook: "{ep.hook}"
                          </p>
                        </div>
                        <a
                          href={`#/videos/${ep.id}`}
                          className="btn-secondary text-xs shrink-0 py-1.5 px-3"
                        >
                          Open Episode &rarr;
                        </a>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </section>

      {/* HISTORICAL ACCURACY ADVISORY FOR HISTORY CHANNELS */}
      {channels.some((c) => c.name.toLowerCase().includes("history") && c.visuals !== "pictures") && (
        <section className="rounded-2xl border border-amber-500/30 bg-amber-950/30 p-4 backdrop-blur-md">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-start gap-3">
              <AlertCircle className="h-5 w-5 text-amber-400 shrink-0 mt-0.5" />
              <div>
                <h3 className="font-display font-bold text-white text-sm">
                  Recommended: Upgrade History Channel Visuals to AI Pictures
                </h3>
                <p className="text-xs text-amber-200/90 mt-0.5">
                  Stock footage from Pexels often returns modern footage for historical queries. Switching to <b>AI Pictures (Gemini)</b> draws authentic period-accurate oil paintings and cinematic stills for every single shot.
                </p>
              </div>
            </div>
            {channels
              .filter((c) => c.name.toLowerCase().includes("history") && c.visuals !== "pictures")
              .map((c) => (
                <button
                  key={c.id}
                  onClick={() => handleSetAiPictures(c)}
                  disabled={!!busy}
                  className="btn-primary text-xs shrink-0"
                >
                  <Sparkles className="h-3.5 w-3.5" /> Switch "{c.name}" to AI Pictures
                </button>
              ))}
          </div>
        </section>
      )}

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
                    <p className="truncate text-xs text-zinc-300">{c.niche || "YouTube Channel"}</p>
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
                  <div className="mb-3 flex gap-4 text-xs text-zinc-200">
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

                <div className="flex items-center justify-between border-t border-white/[0.08] pt-3 text-xs text-zinc-300">
                  <div className="flex gap-2">
                    <span className="text-white font-medium">{count("idea")}</span> ideas ·{" "}
                    <span className="text-cyan-300 font-medium">{inProgress}</span> active ·{" "}
                    <span className="text-pink-300 font-medium">{scheduled}</span> queued
                  </div>
                  <span className="text-pink-400 opacity-0 group-hover:opacity-100 transition flex items-center gap-0.5 font-semibold">
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
            <a href="#/calendar" className="text-xs text-pink-400 hover:underline font-medium">
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
            <span className="text-xs text-zinc-400">{nextUp.length} items</span>
          </div>

          {nextUp.length === 0 ? (
            <p className="muted py-4 text-center text-xs">
              No videos in progress. Select a channel above to generate ideas or create a series.
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
              <span className="text-xs text-zinc-300">Based on live YouTube metrics</span>
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
    <ul className="divide-y divide-white/[0.08]">
      {videos.map((v) => (
        <li key={v.id}>
          <a
            href={`#/videos/${v.id}`}
            className="group flex items-center justify-between gap-3 py-3 transition hover:text-pink-300"
          >
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-zinc-100 group-hover:text-pink-300 transition">
                {v.title}
              </p>
              <p className="text-xs text-zinc-400">{channelName(v.channelId)}</p>
            </div>
            <div className="flex shrink-0 items-center gap-2.5 text-xs text-zinc-300">
              <FormatBadge format={v.format} />
              <span className="rounded-md border border-white/10 bg-white/[0.04] px-2 py-0.5 text-zinc-200">
                {detail(v)}
              </span>
            </div>
          </a>
        </li>
      ))}
    </ul>
  );
}
