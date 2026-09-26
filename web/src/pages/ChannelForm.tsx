import { useState } from "react";
import { api, CATEGORIES, DAY_NAMES, type Channel } from "../api";
import { navigate, useApp } from "../App";
import { ErrorBox, PageHeader, Spinner, useAction } from "../components/ui";

const EMPTY = {
  name: "",
  niche: "",
  audience: "",
  tone: "",
  language: "English",
  postingDays: [1, 3, 5],
  postingTime: "17:00",
  categoryId: "22",
};

const EXAMPLES = [
  { name: "Phone Repair Shop", niche: "Phone and tablet repairs: screen, battery and water-damage fixes filmed in my shop", audience: "People with broken phones and DIY fixers", categoryId: "28" },
  { name: "Phone Tips", niche: "Hidden phone settings, battery tips, fixing slow phones, budget phone buying guides", audience: "Everyday smartphone users", categoryId: "28" },
];

export default function ChannelForm({ channelId }: { channelId?: string }) {
  const { channels, reloadChannels } = useApp();
  const existing = channels.find((c) => c.id === channelId);
  const [form, setForm] = useState<Omit<Channel, "id" | "createdAt" | "youtube" | "stats">>(
    existing ? { ...EMPTY, ...existing } : EMPTY,
  );
  const { busy, error, run } = useAction();

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
          <span className="muted">Start from an example:</span>
          {EXAMPLES.map((ex) => (
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

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label>{label}</label>
      {children}
      {hint && <p className="text-xs text-zinc-500">{hint}</p>}
    </div>
  );
}
