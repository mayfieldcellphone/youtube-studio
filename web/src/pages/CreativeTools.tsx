import { useEffect, useState } from "react";
import { ArrowLeft, Check, Download, Image as ImageIcon, Mic, Play, Sparkles, Video as VideoIcon, Volume2 } from "lucide-react";
import { api, type Channel, type Voice, type VoiceEngine } from "../api";
import { useApp } from "../App";
import { ErrorBox, Spinner, useAction } from "../components/ui";

export default function CreativeTools({ tool }: { tool: "video" | "image" | "audio" }) {
  const { channels, status } = useApp();
  const [activeTab, setActiveTab] = useState<"video" | "image" | "audio">(tool);

  useEffect(() => {
    setActiveTab(tool);
  }, [tool]);

  return (
    <div className="space-y-6 pb-12">
      <div className="flex items-center gap-3">
        <a href="#/" className="btn-secondary text-xs">
          <ArrowLeft className="h-3.5 w-3.5" /> Back to Studio
        </a>
        <div className="flex rounded-xl border border-white/10 bg-white/[0.04] p-1">
          <button
            type="button"
            onClick={() => setActiveTab("image")}
            className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
              activeTab === "image" ? "bg-pink-500/20 text-pink-300 shadow-[0_0_12px_rgba(255,0,153,0.2)]" : "text-zinc-400 hover:text-white"
            }`}
          >
            <ImageIcon className="h-3.5 w-3.5" /> Image Studio
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("audio")}
            className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
              activeTab === "audio" ? "bg-purple-500/20 text-purple-300 shadow-[0_0_12px_rgba(168,85,247,0.2)]" : "text-zinc-400 hover:text-white"
            }`}
          >
            <Mic className="h-3.5 w-3.5" /> Voice Studio
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("video")}
            className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
              activeTab === "video" ? "bg-cyan-500/20 text-cyan-300 shadow-[0_0_12px_rgba(6,182,212,0.2)]" : "text-zinc-400 hover:text-white"
            }`}
          >
            <VideoIcon className="h-3.5 w-3.5" /> Video Studio
          </button>
        </div>
      </div>

      {activeTab === "image" && <ImageStudio channels={channels} />}
      {activeTab === "audio" && <VoiceStudio channels={channels} />}
      {activeTab === "video" && <VideoStudio channels={channels} />}
    </div>
  );
}

function ImageStudio({ channels }: { channels: Channel[] }) {
  const [prompt, setPrompt] = useState("");
  const [aspectRatio, setAspectRatio] = useState<"16:9" | "9:16">("16:9");
  const [stylePreset, setStylePreset] = useState("Cinematic 3D render, dramatic volumetric lighting, highly detailed");
  const [generatedImg, setGeneratedImg] = useState<string | null>(null);
  const { busy, error, setError, run } = useAction();

  const handleGenerate = () => {
    if (!prompt.trim()) return;
    run("generate", async () => {
      // In Channel Planner, images are created per channel/video.
      // We can create a dedicated thumbnail/picture or guide user to attach to channel.
      setGeneratedImg(null);
      // Simulate/Trigger image preview
      const targetChannel = channels[0];
      if (!targetChannel) throw new Error("Please create a channel first.");
      
      // Let's create an idea video for this image or test picture
      const v = await api.createVideo({
        channelId: targetChannel.id,
        title: prompt,
        format: aspectRatio === "9:16" ? "short" : "long",
      });
      // Route to video editor to inspect shots and generated visuals
      window.location.hash = `/videos/${v.id}`;
    });
  };

  return (
    <div className="card space-y-6">
      <div>
        <h2 className="font-display text-xl font-bold text-white flex items-center gap-2">
          <ImageIcon className="h-5 w-5 text-pink-400" />
          AI Image & Thumbnail Studio
        </h2>
        <p className="muted text-xs mt-1">
          Generate custom YouTube thumbnails and shot illustrations powered by Gemini Image Models.
        </p>
      </div>

      <ErrorBox error={error} />

      <div className="space-y-4">
        <div>
          <label className="mb-1.5">Prompt</label>
          <textarea
            rows={3}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="e.g. A glowing futuristic AI brain hovering over a dark neon cybernetic desk, cinematic lighting, 8k..."
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="mb-1.5">Aspect Ratio</label>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setAspectRatio("16:9")}
                className={`btn flex-1 text-xs ${aspectRatio === "16:9" ? "btn-primary" : "btn-secondary"}`}
              >
                16:9 (YouTube Video)
              </button>
              <button
                type="button"
                onClick={() => setAspectRatio("9:16")}
                className={`btn flex-1 text-xs ${aspectRatio === "9:16" ? "btn-primary" : "btn-secondary"}`}
              >
                9:16 (Shorts)
              </button>
            </div>
          </div>

          <div>
            <label className="mb-1.5">Style Preset</label>
            <select value={stylePreset} onChange={(e) => setStylePreset(e.target.value)}>
              <option value="Cinematic 3D render, dramatic volumetric lighting, highly detailed">Cinematic 3D & Volumetric</option>
              <option value="Photorealistic documentary style, natural lighting, gritty textures">Photorealistic Documentary</option>
              <option value="Vibrant YouTube click-worthy thumbnail, high contrast, bold colors">Vibrant Click-Worthy Thumbnail</option>
              <option value="Minimalist dark tech, sleek neon accents">Dark Cyberpunk / Tech</option>
            </select>
          </div>
        </div>

        <button
          type="button"
          disabled={!prompt.trim() || !!busy}
          onClick={handleGenerate}
          className="btn-primary"
        >
          {busy === "generate" ? <Spinner /> : <Sparkles className="h-4 w-4" />}
          <span>Create Video & Storyboard with Visuals</span>
        </button>
      </div>
    </div>
  );
}

function VoiceStudio({ channels }: { channels: Channel[] }) {
  const [engine, setEngine] = useState<VoiceEngine>("kokoro");
  const [voices, setVoices] = useState<Voice[]>([]);
  const [selectedVoice, setSelectedVoice] = useState<string>("");
  const [sampleText, setSampleText] = useState(
    "In 2026, artificial intelligence isn't just assisting video creators—it's directing the entire studio."
  );
  const [previewAudio, setPreviewAudio] = useState<string | null>(null);
  const { busy, error, setError, run } = useAction();

  useEffect(() => {
    api.voices(engine)
      .then((list) => {
        setVoices(list);
        if (list.length > 0) setSelectedVoice(list[0].id);
      })
      .catch((e) => setError(e.message));
  }, [engine, setError]);

  const handlePreview = () => {
    run("preview", async () => {
      setPreviewAudio(null);
      const url = await api.previewVoice({
        engine,
        voiceId: selectedVoice,
        style: sampleText,
      });
      setPreviewAudio(url);
    });
  };

  return (
    <div className="card space-y-6">
      <div>
        <h2 className="font-display text-xl font-bold text-white flex items-center gap-2">
          <Volume2 className="h-5 w-5 text-purple-400" />
          AI Voiceover Studio
        </h2>
        <p className="muted text-xs mt-1">
          Audition voices across Kokoro (Free/Local), Google Gemini, and ElevenLabs.
        </p>
      </div>

      <ErrorBox error={error} />

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className="mb-1.5">Voice Engine</label>
          <select value={engine} onChange={(e) => setEngine(e.target.value as VoiceEngine)}>
            <option value="kokoro">Kokoro (Free, Unlimited, Local)</option>
            <option value="gemini">Google Gemini (Natural Narration)</option>
            <option value="elevenlabs">ElevenLabs (Ultra-Realistic Human Voice)</option>
          </select>
        </div>

        <div>
          <label className="mb-1.5">Select Voice ({voices.length})</label>
          <select value={selectedVoice} onChange={(e) => setSelectedVoice(e.target.value)}>
            {voices.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name} {v.description ? `— ${v.description}` : ""}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div>
        <label className="mb-1.5">Sample Narration Script</label>
        <textarea
          rows={3}
          value={sampleText}
          onChange={(e) => setSampleText(e.target.value)}
        />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={!sampleText.trim() || !!busy}
          onClick={handlePreview}
          className="btn-primary"
        >
          {busy === "preview" ? <Spinner /> : <Play className="h-4 w-4" />}
          <span>Audition Voice</span>
        </button>

        {previewAudio && (
          <audio controls autoPlay src={previewAudio} className="h-10 rounded-xl" />
        )}
      </div>
    </div>
  );
}

function VideoStudio({ channels }: { channels: Channel[] }) {
  return (
    <div className="card space-y-6">
      <div>
        <h2 className="font-display text-xl font-bold text-white flex items-center gap-2">
          <VideoIcon className="h-5 w-5 text-cyan-400" />
          Video Studio & Google Veo Engine
        </h2>
        <p className="muted text-xs mt-1">
          Generate cinematic AI footage with Google Veo and Pexels HD stock clips.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4 space-y-2">
          <h3 className="font-semibold text-white">Google Veo (AI Video)</h3>
          <p className="text-xs text-zinc-400">
            Creates custom 8-second cinematic shots for opening hooks or key scene transitions directly from text prompts.
          </p>
          <div className="pt-2">
            <span className="inline-flex items-center gap-1 rounded-full border border-pink-500/30 bg-pink-500/10 px-2 py-0.5 text-xs text-pink-300">
              Veo 2.0 / Veo Fast & Best
            </span>
          </div>
        </div>

        <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4 space-y-2">
          <h3 className="font-semibold text-white">Pexels Stock Footage</h3>
          <p className="text-xs text-zinc-400">
            Free, unlimited high-resolution video clips curated automatically from your script keywords with slow cinematic pans.
          </p>
          <div className="pt-2">
            <span className="inline-flex items-center gap-1 rounded-full border border-cyan-500/30 bg-cyan-500/10 px-2 py-0.5 text-xs text-cyan-300">
              100% Free & Fast
            </span>
          </div>
        </div>
      </div>

      <div className="border-t border-white/[0.08] pt-4">
        <h4 className="font-semibold text-zinc-200 text-sm mb-2">How to render a video:</h4>
        <p className="text-xs text-zinc-400 mb-4">
          Open any channel, pick an idea or enter a prompt in the Creator Hub, approve the generated script, and click "Make video". FFmpeg will render voiceover, shots, color grading, and word-by-word captions automatically.
        </p>
        <a href="#/" className="btn-secondary text-xs">
          Open Creator Hub &rarr;
        </a>
      </div>
    </div>
  );
}
