import { useEffect, useState } from "react";
import { api, CATEGORIES, DAY_NAMES, type Channel, type Voice, type VoiceEngine } from "../api";
import { navigate, useApp } from "../App";
import { ErrorBox, PageHeader, Spinner, useAction } from "../components/ui";

const EMPTY: Omit<Channel, "id" | "createdAt" | "youtube" | "stats"> = {
  name: "",
  niche: "",
  audience: "",
  tone: "",
  language: "English",
  postingDays: [1, 3, 5],
  postingTime: "17:00",
  categoryId: "22",
  voiceId: "",
  affiliateLinks: "",
  look: "clean",
};

const PRESETS = [
  {
    name: "AI Tools Explained",
    niche: "Honest reviews and tutorials of new AI tools: what they do, who they're for, free alternatives, and how to use them to save time or make money",
    audience: "Beginners, freelancers and small business owners who want to use AI without technical skills",
    tone: "Clear, upbeat and honest. Show real pros and cons, no hype",
    categoryId: "28",
    postingDays: [1, 3, 5],
    look: "clean" as const,
  },
  {
    name: "Money Moves",
    niche: "Personal finance and side hustles: saving, budgeting, investing basics, and realistic ways to earn extra income online",
    audience: "People aged 20-40 who want to earn more, save more and get out of debt",
    tone: "Practical, motivating and realistic. Never promise quick riches; show real numbers and risks",
    categoryId: "27",
    postingDays: [2, 4, 6],
    look: "warm" as const,
  },
  {
    name: "Untold History",
    niche: "Mysteries, unsolved cases and fascinating history stories told as gripping documentaries, always based on real sources",
    audience: "Curious adults who love documentaries, mysteries and true stories",
    tone: "Cinematic storyteller: suspenseful, vivid and respectful to real victims",
    categoryId: "27",
    postingDays: [0, 3, 5],
    look: "cinematic" as const,
    visuals: "pictures" as const,
    voiceStyle: "Narrate slowly and suspensefully, like a documentary narrator telling a true mystery, with dramatic pauses",
  },
];

export default function ChannelForm({ channelId }: { channelId?: string }) {
  const { channels, reloadChannels, status } = useApp();
  const [voices, setVoices] = useState<Voice[]>([]);
  const existing = channels.find((c) => c.id === channelId);
  const [form, setForm] = useState<Omit<Channel, "id" | "createdAt" | "youtube" | "stats">>(
    existing ? { ...EMPTY, ...existing } : EMPTY,
  );
  const { busy, error, run } = useAction();
  const preview = useAction();
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  // The engine used when none is chosen: the first one that's set up.
  const defaultEngine: VoiceEngine = status.gemini ? "gemini" : status.voice ? "elevenlabs" : "kokoro";
  const engine = form.voiceEngine ?? defaultEngine;
  const engineReady = engine === "kokoro" || (engine === "gemini" ? status.gemini : status.voice);

  useEffect(() => {
    setVoices([]);
    if (!engineReady) return;
    api
      .voices(engine)
      .then((list) => {
        setVoices(list);
        // A voice saved for another engine (e.g. an ElevenLabs voice ID) doesn't apply here.
        setForm((f) => (f.voiceId && !list.some((v) => v.id === f.voiceId) ? { ...f, voiceId: "" } : f));
      })
      .catch(() => {});
  }, [engine, engineReady]);

  if (channelId && !existing) return <p className="muted">Channel not found.</p>;

  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => setForm((f) => ({ ...f, [key]: value }));
  const toggleDay = (day: number) =>
    set("postingDays", form.postingDays.includes(day) ? form.postingDays.filter((d) => d !== day) : [...form.postingDays, day].sort());

  const save = () =>
    run("save", async () => {
      const saved = existing ? await api.updateChannel(existing.id, form) : await api.createChannel(form);
      await reloadChannels();
      navigate(`/channels/${saved.id}`);
    });

  const remove = () =>
    run("delete", async () => {
      if (!existing || !confirm(`Delete "${existing.name}" and all its videos from this app? Videos already on YouTube stay there.`)) return;
      await api.deleteChannel(existing.id);
      await reloadChannels();
      navigate("/");
    });

  return (
    <div className="max-w-2xl">
      <PageHeader
        title={existing ? `Edit ${existing.name}` : "New channel"}
        subtitle="The AI uses these details to write ideas, scripts and titles that fit your channel."
      />

      {!existing && (
        <div className="mb-6 flex flex-wrap items-center gap-2">
          <span className="muted">Start from a ready-made channel:</span>
          {PRESETS.map((ex) => (
            <button key={ex.name} className="btn-secondary" onClick={() => setForm({ ...EMPTY, ...ex })}>
              {ex.name}
            </button>
          ))}
        </div>
      )}

      <form
        className="card space-y-5"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <Field label="Channel name">
          <input required value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="e.g. Fix It Fast" />
        </Field>
        <Field label="What is the channel about?" hint="Be specific. “Phone screen repairs in my shop” beats “tech”.">
          <textarea required rows={2} value={form.niche} onChange={(e) => set("niche", e.target.value)} />
        </Field>
        <Field label="Who is it for?">
          <input value={form.audience} onChange={(e) => set("audience", e.target.value)} placeholder="e.g. People with a broken phone deciding whether to repair or replace" />
        </Field>
        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="Tone">
            <input value={form.tone} onChange={(e) => set("tone", e.target.value)} placeholder="e.g. Friendly expert, quick, no fluff" />
          </Field>
          <Field label="Language">
            <input value={form.language} onChange={(e) => set("language", e.target.value)} />
          </Field>
        </div>
        <Field label="YouTube category">
          <select value={form.categoryId} onChange={(e) => set("categoryId", e.target.value)}>
            {CATEGORIES.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Voice engine" hint="Used when the app makes videos automatically. You can switch any time.">
          <select
            value={engine}
            onChange={(e) => {
              setForm((f) => ({ ...f, voiceEngine: e.target.value as VoiceEngine, voiceId: "" }));
              setPreviewUrl(null);
            }}
          >
            <option value="kokoro">Kokoro: free and unlimited, runs on this computer (English)</option>
            <option value="gemini">Gemini: very natural, follows a style you describe (cheap; free tier has daily limits)</option>
            <option value="elevenlabs">ElevenLabs: most human, paid monthly characters</option>
          </select>
          {!engineReady && (
            <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">
              Add your {engine === "gemini" ? "Gemini" : "ElevenLabs"} key on the <a className="underline" href="#/setup">Setup</a> page first.
            </p>
          )}
          {engine === "kokoro" && (
            <p className="mt-1 text-xs text-zinc-500">The first video or preview downloads the voice model once (about 90 MB), so it takes a few extra minutes.</p>
          )}
        </Field>
        {engineReady && (
          <Field label="Narrator voice" hint="Pick a deep, calm voice for stories and a bright one for tips. Click Preview to hear it.">
            <div className="flex flex-wrap gap-2">
              <select className="min-w-0 flex-1" value={form.voiceId ?? ""} onChange={(e) => { set("voiceId", e.target.value); setPreviewUrl(null); }}>
                <option value="">
                  Default ({engine === "elevenlabs" ? "George" : engine === "gemini" ? "Charon" : "Michael"})
                </option>
                {voices.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}{v.description ? ` (${v.description})` : ""}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="btn-secondary"
                disabled={!!preview.busy}
                onClick={() =>
                  preview.run("preview", async () =>
                    setPreviewUrl(await api.previewVoice({ engine, voiceId: form.voiceId || undefined, style: form.voiceStyle || undefined })),
                  )
                }
              >
                {preview.busy && <Spinner />} Preview
              </button>
            </div>
            {previewUrl && <audio className="mt-2 w-full" src={previewUrl} controls autoPlay />}
            <ErrorBox error={preview.error} />
          </Field>
        )}
        {engine === "gemini" && (
          <Field label="Narration style" hint="Describe how the narrator should sound. Gemini follows it; the other engines ignore it. Leave empty to use a style that fits the video look.">
            <input
              value={form.voiceStyle ?? ""}
              onChange={(e) => set("voiceStyle", e.target.value)}
              placeholder={
                form.look === "cinematic"
                  ? "Default: a seasoned true-crime documentary narrator, low, calm and slow, building tension"
                  : form.look === "warm"
                    ? "Default: a trusted friend who is good with money, warm and confident"
                    : "Default: an energetic but credible tech YouTuber, clear and brisk"
              }
            />
          </Field>
        )}
        <Field label="Video look" hint="The color style of videos the app makes automatically.">
          <select value={form.look ?? "clean"} onChange={(e) => set("look", e.target.value as Channel["look"])}>
            <option value="cinematic">Cinematic: dark and moody, with a vignette (history, mystery, true crime)</option>
            <option value="clean">Clean: bright and crisp (tech, tutorials)</option>
            <option value="warm">Warm: friendly and golden (money, lifestyle)</option>
          </select>
        </Field>
        <Field
          label="Visuals"
          hint="What fills the screen while the narrator speaks. AI pictures show the actual story (the right era, place and people), which stock footage can't. Uses your Gemini key with billing. If a picture fails, stock footage is used for it."
        >
          <select value={form.visuals ?? "stock"} onChange={(e) => set("visuals", e.target.value as Channel["visuals"])}>
            <option value="stock">Stock footage (free, from Pexels)</option>
            <option value="pictures">AI pictures for every shot (about $0.70 per Short, $4 per 10-minute video)</option>
          </select>
          {form.visuals === "pictures" && !status.gemini && (
            <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">
              Add your Gemini key on the <a className="underline" href="#/setup">Setup</a> page first.
            </p>
          )}
        </Field>
        {form.visuals === "pictures" && (
          <Field
            label="Picture style (optional)"
            hint="How every picture should look. Leave empty for a style that matches the video look (for Cinematic: dark, realistic film stills with period details)."
          >
            <textarea
              rows={2}
              value={form.pictureStyle ?? ""}
              placeholder="e.g. Oil painting in the style of 19th-century realism, candlelit, dark background"
              onChange={(e) => set("pictureStyle", e.target.value)}
            />
          </Field>
        )}
        <Field
          label="AI footage (Google Veo)"
          hint="Custom AI-made shots for the moments that matter, instead of stock footage. Uses your Gemini key with billing. If an AI shot fails, stock footage is used for it."
        >
          <div className="flex flex-wrap gap-2">
            <select className="min-w-0 flex-1" value={form.aiFootage ?? "off"} onChange={(e) => set("aiFootage", e.target.value as Channel["aiFootage"])}>
              <option value="off">Off: stock footage only (free)</option>
              <option value="hook">Hook only: AI for the opening shot (about $1-3 per video)</option>
              <option value="key">Hook + key moments: up to 3 AI shots (about $4-10 per video)</option>
              <option value="all">Everything: AI for every scene (about $8-40 per video)</option>
            </select>
            {(form.aiFootage ?? "off") !== "off" && (
              <select className="w-auto" value={form.aiQuality ?? "fast"} onChange={(e) => set("aiQuality", e.target.value as Channel["aiQuality"])}>
                <option value="fast">Fast (cheaper)</option>
                <option value="best">Best quality</option>
              </select>
            )}
          </div>
          {(form.aiFootage ?? "off") !== "off" && !status.gemini && (
            <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">
              Add your Gemini key on the <a className="underline" href="#/setup">Setup</a> page first.
            </p>
          )}
        </Field>
        {existing && <MusicField channel={existing} onChange={reloadChannels} />}
        <Field label="Affiliate links (optional)" hint="One per line, e.g. “Notion AI: https://…”. The AI adds relevant ones to video descriptions.">
          <textarea rows={3} value={form.affiliateLinks ?? ""} onChange={(e) => set("affiliateLinks", e.target.value)} />
        </Field>
        <Field label="Posting days" hint="Used to suggest the next free upload slot.">
          <div className="flex flex-wrap gap-2">
            {DAY_NAMES.map((name, day) => (
              <button
                type="button"
                key={day}
                onClick={() => toggleDay(day)}
                className={`btn ${form.postingDays.includes(day) ? "bg-red-600 text-white" : "border border-zinc-300 dark:border-zinc-700"}`}
              >
                {name}
              </button>
            ))}
          </div>
        </Field>
        <Field label="Posting time">
          <input type="time" className="max-w-40" value={form.postingTime} onChange={(e) => set("postingTime", e.target.value)} />
        </Field>

        <ErrorBox error={error} />
        <div className="flex flex-wrap justify-between gap-2">
          <button className="btn-primary" disabled={!!busy}>
            {busy === "save" && <Spinner />} {existing ? "Save changes" : "Create channel"}
          </button>
          {existing && (
            <button type="button" className="btn-ghost text-red-600" onClick={remove} disabled={!!busy}>
              Delete channel
            </button>
          )}
        </div>
      </form>
    </div>
  );
}

function MusicField({ channel, onChange }: { channel: Channel; onChange: () => Promise<void> }) {
  const { busy, error, run } = useAction();
  const [presets, setPresets] = useState<Array<{ id: string; name: string; description: string }>>([]);
  const [selectedPreset, setSelectedPreset] = useState<string>("dark-mystery.mp3");
  const [playingPreset, setPlayingPreset] = useState<string | null>(null);

  useEffect(() => {
    api.musicPresets().then((list) => {
      setPresets(list);
      if (list.length > 0) setSelectedPreset(list[0].id);
    }).catch(() => {});
  }, []);

  const handleApplyPreset = () => {
    run("preset", async () => {
      await api.applyMusicPreset(channel.id, selectedPreset);
      await onChange();
    });
  };

  const togglePreview = (presetId: string) => {
    if (playingPreset === presetId) {
      setPlayingPreset(null);
    } else {
      setPlayingPreset(presetId);
    }
  };

  return (
    <Field
      label="Background music (optional)"
      hint="Plays quietly under the voice and ducks automatically when the narrator speaks."
    >
      <div className="space-y-3">
        {/* Currently selected track */}
        {channel.musicFile && (
          <div className="flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-white/[0.04] p-3 text-xs">
            <span className="font-medium text-emerald-300 flex items-center gap-1.5">
              🎵 Active: {channel.musicFile.name}
            </span>
            <button
              type="button"
              className="text-red-400 hover:text-red-300 font-medium"
              disabled={!!busy}
              onClick={() => run("remove", async () => { await api.deleteMusic(channel.id); await onChange(); })}
            >
              Remove
            </button>
          </div>
        )}

        {/* Standard Music Presets Selector */}
        {presets.length > 0 && (
          <div className="rounded-xl border border-white/10 bg-white/[0.02] p-3 space-y-2.5">
            <p className="text-xs font-semibold text-zinc-200">Standard Royalty-Free Music Library</p>
            <div className="flex flex-wrap items-center gap-2">
              <select
                value={selectedPreset}
                onChange={(e) => setSelectedPreset(e.target.value)}
                className="text-xs flex-1 min-w-[200px]"
              >
                {presets.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} — {p.description}
                  </option>
                ))}
              </select>

              <button
                type="button"
                className="btn-secondary text-xs py-1.5 px-3"
                onClick={() => togglePreview(selectedPreset)}
              >
                {playingPreset === selectedPreset ? "⏹ Stop" : "▶ Preview"}
              </button>

              <button
                type="button"
                className="btn-primary text-xs py-1.5 px-3"
                disabled={!!busy}
                onClick={handleApplyPreset}
              >
                {busy === "preset" ? <Spinner className="h-3 w-3" /> : "Use This Track"}
              </button>
            </div>

            {playingPreset && (
              <audio
                controls
                autoPlay
                src={api.musicPreviewUrl(playingPreset)}
                className="w-full h-8 mt-2"
                onEnded={() => setPlayingPreset(null)}
              />
            )}
          </div>
        )}

        {/* Custom file upload */}
        <div className="flex items-center gap-2">
          <label className="btn-secondary text-xs cursor-pointer">
            {busy === "upload" && <Spinner className="h-3 w-3" />}
            <span>Upload custom MP3 / WAV file</span>
            <input
              type="file"
              accept="audio/*"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (file) run("upload", async () => { await api.uploadMusic(channel.id, file); await onChange(); });
              }}
            />
          </label>
        </div>
      </div>
      <ErrorBox error={error} />
    </Field>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label>{label}</label>
      {children}
      {hint && <p className="text-xs text-zinc-500">{hint}</p>}
    </div>
  );
}
