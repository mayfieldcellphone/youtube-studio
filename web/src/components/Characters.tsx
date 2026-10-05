import { useEffect, useRef, useState } from "react";
import { ImageIcon, Play, Plus, RefreshCw, Sparkles, Trash2, UserRound, X } from "lucide-react";
import { api, type DesignedVoice, type SuggestedCharacter, type Video, type Voice } from "../api";
import { ErrorBox, Spinner, useAction } from "./ui";

/** A character being set up: a suggestion or a manual one, before it is saved. */
interface Draft {
  key: string;
  name: string;
  role: string;
  description: string;
  appearance: string;
  sampleLine: string;
  previews: DesignedVoice[];
  /** A preview's generatedVoiceId, or "voice:<id>" for an existing ElevenLabs voice */
  choice: string;
  designing: boolean;
  error?: string;
}

const newKey = () => Math.random().toString(36).slice(2);
const fromSuggestion = (c: SuggestedCharacter): Draft => ({
  key: newKey(),
  name: c.name,
  role: c.role,
  description: c.voiceDescription,
  appearance: c.appearance,
  sampleLine: c.sampleLine,
  previews: [],
  choice: "",
  designing: false,
});

const suggestedFlag = (id: string) => `cast-suggested:${id}`;
export const remembered = (id: string) => {
  try {
    return localStorage.getItem(suggestedFlag(id)) === "1";
  } catch {
    return false;
  }
};
export const remember = (id: string) => {
  try {
    localStorage.setItem(suggestedFlag(id), "1");
  } catch {}
};

/**
 * Who speaks in this story's dramatised scenes. The AI proposes characters with a voice
 * description, ElevenLabs Voice Design makes sample voices for each, and nothing is created
 * in ElevenLabs or saved until the user approves.
 */
export function Characters({
  video,
  ready,
  aiReady,
  picturesReady = false,
  talking = false,
  suggestRequest = 0,
  onSaved,
}: {
  video: Video;
  /** ElevenLabs key is set */
  ready: boolean;
  aiReady: boolean;
  /** Gemini key set: portraits can be painted */
  picturesReady?: boolean;
  /** Hedra key set: portraits talk */
  talking?: boolean;
  /** Increase to ask for suggestions now (e.g. from the script step) */
  suggestRequest?: number;
  onSaved: (video: Video) => void;
}) {
  const cast = video.cast ?? [];
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [voices, setVoices] = useState<Voice[]>([]);
  const [voicesError, setVoicesError] = useState<string | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const [painting, setPainting] = useState<string | null>(null);
  const { busy, error, setError, run } = useAction();
  const audio = useRef<HTMLAudioElement | null>(null);

  const loadVoices = () =>
    api
      .voices("elevenlabs")
      .then((list) => {
        setVoices(list);
        setVoicesError(list.length ? null : "Your ElevenLabs account returned no voices.");
      })
      .catch((e: Error) => setVoicesError(e.message));

  useEffect(() => {
    if (ready) loadVoices();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  const update = (key: string, patch: Partial<Draft>) => setDrafts((list) => list.map((d) => (d.key === key ? { ...d, ...patch } : d)));

  const design = async (draft: Draft) => {
    update(draft.key, { designing: true, error: undefined });
    try {
      const { previews } = await api.designVoice(draft.description, draft.sampleLine || draft.role);
      update(draft.key, { designing: false, previews, choice: previews[0]?.generatedVoiceId ?? "" });
    } catch (e) {
      update(draft.key, { designing: false, error: (e as Error).message });
    }
  };

  /** Asks the AI for characters, then designs voices for all of them so they can be heard right away. */
  const suggest = () =>
    run("suggest", async () => {
      remember(video.id);
      const { characters } = await api.suggestCast(video.id);
      const taken = new Set(cast.map((c) => c.name.toUpperCase()));
      const fresh = characters.filter((c) => !taken.has(c.name.toUpperCase())).map(fromSuggestion);
      if (!fresh.length) throw new Error("The AI didn't find new speaking characters in this story. Add one yourself.");
      setDrafts(fresh);
      await Promise.all(fresh.map(design));
    });

  useEffect(() => {
    if (suggestRequest > 0 && ready && aiReady) suggest();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [suggestRequest]);

  // First visit to a researched story without characters: suggest them once, automatically.
  useEffect(() => {
    if (ready && aiReady && video.research && !cast.length && !remembered(video.id)) suggest();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [video.id, ready, aiReady, Boolean(video.research)]);

  const play = (id: string, url: string) => {
    audio.current?.pause();
    if (playing === id) return setPlaying(null);
    const a = new Audio(url);
    a.onended = () => setPlaying(null);
    audio.current = a;
    setPlaying(id);
    a.play().catch(() => setPlaying(null));
  };

  const playSaved = (voiceId: string) =>
    run(`play-${voiceId}`, async () => play(voiceId, await api.previewVoice({ engine: "elevenlabs", voiceId })));

  const orientation = video.format === "short" ? "portrait" : "landscape";
  const hasPortrait = (c: { portraits?: { landscape: boolean; portrait: boolean } }) => Boolean(c.portraits?.[orientation]);

  /** Paints portraits one by one, updating the page after each. */
  const paint = async (names: string[], regenerate = false) => {
    for (const name of names) {
      setPainting(name);
      try {
        onSaved(await api.paintPortrait(video.id, name, regenerate));
      } finally {
        setPainting(null);
      }
    }
  };

  const save = (keep = cast) =>
    run("save", async () => {
      const incomplete = drafts.find((d) => !d.name.trim() || !d.choice);
      if (incomplete) throw new Error(`Choose a voice for ${incomplete.name || "every character"} first, or remove it.`);
      const characters = [
        ...keep.map((c) => ({ name: c.name, role: c.role, description: c.description, appearance: c.appearance, voiceId: c.voiceId })),
        ...drafts.map((d) => ({
          name: d.name.trim(),
          role: d.role.trim(),
          description: d.description.trim(),
          appearance: d.appearance.trim(),
          ...(d.choice.startsWith("voice:") ? { voiceId: d.choice.slice(6) } : { generatedVoiceId: d.choice }),
        })),
      ];
      const saved = await api.saveCast(video.id, characters);
      onSaved(saved);
      setDrafts([]);
      // Newly designed voices now exist in the account; show their names.
      loadVoices();
      // Paint the new characters' portraits straight away so they can be checked.
      if (picturesReady) await paint((saved.cast ?? []).filter((c) => !hasPortrait(c)).map((c) => c.name));
    });

  const newVoices = drafts.filter((d) => d.choice && !d.choice.startsWith("voice:")).length;
  const voiceName = (id: string) => voices.find((v) => v.id === id)?.name ?? "ElevenLabs voice";

  if (!ready) {
    return (
      <p className="text-sm text-zinc-400">
        Let people from the story speak in their own voices. Add your ElevenLabs key on the{" "}
        <a className="underline" href="#/setup">
          Setup
        </a>{" "}
        page to use characters.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <ErrorBox error={error} onClose={() => setError(null)} />

      {cast.length > 0 && (
        <ul className="space-y-2">
          {cast.map((c) => (
            <li key={c.name} className="flex flex-wrap items-center gap-3 rounded-lg border border-white/10 p-3">
              {hasPortrait(c) ? (
                <a href={api.portraitUrl(video, c.name)} target="_blank" rel="noreferrer" title="Open the portrait">
                  <img
                    src={api.portraitUrl(video, c.name)}
                    alt={`Portrait of ${c.name}`}
                    className={`shrink-0 rounded-md object-cover ${orientation === "portrait" ? "h-20 w-12" : "h-14 w-24"}`}
                  />
                </a>
              ) : painting === c.name ? (
                <Spinner className="h-5 w-5" />
              ) : (
                <UserRound className="h-5 w-5 shrink-0 text-pink-400" />
              )}
              <div className="min-w-0 flex-1">
                <p className="font-medium">
                  {c.name.toUpperCase()} <span className="text-xs font-normal text-zinc-400">· {voiceName(c.voiceId)}</span>
                </p>
                {c.role && <p className="text-xs text-zinc-400">{c.role}</p>}
                {c.appearance && <p className="text-xs text-zinc-500">Look: {c.appearance}</p>}
              </div>
              {picturesReady && (
                <button
                  type="button"
                  className="btn-ghost"
                  disabled={!!busy || !!painting}
                  title="Paint a new portrait. To change how they look, use Change look."
                  onClick={() => run(`paint-${c.name}`, () => paint([c.name], hasPortrait(c)))}
                >
                  {painting === c.name ? <Spinner /> : <ImageIcon className="h-4 w-4" />}
                  {painting === c.name ? "Painting…" : hasPortrait(c) ? "New portrait" : "Paint portrait"}
                </button>
              )}
              <button
                type="button"
                className="btn-ghost"
                disabled={!!busy || !!painting}
                onClick={() => {
                  const look = prompt(`How should ${c.name} look? Age, face, hair, clothing and era.`, c.appearance ?? "");
                  if (look === null || look.trim() === (c.appearance ?? "")) return;
                  run(`look-${c.name}`, async () => {
                    const updated = cast.map((x) => (x.name === c.name ? { ...x, appearance: look.trim() } : x));
                    onSaved(
                      await api.saveCast(
                        video.id,
                        updated.map((x) => ({ name: x.name, role: x.role, description: x.description, appearance: x.appearance, voiceId: x.voiceId })),
                      ),
                    );
                    if (picturesReady) await paint([c.name]);
                  });
                }}
              >
                Change look
              </button>
              <button type="button" className="btn-secondary" disabled={!!busy} onClick={() => playSaved(c.voiceId)}>
                {busy === `play-${c.voiceId}` ? <Spinner /> : <Play className="h-4 w-4" />} {playing === c.voiceId ? "Stop" : "Listen"}
              </button>
              <button
                type="button"
                className="btn-ghost text-red-500"
                aria-label={`Remove ${c.name}`}
                disabled={!!busy}
                onClick={() => {
                  if (confirm(`Remove ${c.name} from this story? Their lines will be read by the narrator. The voice stays in your ElevenLabs account.`))
                    save(cast.filter((x) => x.name !== c.name));
                }}
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
      )}

      {drafts.length > 0 && (
        <div className="space-y-3">
          <p className="text-sm text-zinc-300">
            Review the characters below. Listen to each voice and pick one, change anything you like, then save. Nothing is created
            in ElevenLabs until you save.
          </p>
          {drafts.map((d) => (
            <div key={d.key} className="space-y-3 rounded-lg border border-pink-500/30 bg-pink-500/[0.04] p-4">
              <div className="flex flex-wrap gap-2">
                <input
                  className="w-40 font-semibold uppercase"
                  value={d.name}
                  maxLength={40}
                  placeholder="NAME"
                  aria-label="Character name"
                  onChange={(e) => update(d.key, { name: e.target.value.toUpperCase() })}
                />
                <input
                  className="min-w-0 flex-1"
                  value={d.role}
                  placeholder="Who they are, e.g. Joan of Arc, 19, on trial in 1431"
                  aria-label="Role"
                  onChange={(e) => update(d.key, { role: e.target.value })}
                />
                <button
                  type="button"
                  className="btn-ghost"
                  aria-label={`Remove ${d.name || "character"}`}
                  onClick={() => setDrafts((list) => list.filter((x) => x.key !== d.key))}
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <textarea
                rows={2}
                value={d.description}
                placeholder="How the voice sounds: gender, age, accent, pace, tone"
                aria-label="Voice description"
                onChange={(e) => update(d.key, { description: e.target.value })}
              />
              <textarea
                rows={2}
                value={d.appearance}
                placeholder="How they look, for their portrait: age, face, hair, clothing, era"
                aria-label="Appearance"
                onChange={(e) => update(d.key, { appearance: e.target.value })}
              />
              <input
                value={d.sampleLine}
                placeholder="A line to hear the voice with"
                aria-label="Sample line"
                onChange={(e) => update(d.key, { sampleLine: e.target.value })}
              />

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={d.designing || d.description.trim().length < 20}
                  onClick={() => design(d)}
                >
                  {d.designing ? <Spinner /> : d.previews.length ? <RefreshCw className="h-4 w-4" /> : <Sparkles className="h-4 w-4" />}
                  {d.designing ? "Designing voices…" : d.previews.length ? "New voices" : "Design voices"}
                </button>
                {d.previews.map((p, i) => (
                  <label
                    key={p.generatedVoiceId}
                    className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-1.5 text-sm ${
                      d.choice === p.generatedVoiceId ? "border-pink-500 bg-pink-500/10" : "border-white/10"
                    }`}
                  >
                    <input
                      type="radio"
                      name={`voice-${d.key}`}
                      className="w-auto"
                      checked={d.choice === p.generatedVoiceId}
                      onChange={() => update(d.key, { choice: p.generatedVoiceId })}
                    />
                    Voice {i + 1}
                    <button
                      type="button"
                      className="btn-ghost px-1 py-0"
                      aria-label={`Play voice ${i + 1}`}
                      onClick={(e) => {
                        e.preventDefault();
                        play(p.generatedVoiceId, p.audio);
                      }}
                    >
                      <Play className="h-4 w-4" />
                    </button>
                  </label>
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="text-zinc-400">or use a voice you already have:</span>
                <select
                  className="w-auto min-w-0 flex-1"
                  value={d.choice.startsWith("voice:") ? d.choice : ""}
                  onChange={(e) => update(d.key, { choice: e.target.value })}
                >
                  <option value="">Choose…</option>
                  {voices.map((v) => (
                    <option key={v.id} value={`voice:${v.id}`}>
                      {v.name}
                      {v.description ? ` (${v.description})` : ""}
                    </option>
                  ))}
                </select>
                {d.choice.startsWith("voice:") && (
                  <button type="button" className="btn-ghost" disabled={!!busy} onClick={() => playSaved(d.choice.slice(6))}>
                    {busy === `play-${d.choice.slice(6)}` ? <Spinner /> : <Play className="h-4 w-4" />} Listen
                  </button>
                )}
              </div>
              {d.error && <p className="text-sm text-red-400">{d.error}</p>}
            </div>
          ))}
          {voicesError && <p className="text-xs text-amber-400">Couldn't load your ElevenLabs voices: {voicesError}</p>}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {drafts.length > 0 ? (
          <>
            <button type="button" className="btn-primary" disabled={!!busy || drafts.some((d) => d.designing)} onClick={() => save()}>
              {busy === "save" && <Spinner />}
              Save characters{newVoices ? ` (creates ${newVoices} voice${newVoices > 1 ? "s" : ""} in ElevenLabs)` : ""}
            </button>
            <button type="button" className="btn-ghost" disabled={!!busy} onClick={() => setDrafts([])}>
              Cancel
            </button>
          </>
        ) : (
          <>
            {aiReady && (
              <button type="button" className="btn-secondary" disabled={!!busy} onClick={suggest}>
                {busy === "suggest" ? <Spinner /> : <Sparkles className="h-4 w-4" />}
                {busy === "suggest" ? "Finding characters and designing voices…" : cast.length ? "Suggest more characters" : "Suggest characters"}
              </button>
            )}
            <button
              type="button"
              className="btn-ghost"
              disabled={!!busy}
              onClick={() =>
                setDrafts([{ key: newKey(), name: "", role: "", description: "", appearance: "", sampleLine: "", previews: [], choice: "", designing: false }])
              }
            >
              <Plus className="h-4 w-4" /> Add a character
            </button>
          </>
        )}
      </div>
      <p className="text-xs text-zinc-500">
        {cast.length
          ? `The AI writer gives these characters short lines in the script (e.g. JOAN: [firm] I deny it entirely.). In the video they ${
              talking
                ? "appear as their portrait, lip-synced to their voice (Hedra, about $0.05 per second)"
                : picturesReady
                  ? "appear as their portrait while they speak. Add a Hedra key on the Setup page to make the portraits talk"
                  : "speak over normal footage. Add a Gemini key to show their portraits"
            }. Rewrite the script after changing characters.`
          : "Optional. Characters speak short dramatised lines between the narrator's, in their own voices. Designing voices uses some of your ElevenLabs credits."}
      </p>
    </div>
  );
}
