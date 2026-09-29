import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, BookOpen, CalendarClock, Check, ExternalLink, Film, Image, Sparkles, Trash2, Upload, Wand2 } from "lucide-react";
import {
  aiFootageEstimate,
  picturesEstimate,
  api,
  compact,
  fileSize,
  formatDateTime,
  nextSlot,
  STATUS_LABELS,
  toLocalInput,
  type Video,
  type VideoStatus,
} from "../api";
import { navigate, useApp } from "../App";
import { ErrorBox, FormatBadge, Spinner, useAction } from "../components/ui";

type Draft = Pick<Video, "title" | "hook" | "angle" | "keyword" | "script" | "description"> & { tags: string };

const toDraft = (v: Video): Draft => ({
  title: v.title,
  hook: v.hook,
  angle: v.angle,
  keyword: v.keyword,
  script: v.script,
  description: v.description,
  tags: v.tags.join(", "),
});

export default function VideoEditor({ videoId }: { videoId: string }) {
  const { channels, status } = useApp();
  const [video, setVideo] = useState<Video | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [allVideos, setAllVideos] = useState<Video[]>([]);
  const [when, setWhen] = useState("");
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [publishing, setPublishing] = useState(false);
  const { busy, error, setError, run } = useAction();

  const apply = useCallback((v: Video) => {
    setVideo(v);
    setDraft(toDraft(v));
  }, []);

  useEffect(() => {
    Promise.all([api.video(videoId), api.videos(), api.uploading()])
      .then(([v, all, uploading]) => {
        apply(v);
        setAllVideos(all);
        setPublishing(uploading.includes(v.id));
      })
      .catch((e) => setError(e.message));
  }, [videoId, apply, setError]);

  const channel = channels.find((c) => c.id === video?.channelId);

  // Suggest the channel's next free posting slot.
  useEffect(() => {
    if (!video || !channel || when) return;
    const others = allVideos.filter((v) => v.id !== video.id);
    setWhen(toLocalInput(video.scheduledAt && !video.youtubeVideoId ? new Date(video.scheduledAt) : nextSlot(channel, others)));
  }, [video, channel, allVideos, when]);

  // While the video maker runs in the background, poll its progress.
  const renderRunning = Boolean(video?.render && !video.render.finishedAt);
  const automated = Boolean(video?.pipeline && !video.pipeline.finishedAt);
  useEffect(() => {
    if (!renderRunning && !automated) return;
    const timer = setInterval(async () => {
      try {
        apply(await api.video(videoId));
      } catch {}
    }, 2000);
    return () => clearInterval(timer);
  }, [renderRunning, automated, videoId, apply]);

  // While YouTube upload runs in the background, poll until it finishes.
  useEffect(() => {
    if (!publishing) return;
    const timer = setInterval(async () => {
      const [v, uploading] = await Promise.all([api.video(videoId), api.uploading()]);
      if (!uploading.includes(videoId)) {
        setPublishing(false);
        apply(v);
      }
    }, 3000);
    return () => clearInterval(timer);
  }, [publishing, videoId, apply]);

  if (!video || !draft) return error ? <ErrorBox error={error} /> : <Spinner className="h-6 w-6" />;

  const onYouTube = Boolean(video.youtubeVideoId);
  const set = (key: keyof Draft) => (e: { target: { value: string } }) => setDraft({ ...draft, [key]: e.target.value });

  /** Saves a field when the user leaves it, if it changed. */
  const save = (key: keyof Draft) => () => {
    const value = key === "tags" ? draft.tags.split(",").map((t) => t.trim()).filter(Boolean) : draft[key];
    if (JSON.stringify(value) === JSON.stringify(video[key])) return;
    run("save", async () => apply(await api.updateVideo(video.id, { [key]: value })));
  };

  const ai = (name: string, fn: () => Promise<Video>) =>
    run(name, async () => {
      apply(await fn());
    });

  const uploadVideoFile = (file: File) =>
    run("video", async () => {
      setUploadProgress(0);
      try {
        apply(await uploadWithProgress(`/api/videos/${video.id}/files/video`, file, setUploadProgress));
      } finally {
        setUploadProgress(null);
      }
    });

  const publish = (now: boolean) =>
    run("publish", async () => {
      const scheduledAt = now ? null : new Date(when).toISOString();
      if (!now && new Date(when).getTime() < Date.now() + 15 * 60 * 1000) {
        throw new Error("Pick a time at least 15 minutes from now, or use Publish now.");
      }
      if (now && !confirm("Publish this video publicly on YouTube right now?")) return;
      await api.updateVideo(video.id, { scheduledAt });
      apply(await api.publish(video.id));
      setPublishing(true);
    });

  const remove = () =>
    run("delete", async () => {
      if (!confirm(onYouTube ? "Remove this video from the app? It stays on YouTube." : "Delete this video?")) return;
      await api.deleteVideo(video.id);
      navigate(`/channels/${video.channelId}`);
    });

  const words = draft.script.trim() ? draft.script.replace(/\[[^\]]*\]/g, "").trim().split(/\s+/).length : 0;
  const checklist = [
    { done: Boolean(video.script.trim()), label: "Script" },
    { done: Boolean(video.videoFile), label: "Video file" },
    { done: Boolean(video.title.trim() && video.description.trim()), label: "Title & description" },
    { done: Boolean(video.thumbnailFile) || video.format === "short", label: video.format === "short" ? "Thumbnail (optional for Shorts)" : "Thumbnail" },
  ];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <a className="btn-ghost -ml-3" href={`#/channels/${video.channelId}`}>
          <ArrowLeft className="h-4 w-4" /> {channel?.name ?? "Back"}
        </a>
        <div className="flex flex-wrap items-center gap-2">
          {busy === "save" && <span className="muted flex items-center gap-1"><Spinner className="h-3 w-3" /> Saving</span>}
          <select
            aria-label="Format"
            className="w-auto py-1"
            value={video.format}
            disabled={onYouTube}
            onChange={(e) => run("save", async () => apply(await api.updateVideo(video.id, { format: e.target.value as Video["format"] })))}
          >
            <option value="short">Short</option>
            <option value="long">Long video</option>
          </select>
          <select
            aria-label="Status"
            className="w-auto py-1"
            value={video.status}
            onChange={(e) => run("save", async () => apply(await api.updateVideo(video.id, { status: e.target.value as VideoStatus })))}
          >
            {Object.entries(STATUS_LABELS).map(([k, label]) => (
              <option key={k} value={k}>{label}</option>
            ))}
          </select>
          <button className="btn-ghost text-red-600" onClick={remove} aria-label="Delete video">
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div>
        <input
          className="border-none bg-transparent px-0 text-2xl font-semibold tracking-tight shadow-none focus:ring-0 dark:bg-transparent"
          value={draft.title}
          disabled={onYouTube}
          onChange={set("title")}
          onBlur={save("title")}
          aria-label="Title"
        />
        <div className="flex items-center gap-2">
          <FormatBadge format={video.format} />
          <span className={`text-xs ${draft.title.length > 100 ? "text-red-600" : "text-zinc-500"}`}>{draft.title.length}/100 characters</span>
        </div>
      </div>

      <ErrorBox error={error} onClose={() => setError(null)} />
      {video.error && !publishing && <ErrorBox error={video.error} />}
      {automated && video.pipeline && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-200">
          <span className="flex items-center gap-2">
            <Spinner /> Being made automatically: <b>{video.pipeline.step}</b>. The page updates by itself.
          </span>
          <button className="btn-secondary" onClick={() => run("cancel", async () => apply(await api.cancelPipeline(video.id)))}>
            Cancel
          </button>
        </div>
      )}
      {!automated && video.pipeline?.error && video.pipeline.error !== "Cancelled." && (
        <ErrorBox error={`Automatic production stopped: ${video.pipeline.error}`} />
      )}

      <Step n={1} title="The idea">
        <div className="grid gap-4 md:grid-cols-3">
          <Labeled label="Hook (first 3 seconds)">
            <textarea rows={3} value={draft.hook} onChange={set("hook")} onBlur={save("hook")} />
          </Labeled>
          <Labeled label="Angle">
            <textarea rows={3} value={draft.angle} onChange={set("angle")} onBlur={save("angle")} />
          </Labeled>
          <Labeled label="Search keyword">
            <input value={draft.keyword} onChange={set("keyword")} onBlur={save("keyword")} />
            <p className="mt-1 text-xs text-zinc-500">Tip: type it into YouTube search to check people look for it.</p>
          </Labeled>
        </div>
      </Step>

      <Step
        n={2}
        title="Research"
        done={Boolean(video.research)}
        action={
          status.ai && (
            <button
              className="btn-secondary"
              disabled={!!busy}
              onClick={() => {
                if (!video.research || confirm("Replace the current research?")) ai("research", () => api.research(video.id));
              }}
            >
              {busy === "research" ? <Spinner /> : <BookOpen className="h-4 w-4" />}
              {busy === "research" ? "Searching the web…" : video.research ? "Research again" : "Research with AI"}
            </button>
          )
        }
      >
        {video.research ? (
          <div className="space-y-4">
            <div className="max-h-96 overflow-y-auto whitespace-pre-wrap rounded-xl border border-white/20 bg-black/60 p-4 font-mono text-[13px] leading-relaxed text-white shadow-inner selection:bg-pink-500/40">
              {video.research.notes}
            </div>
            {video.research.sources.length > 0 && (
              <div>
                <p className="mb-2 text-sm font-semibold text-white">Sources ({video.research.sources.length})</p>
                <ul className="space-y-1.5 text-sm">
                  {video.research.sources.map((src) => (
                    <li key={src.url} className="truncate text-zinc-200">
                      <a href={src.url} target="_blank" rel="noreferrer" className="text-pink-400 hover:text-pink-300 underline font-semibold">
                        {src.title || src.url}
                      </a>
                      <span className="ml-2 text-xs text-zinc-300 font-mono">{new URL(src.url).hostname.replace(/^www\./, "")}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <p className="text-xs text-zinc-300">
              The script is written from these notes. Skim them and open a source or two, especially for claims about real people.
            </p>
          </div>
        ) : (
          <p className="text-sm text-zinc-300">
            The AI searches the web and collects facts with their sources, so the script is accurate. Recommended for history,
            mystery and money topics. Takes about a minute.
          </p>
        )}
      </Step>

      <Step
        n={3}
        title="Script"
        done={Boolean(video.script.trim())}
        action={
          status.ai && (
            <button
              className="btn-secondary"
              disabled={!!busy}
              onClick={() => {
                if (!video.script || confirm("Replace the current script with a new one?")) ai("script", () => api.generateScript(video.id));
              }}
            >
              {busy === "script" ? <Spinner /> : <Sparkles className="h-4 w-4" />}
              {busy === "script" ? "Writing…" : video.script ? "Rewrite with AI" : "Write script with AI"}
            </button>
          )
        }
      >
        <textarea
          rows={video.format === "short" ? 10 : 18}
          className="font-mono text-[13px] leading-relaxed"
          value={draft.script}
          onChange={set("script")}
          onBlur={save("script")}
          placeholder="Write or generate the script. Put filming directions in [square brackets]."
        />
        <p className="mt-1 text-xs text-zinc-500">
          {words} spoken words ≈ {Math.round(words / 2.5)} seconds
          {video.format === "short" && words / 2.5 > 60 && <span className="text-red-600"> (too long for a Short)</span>}
        </p>
      </Step>

      <Step n={4} title="Make the video" done={Boolean(video.videoFile) && !renderRunning}>
        {!onYouTube && (
          <div className="mb-5 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="flex items-center gap-2 font-medium">
                  <Wand2 className="h-4 w-4 text-red-600" /> Make it automatically
                </p>
                <p className="muted mt-1">
                  AI voiceover (the channel's voice engine), {channel?.visuals === "pictures" ? "AI pictures of the story" : "matching stock footage (Pexels)"} and captions, edited into a{" "}
                  {video.format === "short" ? "vertical Short" : "horizontal video"}. Takes a few minutes.
                </p>
                {channel && (
                  <p className="mt-1 text-xs text-zinc-500">
                    Voice:{" "}
                    <b>
                      {{ gemini: "Gemini", elevenlabs: "ElevenLabs", kokoro: "Kokoro (free)" }[
                        channel.voiceEngine ?? (status.gemini ? "gemini" : status.voice ? "elevenlabs" : "kokoro")
                      ]}
                      {channel.voiceId && (channel.voiceEngine === "gemini" || channel.voiceEngine === "kokoro") ? `, ${channel.voiceId}` : ""}
                    </b>{" "}
                    · <a className="underline" href={`#/channels/${channel.id}/edit`}>change</a>
                  </p>
                )}
                {channel && picturesEstimate(channel, video) && (
                  <p className="mt-1 text-xs text-zinc-500">
                    AI pictures: about <b>{picturesEstimate(channel, video)!.pictures}</b>, roughly{" "}
                    <b>${picturesEstimate(channel, video)!.cost.toFixed(2)}</b>.
                  </p>
                )}
                {channel && aiFootageEstimate(channel, video.format) && (
                  <p className="mt-1 text-xs text-zinc-500">
                    AI footage (Veo): up to <b>{aiFootageEstimate(channel, video.format)!.shots}</b> shot
                    {aiFootageEstimate(channel, video.format)!.shots > 1 ? "s" : ""}, roughly{" "}
                    <b>${aiFootageEstimate(channel, video.format)!.cost.toFixed(2)}</b> at most. Adds a few minutes.
                  </p>
                )}
              </div>
              {!renderRunning && (
                <button
                  className="btn-primary"
                  disabled={!!busy || !video.script.trim() || !(channel?.visuals === "pictures" ? status.gemini : status.footage)}
                  onClick={() => {
                    if (!video.videoFile || confirm("Replace the current video file with a newly made one?")) ai("render", () => api.render(video.id));
                  }}
                >
                  {busy === "render" ? <Spinner /> : <Wand2 className="h-4 w-4" />}
                  {video.videoFile ? "Make it again" : "Make video"}
                </button>
              )}
            </div>
            {!(channel?.visuals === "pictures" ? status.gemini : status.footage) && (
              <p className="mt-3 text-xs text-amber-300">
                Needs {channel?.visuals === "pictures" ? "your Gemini key (for AI pictures)" : "your Pexels key (for stock footage)"}. See{" "}
                <a className="underline" href="#/setup">Setup</a>.
              </p>
            )}
            {!video.script.trim() && <p className="mt-3 text-xs text-zinc-500">Write the script first.</p>}
            {renderRunning && video.render && (
              <div className="mt-4">
                <div className="mb-1 flex justify-between text-sm">
                  <span className="flex items-center gap-2"><Spinner className="h-3 w-3" /> {video.render.stage}</span>
                  <span className="text-zinc-500">{video.render.progress}%</span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
                  <div className="h-full bg-red-600 transition-all" style={{ width: `${video.render.progress}%` }} />
                </div>
                <p className="mt-2 text-xs text-zinc-500">You can leave this page. The video keeps being made.</p>
              </div>
            )}
            {video.render?.error && !renderRunning && (
              <div className="mt-3">
                <ErrorBox error={`The video maker stopped: ${video.render.error}`} />
              </div>
            )}
          </div>
        )}

        {!renderRunning && video.render?.notes && video.render.notes.length > 0 && (
          <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
            {video.render.notes.map((n) => (
              <p key={n}>{n}</p>
            ))}
          </div>
        )}
        {video.videoFile && !renderRunning && (
          <div className="mb-5">
            <p className="mb-2 text-sm font-medium">Preview: watch it all the way through before you schedule it</p>
            <video
              key={video.videoFile.name + video.updatedAt}
              controls
              preload="metadata"
              src={api.videoUrl(video)}
              className={`rounded-lg bg-black ${video.format === "short" ? "max-h-[70vh]" : "w-full"}`}
            />
          </div>
        )}

        <p className="muted mb-4">
          Or make it yourself: edit in CapCut or any AI video tool, export in 1080p{" "}
          ({video.format === "short" ? "vertical 9:16" : "horizontal 16:9"}), and upload the final file here.
        </p>
        <div className="grid gap-4 md:grid-cols-2">
          <FilePicker
            icon={<Film className="h-5 w-5" />}
            label="Final video"
            accept="video/*"
            file={video.videoFile && `${video.videoFile.name} · ${fileSize(video.videoFile.size)}`}
            disabled={onYouTube || !!busy || renderRunning}
            busy={busy === "video"}
            progress={uploadProgress}
            onPick={uploadVideoFile}
          />
          <FilePicker
            icon={<Image className="h-5 w-5" />}
            label={video.format === "short" ? "Thumbnail (optional)" : "Thumbnail (1280×720 JPG/PNG, under 2 MB)"}
            accept="image/jpeg,image/png"
            file={video.thumbnailFile?.name}
            preview={video.thumbnailFile && api.thumbnailUrl(video)}
            disabled={onYouTube || !!busy}
            busy={busy === "thumbnail"}
            onPick={(f) => ai("thumbnail", () => api.uploadFile(video.id, "thumbnail", f))}
          />
        </div>
        <p className="mt-3 text-xs text-zinc-500">
          Make thumbnails in Canva: search “YouTube thumbnail”, use a close-up photo and 3-4 big words.
        </p>
      </Step>

      <Step
        n={5}
        title="Title, description and tags"
        done={Boolean(video.title.trim() && video.description.trim())}
        action={
          status.ai &&
          !onYouTube && (
            <button className="btn-secondary" disabled={!!busy} onClick={() => ai("meta", () => api.generateMetadata(video.id))}>
              {busy === "meta" ? <Spinner /> : <Sparkles className="h-4 w-4" />}
              {busy === "meta" ? "Writing…" : "Write with AI"}
            </button>
          )
        }
      >
        {video.titleOptions.length > 0 && !onYouTube && (
          <div className="mb-4">
            <p className="mb-2 text-sm font-medium">Title options (click to use)</p>
            <div className="flex flex-wrap gap-2">
              {video.titleOptions.map((t) => (
                <button
                  key={t}
                  className={`rounded-lg border px-3 py-1.5 text-left text-sm ${
                    t === video.title
                      ? "border-red-500 bg-red-50 dark:bg-red-950/40"
                      : "border-zinc-300 hover:border-red-400 dark:border-zinc-700"
                  }`}
                  onClick={() => run("save", async () => apply(await api.updateVideo(video.id, { title: t })))}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="space-y-4">
          <Labeled label="Description">
            <textarea rows={8} value={draft.description} disabled={onYouTube} onChange={set("description")} onBlur={save("description")} />
          </Labeled>
          <Labeled label="Tags (comma separated)">
            <input value={draft.tags} disabled={onYouTube} onChange={set("tags")} onBlur={save("tags")} />
          </Labeled>
        </div>
      </Step>

      <Step n={6} title="Schedule on YouTube" done={onYouTube}>
        {onYouTube ? (
          <div className="space-y-3">
            <p className="flex items-center gap-2 text-sm">
              <Check className="h-4 w-4 text-green-600" />
              {video.status === "scheduled"
                ? `Scheduled. YouTube will publish it on ${formatDateTime(video.scheduledAt!)}.`
                : `Published ${video.scheduledAt ? formatDateTime(video.scheduledAt) : ""}.`}
            </p>
            {video.stats && (
              <p className="muted">
                {compact(video.stats.views)} views · {compact(video.stats.likes)} likes · {compact(video.stats.comments)} comments
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <a className="btn-secondary" href={`https://youtu.be/${video.youtubeVideoId}`} target="_blank" rel="noreferrer">
                <ExternalLink className="h-4 w-4" /> Open on YouTube
              </a>
              <a
                className="btn-ghost"
                href={`https://studio.youtube.com/video/${video.youtubeVideoId}/edit`}
                target="_blank"
                rel="noreferrer"
              >
                Edit in YouTube Studio
              </a>
            </div>
            <p className="text-xs text-zinc-500">Reply to comments in the first hour after it goes live. It helps the video get shown to more people.</p>
          </div>
        ) : publishing ? (
          <p className="flex items-center gap-2 text-sm">
            <Spinner /> Uploading to YouTube… You can leave this page; the upload keeps going.
          </p>
        ) : (
          <div className="space-y-4">
            <ul className="grid gap-1 text-sm sm:grid-cols-2">
              {checklist.map((c) => (
                <li key={c.label} className="flex items-center gap-2">
                  <span className={`flex h-4 w-4 items-center justify-center rounded-full ${c.done ? "bg-green-600 text-white" : "border border-zinc-400"}`}>
                    {c.done && <Check className="h-3 w-3" />}
                  </span>
                  {c.label}
                </li>
              ))}
            </ul>
            {!channel?.youtube ? (
              <p className="muted">
                <a className="underline" href={`#/channels/${video.channelId}`}>Connect this channel to YouTube</a> to schedule uploads.
              </p>
            ) : (
              <div className="flex flex-wrap items-end gap-3">
                <div>
                  <label htmlFor="when" className="mb-1.5">Publish time</label>
                  <input id="when" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
                </div>
                <button className="btn-primary" disabled={!!busy || !video.videoFile || !when || renderRunning} onClick={() => publish(false)}>
                  {busy === "publish" ? <Spinner /> : <CalendarClock className="h-4 w-4" />} Schedule on YouTube
                </button>
                <button className="btn-ghost" disabled={!!busy || !video.videoFile || renderRunning} onClick={() => publish(true)}>
                  Publish now
                </button>
              </div>
            )}
          </div>
        )}
      </Step>
    </div>
  );
}

function Step({ n, title, done, action, children }: { n: number; title: string; done?: boolean; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="card">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="flex items-center gap-3 font-semibold">
          <span
            className={`flex h-7 w-7 items-center justify-center rounded-full text-sm ${
              done ? "bg-green-600 text-white" : "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
            }`}
          >
            {done ? <Check className="h-4 w-4" /> : n}
          </span>
          {title}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function Labeled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label>{label}</label>
      {children}
    </div>
  );
}

function FilePicker(props: {
  icon: ReactNode;
  label: string;
  accept: string;
  file?: string;
  preview?: string;
  disabled: boolean;
  busy: boolean;
  progress?: number | null;
  onPick: (file: File) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="rounded-lg border border-dashed border-zinc-300 p-4 dark:border-zinc-700">
      <div className="mb-3 flex items-center gap-2 text-sm font-medium">
        {props.icon} {props.label}
      </div>
      {props.preview && <img src={props.preview} alt="" className="mb-3 aspect-video w-full rounded object-cover" />}
      {props.file && <p className="mb-3 truncate text-sm text-zinc-600 dark:text-zinc-400">{props.file}</p>}
      {props.progress != null && (
        <div className="mb-3 h-2 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
          <div className="h-full bg-red-600 transition-all" style={{ width: `${props.progress}%` }} />
        </div>
      )}
      <input
        ref={input}
        type="file"
        accept={props.accept}
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) props.onPick(file);
          e.target.value = "";
        }}
      />
      <button className="btn-secondary" disabled={props.disabled} onClick={() => input.current?.click()}>
        {props.busy ? <Spinner /> : <Upload className="h-4 w-4" />}
        {props.busy && props.progress != null ? `Uploading ${props.progress}%` : props.file ? "Replace" : "Choose file"}
      </button>
    </div>
  );
}

/** fetch() can't report upload progress, so large video files go through XHR. */
function uploadWithProgress(url: string, file: File, onProgress: (pct: number) => void) {
  return new Promise<Video>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(Math.round((e.loaded / e.total) * 100));
    xhr.onload = () => {
      let data: { error?: string } = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch {}
      if (xhr.status >= 200 && xhr.status < 300) resolve(data as Video);
      else reject(new Error(data.error ?? `Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error("Upload failed. Check your connection."));
    const form = new FormData();
    form.append("file", file);
    xhr.send(form);
  });
}
