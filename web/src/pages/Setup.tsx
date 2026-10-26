import { useEffect, useState, type ReactNode } from "react";
import { Check, Copy, X } from "lucide-react";
import { api, type PresetId, type SettingKey, type Settings, type Voice, type VoicePreset, type VoicePreview } from "../api";
import { useApp } from "../App";
import { ErrorBox, PageHeader, Spinner, useAction } from "../components/ui";

export default function Setup() {
  const { status, reloadStatus } = useApp();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [copied, setCopied] = useState(false);
  const [voiceUsage, setVoiceUsage] = useState<{ used: number; limit: number; resetsAt?: string } | null>(null);

  useEffect(() => {
    if (status.voice) api.voiceUsage().then(setVoiceUsage).catch(() => setVoiceUsage(null));
  }, [status.voice]);
  const { busy, error, setError, run } = useAction();

  useEffect(() => {
    api.settings().then(setSettings).catch((e) => setError(e.message));
  }, [setError]);

  const save = (key: SettingKey, value: string) =>
    run(key, async () => {
      setSettings(await api.saveSettings({ [key]: value }));
      await reloadStatus();
    });

  const field = (key: SettingKey, label: string, placeholder: string, secret = true) =>
    settings && (
      <KeyField
        key={key}
        label={label}
        placeholder={placeholder}
        secret={secret}
        current={settings[key]}
        busy={busy === key}
        onSave={(v) => save(key, v)}
      />
    );

  return (
    <div className="max-w-3xl space-y-5">
      <PageHeader
        title="Setup"
        subtitle="Connect the services the app uses. Follow the steps for each one, paste your key in the box and click Save. It works right away."
      />
      <ErrorBox error={error} onClose={() => setError(null)} />
      {!settings && !error && <Spinner className="h-6 w-6" />}

      <Section ok={status.ai} title="1. AI writing (Claude or Gemini)">
        <p className="text-xs text-zinc-300 mb-2">
          Used for generating viral ideas, research notes, multi-part series, scripts, and video metadata. You can use Anthropic Claude, or use your Google Gemini key (box 2a below) which powers AI writing automatically!
        </p>
        <ol className="list-decimal space-y-1.5 pl-5">
          <li>Go to <Ext href="https://console.anthropic.com">console.anthropic.com</Ext>, sign up and add a payment method under <b>Billing</b>.</li>
          <li>Open <b>API Keys</b>, click <b>Create Key</b> and copy it.</li>
        </ol>
        {field("ANTHROPIC_API_KEY", "Anthropic API key", "sk-ant-api03-…")}
        <p className="mt-2 text-xs text-zinc-400">Claude key is optional if you have Gemini (box 2a) configured.</p>
      </Section>

      <Section title="2. AI voiceover: choose one or more">
        <p>
          Each channel picks its voice engine under <b>Edit channel</b>. <b>Kokoro</b> is built in and free with no key, so you can
          make videos right away. Add Gemini or ElevenLabs below for more natural voices.
        </p>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-zinc-300">
          <li><b>Kokoro</b>: free, unlimited, runs on this computer. English only. The first use downloads the voice model (about 90 MB).</li>
          <li><b>Gemini</b>: very natural, and follows a style you describe. Also powers AI pictures and scripts!</li>
          <li><b>ElevenLabs</b>: the most human voice. Paid by characters per month.</li>
        </ul>
      </Section>

      <Section ok={status.gemini} title="2a. Gemini (Google AI Studio) — Voice, AI Pictures & Writing">
        <ol className="list-decimal space-y-1.5 pl-5">
          <li>Go to <Ext href="https://aistudio.google.com/apikey">aistudio.google.com/apikey</Ext> and sign in with your Google account.</li>
          <li>Click <b>Create API key</b> and copy it. (A Gemini app subscription doesn't include this; the key is separate and free to create.)</li>
          <li>For regular posting, turn on billing for the key in AI Studio. The free tier runs out after a few voice requests per day.</li>
        </ol>
        {field("GEMINI_API_KEY", "Gemini API key", "AQ.… or AIza…")}
        <p className="mt-2 text-xs text-zinc-400">Powers Gemini voiceover, Gemini AI Pictures for historical scenes, and AI script generation.</p>
      </Section>

      <Section ok={status.voice} title="2b. ElevenLabs voice (optional)">
        <ol className="list-decimal space-y-1.5 pl-5">
          <li>Sign up at <Ext href="https://elevenlabs.io">elevenlabs.io</Ext>. The free plan is enough to test; the Starter plan (about $5/month) covers several videos a week.</li>
          <li>Click your profile → <b>API Keys</b> → <b>Create API Key</b>. Allow <b>Text to Speech</b>, <b>Voices</b> (read and write) and <b>User</b> (read), plus <b>Text to Voice</b> if it's listed, then copy it. Write access and Text to Voice let the app design character voices for you.</li>
        </ol>
        {field("ELEVENLABS_API_KEY", "ElevenLabs API key", "sk_…")}
        {voiceUsage && voiceUsage.limit > 0 && (
          <div className="mt-3">
            <div className="mb-1 flex justify-between text-xs">
              <span>
                Voice characters this month: {voiceUsage.used.toLocaleString()} / {voiceUsage.limit.toLocaleString()}
              </span>
              {voiceUsage.resetsAt && <span className="text-zinc-500">Resets {new Date(voiceUsage.resetsAt).toLocaleDateString()}</span>}
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
              <div
                className={`h-full ${voiceUsage.used / voiceUsage.limit > 0.85 ? "bg-red-600" : "bg-green-600"}`}
                style={{ width: `${Math.min(100, (100 * voiceUsage.used) / voiceUsage.limit)}%` }}
              />
            </div>
            <p className="mt-1 text-xs text-zinc-500">
              A Short uses about 800 characters; a 10-minute video about 9,000. The free plan has 10,000 a month.
            </p>
          </div>
        )}
        <p className="mt-2 text-xs text-zinc-500">Then pick a narrator voice for each channel under Edit channel.</p>
      </Section>

      {status.voice && (
        <Section ok={true} title="2b+. Narration presets">
          <VoicePresetsEditor />
        </Section>
      )}

      <Section ok={status.hedra} title="2c. Talking characters (Hedra, optional)">
        <p className="mb-2">
          Makes a story's characters appear on screen and speak: their painted portrait is lip-synced to their ElevenLabs voice.
          About $0.05 per second of character speech (roughly $2-3 for a 15-minute episode). Without it, characters show as
          still portraits.
        </p>
        <ol className="list-decimal space-y-1.5 pl-5">
          <li>Sign up at <Ext href="https://www.hedra.com">hedra.com</Ext> and add credits or a plan that includes API access.</li>
          <li>Open your profile → <b>API</b> (or Settings → API Keys), create a key and copy it.</li>
        </ol>
        {field("HEDRA_API_KEY", "Hedra API key", "Paste your Hedra key")}
      </Section>

      <Section ok={status.extraAi} title="1b. Another AI for writing (optional, e.g. a free tier)">
        <p className="mb-2 text-xs text-zinc-300">
          Any service that speaks the OpenAI chat format works: Groq, OpenRouter (free models end in :free), Mistral, Together, Cerebras and others.
          It is used only when Claude and Gemini fail or aren't set up. Web research still needs Claude or Gemini. Free models write weaker scripts, so check them.
        </p>
        <ol className="list-decimal space-y-1.5 pl-5">
          <li>Get an API key from the service and copy its <b>base URL</b> (for example <code>https://api.groq.com/openai/v1</code> or <code>https://openrouter.ai/api/v1</code>).</li>
          <li>Copy the exact <b>model name</b> from the service's model list. Names change, so check it is current.</li>
        </ol>
        {field("EXTRA_AI_BASE_URL", "Base URL", "https://api.groq.com/openai/v1", false)}
        {field("EXTRA_AI_API_KEY", "API key", "Paste the key")}
        {field("EXTRA_AI_MODEL", "Model name", "Exact model name from the service", false)}
      </Section>

      <Section ok={status.pixabay} title="3b. Free pictures (Pixabay, optional)">
        <ol className="list-decimal space-y-1.5 pl-5">
          <li>Sign up free at <Ext href="https://pixabay.com/api/docs/">pixabay.com/api/docs</Ext> and copy your API key.</li>
        </ol>
        {field("PIXABAY_API_KEY", "Pixabay API key", "Paste your Pixabay key")}
        <p className="mt-2 text-xs text-zinc-500">
          Used by "Free pictures first" channels, after Pexels. Wikimedia Commons public-domain photos are also searched and need no key.
        </p>
      </Section>

      <Section ok={status.footage} title="3. Stock footage (Pexels, free)">
        <ol className="list-decimal space-y-1.5 pl-5">
          <li>Sign up free at <Ext href="https://www.pexels.com/api/">pexels.com/api</Ext>, click <b>Get Started</b>, and copy your API key.</li>
        </ol>
        {field("PEXELS_API_KEY", "Pexels API key", "Paste your Pexels key")}
        <p className="mt-2 text-xs text-zinc-500">Pexels videos and photos are free to use on YouTube, including monetized videos.</p>
      </Section>

      <Section ok={status.youtube} title="4. YouTube upload and stats (Google Cloud)">
        <ol className="list-decimal space-y-1.5 pl-5">
          <li>Go to <Ext href="https://console.cloud.google.com/projectcreate">Google Cloud Console</Ext> and create a project (free).</li>
          <li>
            Open <Ext href="https://console.cloud.google.com/apis/library/youtube.googleapis.com">YouTube Data API v3</Ext> and click <b>Enable</b>.
          </li>
          <li>
            Open <Ext href="https://console.cloud.google.com/auth/overview">Google Auth Platform</Ext>, click <b>Get started</b>, choose <b>External</b>, and under{" "}
            <b>Audience</b> add your own Google email as a <b>test user</b>.
          </li>
          <li>
            Under <b>Clients</b>, click <b>Create client</b>, choose <b>Web application</b>, and add this under <b>Authorized redirect URIs</b>:
            <div className="mt-2 flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded bg-zinc-100 px-2 py-1.5 dark:bg-zinc-800">{status.redirectUri}</code>
              <button
                className="btn-secondary"
                onClick={() => {
                  navigator.clipboard.writeText(status.redirectUri);
                  setCopied(true);
                }}
              >
                {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />} Copy
              </button>
            </div>
          </li>
          <li>Click <b>Create</b>. Google shows a <b>Client ID</b> and <b>Client secret</b>. Paste both below.</li>
          <li>Then open a channel in this app and click <b>Connect YouTube</b>.</li>
        </ol>
        {field("GOOGLE_CLIENT_ID", "Client ID", "123456789-abc.apps.googleusercontent.com", false)}
        {field("GOOGLE_CLIENT_SECRET", "Client secret", "GOCSPX-…")}
        <div className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          <b>Important:</b> until Google verifies your project (an “audit” you request in Google Cloud), videos uploaded through the API
          are locked as private and test-mode logins expire after 7 days. For your own channels you can request the audit, or
          reconnect weekly and publish from YouTube Studio in the meantime.
        </div>
      </Section>

      <Section ok={status.passwordRequired} title={status.online ? "5. Login password" : "5. Login password (optional)"} labels={["On", "Off"]}>
        {status.online ? (
          <p>
            The app is online, so it always needs a password (at least 10 characters). Changing it here logs out every other
            browser. It replaces the APP_PASSWORD you set on your host.
          </p>
        ) : (
          <p>
            On your own computer, only you can open the app, so a password is optional. Set one if other people use this computer,
            and always before putting the app online.
          </p>
        )}
        {field("APP_PASSWORD", "Password", "Choose a password")}
      </Section>

      <Section title="Advanced: app address">
        <p>
          Leave this empty: on your computer the app uses localhost, and on a server it uses the APP_URL set there (for example{" "}
          <code>https://planner.repairrange.io</code>). Fill it in only to override that. It changes the YouTube redirect address
          above.
        </p>
        {field("APP_URL", "App address", "http://localhost:3000", false)}
      </Section>

      <BackupSection />

      <Section title="Tools that pair well with this app">
        <ul className="space-y-1.5">
          <li><b>CapCut</b> (free): polish a video the app made (add music, effects), or edit your own. Export 1080p and upload it here.</li>
          <li><b>Canva</b> (free): thumbnails. Search “YouTube thumbnail” templates.</li>
          <li><b>vidIQ</b> (free extension): check keyword search volume before you pick an idea.</li>
          <li><b>OpusClip</b>: turn one long video into several Shorts, then add each as a Short here.</li>
        </ul>
      </Section>
    </div>
  );
}

function KeyField(props: {
  label: string;
  placeholder: string;
  secret: boolean;
  current: Settings[SettingKey];
  busy: boolean;
  onSave: (value: string) => Promise<unknown>;
}) {
  const [value, setValue] = useState("");
  const [editing, setEditing] = useState(false);
  const saved = props.current.set;
  const showInput = !saved || editing;

  const submit = async () => {
    await props.onSave(value);
    setValue("");
    setEditing(false);
  };

  return (
    <div className="mt-4 rounded-lg bg-zinc-50 p-3 dark:bg-zinc-800/50">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium">{props.label}</span>
        {saved && (
          <span className="flex items-center gap-1 text-xs text-green-700 dark:text-green-400">
            <Check className="h-3.5 w-3.5" />
            Saved {props.current.value ? `(${props.current.value})` : props.current.hint ? `(ends in ${props.current.hint})` : ""}
          </span>
        )}
      </div>
      {showInput ? (
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <input
            className="min-w-0 flex-1"
            type={props.secret ? "password" : "text"}
            autoComplete="off"
            spellCheck={false}
            placeholder={props.placeholder}
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
          <button className="btn-primary" disabled={props.busy || !value.trim()}>
            {props.busy && <Spinner />} Save
          </button>
          {editing && (
            <button type="button" className="btn-ghost" onClick={() => setEditing(false)}>
              Cancel
            </button>
          )}
        </form>
      ) : (
        <div className="flex gap-2">
          <button className="btn-secondary" onClick={() => setEditing(true)}>
            Change
          </button>
          <button
            className="btn-ghost text-red-600"
            disabled={props.busy}
            onClick={() => {
              if (confirm(`Remove the saved ${props.label}?`)) props.onSave("");
            }}
          >
            Remove
          </button>
        </div>
      )}
    </div>
  );
}

function Section({ ok, title, labels = ["Key saved", "Not set up"], children }: { ok?: boolean; title: string; labels?: [string, string]; children: ReactNode }) {
  return (
    <section className="card text-sm">
      <h2 className="mb-3 flex items-center gap-2 text-base font-semibold">
        {ok === undefined ? null : ok ? (
          <span className="flex h-5 w-5 items-center justify-center rounded-full bg-green-600 text-white"><Check className="h-3 w-3" /></span>
        ) : (
          <span className="flex h-5 w-5 items-center justify-center rounded-full bg-zinc-300 text-white dark:bg-zinc-700"><X className="h-3 w-3" /></span>
        )}
        {title}
        {ok !== undefined && <span className={`text-xs font-normal ${ok ? "text-green-600" : "text-zinc-500"}`}>{ok ? labels[0] : labels[1]}</span>}
      </h2>
      {children}
    </section>
  );
}

const Ext = ({ href, children }: { href: string; children: ReactNode }) => (
  <a href={href} target="_blank" rel="noreferrer" className="text-red-600 underline">
    {children}
  </a>
);

const PRESET_ORDER: PresetId[] = ["documentary_narration", "dramatic_reveal", "fast_short"];

function Slider(props: { label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void; unit?: string }) {
  return (
    <label className="block text-xs">
      <span className="flex justify-between">
        <span>{props.label}</span>
        <span className="tabular-nums text-zinc-500">{props.value}{props.unit ?? ""}</span>
      </span>
      <input type="range" className="w-full" min={props.min} max={props.max} step={props.step} value={props.value} onChange={(e) => props.onChange(Number(e.target.value))} />
    </label>
  );
}

/** Tune how the narrator sounds: three presets, each previewed with a 20-second sample. */
function VoicePresetsEditor() {
  const [presets, setPresets] = useState<Record<PresetId, VoicePreset> | null>(null);
  const [defaults, setDefaults] = useState<Record<PresetId, VoicePreset> | null>(null);
  const [voices, setVoices] = useState<Voice[]>([]);
  const [voiceId, setVoiceId] = useState("");
  const [stats, setStats] = useState<Record<string, VoicePreview>>({});
  const { busy, error, setError, run } = useAction();

  useEffect(() => {
    api.voicePresets().then((r) => { setPresets(r.presets); setDefaults(r.defaults); }).catch((e) => setError(e.message));
    api.voices("elevenlabs").then(setVoices).catch(() => setVoices([]));
  }, [setError]);

  if (!presets || !defaults) return <ErrorBox error={error} />;
  const patch = (id: PresetId, change: Partial<VoicePreset>) => setPresets({ ...presets, [id]: { ...presets[id], ...change } });
  const save = () => run("save", async () => { const r = await api.saveVoicePresets(presets); setPresets(r.presets); });
  const reset = () => run("reset", async () => { const r = await api.saveVoicePresets({}); setPresets(r.presets); setStats({}); });
  const hear = (id: PresetId) =>
    run(`hear-${id}`, async () => {
      await api.saveVoicePresets(presets);
      const p = await api.previewVoiceDetailed({ engine: "elevenlabs", voiceId: voiceId || undefined, preset: id });
      setStats((s) => ({ ...s, [id]: p }));
      new Audio(p.url).play().catch(() => undefined);
    });

  return (
    <div className="space-y-4">
      <p className="text-xs text-zinc-500">
        These starting values are untuned. Press Hear it, listen, adjust, and save. Target pace is about 150-170 words/min for documentaries and 170-190 for Shorts.
      </p>
      <select className="w-full" value={voiceId} onChange={(e) => setVoiceId(e.target.value)}>
        <option value="">Preview voice: default</option>
        {voices.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
      </select>
      {PRESET_ORDER.map((id) => {
        const p = presets[id];
        const st = stats[id];
        return (
          <div key={id} className="card space-y-2 p-3">
            <div className="font-medium">{p.label}</div>
            <p className="text-xs text-zinc-500">{p.description}</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <Slider label="Stability (lower = more expressive)" value={p.stability} min={0} max={1} step={0.05} onChange={(v) => patch(id, { stability: v })} />
              <Slider label="Style exaggeration" value={p.style} min={0} max={1} step={0.05} onChange={(v) => patch(id, { style: v })} />
              <Slider label="Speed" value={p.speed} min={0.7} max={1.2} step={0.01} onChange={(v) => patch(id, { speed: v })} unit="×" />
              <Slider label="Extra tempo after render" value={p.tempo} min={1} max={1.08} step={0.01} onChange={(v) => patch(id, { tempo: v })} unit="×" />
              <Slider label="Shortest gap between sentences" value={p.gapMs[0]} min={0} max={800} step={10} onChange={(v) => patch(id, { gapMs: [v, Math.max(v, p.gapMs[1])] })} unit=" ms" />
              <Slider label="Longest gap between sentences" value={p.gapMs[1]} min={0} max={1200} step={10} onChange={(v) => patch(id, { gapMs: [Math.min(v, p.gapMs[0]), v] })} unit=" ms" />
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <button type="button" className="btn-secondary" disabled={!!busy} onClick={() => hear(id)}>
                {busy === `hear-${id}` && <Spinner />} Save and hear it
              </button>
              {st && <span className="text-xs text-zinc-500">{st.duration?.toFixed(1)} s · {st.wpm} words/min · {st.lufs?.toFixed(1)} LUFS</span>}
            </div>
          </div>
        );
      })}
      <div className="flex gap-2">
        <button type="button" className="btn-secondary" disabled={!!busy} onClick={save}>{busy === "save" && <Spinner />} Save presets</button>
        <button type="button" className="btn-secondary" disabled={!!busy} onClick={reset}>Reset to defaults</button>
      </div>
      <ErrorBox error={error} />
    </div>
  );
}

/** Download everything as one file, or load such a file: used to move the app to another server. */
function BackupSection() {
  const [file, setFile] = useState<File | null>(null);
  const [done, setDone] = useState(false);
  const { busy, error, run } = useAction();
  return (
    <Section title="Backup and move">
      <p>
        Download one file with all your channels, videos, settings and keys. Load it into Channel Planner on another server to
        move everything there. Keep the file private: it contains your keys.
      </p>
      <a className="btn-secondary mt-3 inline-flex" href="/api/backup" download>
        Download backup
      </a>
      <div className="mt-4 space-y-2 border-t border-zinc-200 pt-4 dark:border-zinc-800">
        <p>
          <b>Restore:</b> replaces everything in this copy of the app with the backup, then the app restarts (about a minute).
        </p>
        <input type="file" accept=".gz,application/gzip" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        <button
          className="btn-primary"
          disabled={!file || !!busy || done}
          onClick={() => {
            if (!file || !confirm("Replace all channels, videos and settings in this app with the backup?")) return;
            run("restore", async () => {
              await api.restore(file);
              setDone(true);
            });
          }}
        >
          {busy && <Spinner />} Restore backup
        </button>
        {busy && <p className="text-xs text-zinc-500">Uploading… Large backups with many videos take a while; keep this page open.</p>}
        {done && <p className="text-green-600">Restored. The app is restarting: wait a minute, then reload this page and log in.</p>}
        <ErrorBox error={error} />
      </div>
    </Section>
  );
}
