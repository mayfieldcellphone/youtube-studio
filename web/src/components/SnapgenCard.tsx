import { useEffect, useState } from "react";
import { Check, X } from "lucide-react";
import { ErrorBox, Spinner, useAction } from "./ui";

type Entry = { set?: boolean; value?: string; hint?: string } | undefined;
type SettingsReply = Record<string, Entry>;

async function call(method: "GET" | "PUT", body?: unknown): Promise<SettingsReply> {
  const res = await fetch("/api/settings", {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data;
}

const MODELS: [string, string][] = [
  ["", "Automatic (matches each channel's quality setting)"],
  ["veo-3.1-lite", "Veo 3.1 Lite (cheapest)"],
  ["veo-3.1-fast", "Veo 3.1 Fast"],
  ["veo-3.1", "Veo 3.1 (best quality)"],
  ["veo-2", "Veo 2"],
];

/** Your own SnapGen (snapgen.ai) key for AI video clips; Gemini Veo stays as the backup. */
export default function SnapgenCard() {
  const [settings, setSettings] = useState<SettingsReply | null>(null);
  const [value, setValue] = useState("");
  const [editing, setEditing] = useState(false);
  const { busy, error, setError, run } = useAction();

  useEffect(() => {
    call("GET")
      .then(setSettings)
      .catch((e) => setError(e.message));
  }, [setError]);

  const save = (values: Record<string, string>) =>
    run("save", async () => {
      setSettings(await call("PUT", values));
      setValue("");
      setEditing(false);
    });

  const key = settings?.SNAPGEN_API_KEY;
  const saved = Boolean(key?.set);
  const showInput = !saved || editing;

  return (
    <section className="card text-sm">
      <h2 className="mb-3 flex items-center gap-2 text-base font-semibold">
        {saved ? (
          <span className="flex h-5 w-5 items-center justify-center rounded-full bg-green-600 text-white">
            <Check className="h-3 w-3" />
          </span>
        ) : (
          <span className="flex h-5 w-5 items-center justify-center rounded-full bg-zinc-300 text-white dark:bg-zinc-700">
            <X className="h-3 w-3" />
          </span>
        )}
        2a+. AI video (SnapGen, your own key)
        <span className={`text-xs font-normal ${saved ? "text-green-600" : "text-zinc-500"}`}>{saved ? "Key saved" : "Not set up"}</span>
      </h2>
      <p className="mb-3 text-xs text-zinc-400">
        With a SnapGen key saved, every AI shot is made by SnapGen first. If SnapGen fails on a shot (an error or no credits left), that
        shot is made with Veo through your Gemini key instead, and if that fails too it uses stock footage. The monthly dollar budget
        below only counts the Gemini backup. Set that budget to 0 to switch AI footage off completely.
      </p>
      <ol className="list-decimal space-y-1.5 pl-5">
        <li>
          Sign in at{" "}
          <a href="https://snapgen.ai" target="_blank" rel="noreferrer" className="text-red-600 underline">
            snapgen.ai
          </a>{" "}
          and make sure your account has credits.
        </li>
        <li>
          Open <b>Service Integration</b> (see the{" "}
          <a href="https://docs.snapgen.ai/getting-started/authentication" target="_blank" rel="noreferrer" className="text-red-600 underline">
            SnapGen docs
          </a>
          ), create an API key and copy it.
        </li>
      </ol>

      {!settings && !error && <Spinner />}
      {settings && (
        <>
          <div className="mt-4 rounded-lg bg-zinc-50 p-3 dark:bg-zinc-800/50">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium">SnapGen API key</span>
              {saved && (
                <span className="flex items-center gap-1 text-xs text-green-700 dark:text-green-400">
                  <Check className="h-3.5 w-3.5" />
                  Saved {key?.hint ? `(ends in ${key.hint})` : ""}
                </span>
              )}
            </div>
            {showInput ? (
              <form
                className="flex flex-wrap gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  save({ SNAPGEN_API_KEY: value });
                }}
              >
                <input
                  className="min-w-0 flex-1"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="Paste your SnapGen key"
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                />
                <button className="btn-primary" disabled={busy === "save" || !value.trim()}>
                  {busy === "save" && <Spinner />} Save
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
                  disabled={busy === "save"}
                  onClick={() => {
                    if (confirm("Remove the saved SnapGen key? AI shots will use Gemini Veo only.")) save({ SNAPGEN_API_KEY: "" });
                  }}
                >
                  Remove
                </button>
              </div>
            )}
          </div>

          {saved && (
            <div className="mt-3 rounded-lg bg-zinc-50 p-3 dark:bg-zinc-800/50">
              <label className="mb-2 block font-medium" htmlFor="snapgen-model">
                SnapGen video model
              </label>
              <select
                id="snapgen-model"
                className="w-full"
                value={settings.SNAPGEN_MODEL?.value ?? ""}
                disabled={busy === "save"}
                onChange={(e) => save({ SNAPGEN_MODEL: e.target.value })}
              >
                {MODELS.map(([id, label]) => (
                  <option key={id} value={id}>
                    {label}
                  </option>
                ))}
              </select>
              <p className="mt-2 text-xs text-zinc-500">
                Automatic uses the best model for the hook and key moments and the cheapest for filler shots. Pick one model here to use it for every shot.
              </p>
            </div>
          )}
        </>
      )}
      <ErrorBox error={error} onClose={() => setError(null)} />
    </section>
  );
}
