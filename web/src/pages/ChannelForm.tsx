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
  const defaultEngine: VoiceEngine = status.voice ? "elevenlabs" : status.gemini ? "gemini" : "kokoro";
  const engine = form.voiceEngine ?? defaultEngine;
  const engineReady = engine === "kokoro" || (engine === "gemini" ? status.gemini : status.voice);

  useEffect(() => {
    setVoices([]);
    if (engineReady) api.voices(engine).then(setVoices).catch(() => {});
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
          <Field label="Narration style" hint="Describe how the narrator should sound. Gemini follows it; the other engines ignore it.">
            <input
              value={form.voiceStyle ?? ""}
              onChange={(e) => set("voiceStyle", e.target.value)}
              placeholder="e.g. Narrate slowly and suspensefully, like a documentary narrator"
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
  return (
    <Field
      label="Background music (optional)"
      hint="Plays quietly under the voice and gets softer while the narrator speaks. Use royalty-free music only: YouTube Studio → Audio Library, or pixabay.com/music."
    >
      <div className="flex flex-wrap items-center gap-2">
        {channel.musicFile && <span className="text-sm">🎵 {channel.musicFile.name}</span>}
        <label className="btn-secondary cursor-pointer">
          {busy === "upload" && <Spinner />}
          {channel.musicFile ? "Replace" : "Upload music"}
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
        {channel.musicFile && (
          <button type="button" className="btn-ghost text-red-600" disabled={!!busy} onClick={() => run("remove", async () => { await api.deleteMusic(channel.id); await onChange(); })}>
            Remove
          </button>
        )}
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
