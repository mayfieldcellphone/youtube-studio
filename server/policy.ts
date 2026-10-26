import type { Channel, Video } from "./db";

/**
 * Upload rules for the History's Shadows channel (and any channel in the "history" lane).
 * Everything here is pure (no I/O) so it can be unit tested; youtube.ts, ai.ts, pipeline.ts
 * and index.ts call into it.
 */

// ---------- Lanes (channel separation) ----------

export type Lane = "history" | "drama";

export interface SeriesDef {
  lane: Lane;
  /** Builds the required title from the subject, e.g. "Nicolas Flamel" */
  title?: (subject: string) => string;
}

/** Known series. Any other series name still gets a playlist, but no title pattern. */
export const SERIES: Record<string, SeriesDef> = {
  "Hogwarts vs History": {
    lane: "history",
    title: (name) => `The Real ${name}: What Harry Potter Got Wrong`,
  },
  "Heartbeat Hunt": { lane: "drama" },
};

const seriesKey = (name?: string | null) =>
  Object.keys(SERIES).find((k) => k.toLowerCase() === (name ?? "").trim().toLowerCase());

/** The lane a channel belongs to: set on the channel, or guessed from its name. */
export function channelLane(channel: Pick<Channel, "name" | "lane">): Lane | undefined {
  if (channel.lane) return channel.lane;
  if (/heartbeat\s*hunt/i.test(channel.name)) return "drama";
  if (/history/i.test(channel.name)) return "history";
  return undefined;
}

/** The lane a video belongs to. Heartbeat Hunt is recognised by its series or its title. */
export function videoLane(video: Pick<Video, "series" | "lane" | "title" | "keyword">): Lane {
  if (video.lane) return video.lane;
  const key = seriesKey(video.series);
  if (key) return SERIES[key].lane;
  if (/heartbeat\s*hunt/i.test(`${video.series ?? ""} ${video.title} ${video.keyword}`)) return "drama";
  return "history";
}

/**
 * Throws if the video must not go to this channel: a Heartbeat Hunt (drama) video only goes to
 * a drama channel, and history videos never go to a drama channel. Unclassified channels
 * (no lane, name doesn't say) are left alone.
 */
export function assertLaneMatches(video: Video, channel: Channel) {
  const cl = channelLane(channel);
  if (!cl) return;
  const vl = videoLane(video);
  if (cl !== vl) {
    throw new Error(
      vl === "drama"
        ? `"${video.title}" is a Heartbeat Hunt video but "${channel.name}" is a history channel. Move it to the Heartbeat Hunt channel first.`
        : `"${video.title}" is a history video but "${channel.name}" is the Heartbeat Hunt channel. History uploads can't go there.`,
    );
  }
}

/** True when the History's Shadows upload rules apply. */
export const isHistoryChannel = (channel: Pick<Channel, "name" | "lane">) => channelLane(channel) === "history";

// ---------- Titles ----------

export const SHORT_TITLE_MAX = 59; // "under 60 characters"
export const LONG_TITLE_MAX = 100;

function clip(title: string, max: number) {
  const t = title.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max + 1);
  const space = cut.lastIndexOf(" ");
  const base = (space > max * 0.6 ? cut.slice(0, space) : t.slice(0, max)).replace(/[\s,;:–—-]+$/, "");
  return base.slice(0, max);
}

/** The subject of a series title, e.g. "Nicolas Flamel" from "The Real Nicolas Flamel: …". */
function subjectOf(video: Pick<Video, "title" | "seriesSubject">) {
  if (video.seriesSubject?.trim()) return video.seriesSubject.trim();
  const m = /^The Real ([^:]{2,60}?)\s*:/i.exec(video.title.trim());
  return m?.[1].trim();
}

/** The title that will be uploaded: series pattern applied, length limits enforced. */
export function finalTitle(video: Pick<Video, "title" | "format" | "series" | "seriesSubject">) {
  let title = video.title.trim();
  const key = seriesKey(video.series);
  const def = key ? SERIES[key] : undefined;
  const subject = subjectOf(video);
  if (def?.title && subject) {
    title = def.title(subject);
    // Too long for a Short: shorter wording of the same pattern, then a plain clip.
    if (video.format === "short" && title.length > SHORT_TITLE_MAX) title = `The Real ${subject}: What Potter Got Wrong`;
  }
  return clip(title, video.format === "short" ? SHORT_TITLE_MAX : LONG_TITLE_MAX);
}

// ---------- Description and tags ----------

export const CHANNEL_BLURB =
  "Pop-culture myths vs the real history: Harry Potter, Houdini, unsolved mysteries and more. Subscribe so you don't miss the next case.";
export const AI_NOTE = "Narration and visuals are AI-assisted.";
export const BASE_HASHTAGS = ["#History", "#HistoryDocumentary", "#UnsolvedMysteries"];
export const BASE_TAGS = ["history", "history myths", "myths vs history", "harry potter history", "unsolved mysteries"];

const isHashtagLine = (l: string) => /^(\s*#\S+)+\s*$/.test(l);

/** The one-line hook for the description: the first line that isn't part of the template. */
export function hookLine(video: Pick<Video, "description" | "hook" | "title">) {
  const lines = video.description
    .split(/\n+/)
    .map((l) => l.trim())
    .filter((l) => l && !isHashtagLine(l) && l !== CHANNEL_BLURB && l !== AI_NOTE);
  return (lines[0] || video.hook || video.title).replace(/\s*#\S+/g, "").trim();
}

/**
 * Builds the full description: hook, channel blurb, AI note, hashtags. Anything the user or the
 * app added below the template (affiliate links, the dramatisation note) is kept after the AI note.
 */
export function buildDescription(video: Pick<Video, "description" | "hook" | "title" | "format">, extras: string[] = [], synthetic = true) {
  const hashtags = [...BASE_HASHTAGS, ...(video.format === "short" ? ["#Shorts"] : [])].join(" ");
  const parts = [hookLine(video), CHANNEL_BLURB, synthetic ? AI_NOTE : "", ...extras.filter(Boolean), hashtags];
  return parts.filter(Boolean).join("\n\n").slice(0, 5000);
}

/** The five fixed tags plus 3-5 topic tags (from the AI, then from the keyword/title). */
export function buildTags(video: Pick<Video, "tags" | "topicTags" | "keyword" | "title" | "series">) {
  const base = new Set(BASE_TAGS);
  const clean = (t: string) => t.replace(/^#/, "").trim().toLowerCase();
  const topic: string[] = [];
  const add = (t: string) => {
    const c = clean(t);
    if (c.length >= 3 && c.length <= 40 && !base.has(c) && !topic.includes(c)) topic.push(c);
  };
  (video.topicTags ?? []).forEach(add);
  // Fall back to tags already on the video (older videos), then keyword, series and title words.
  video.tags.forEach(add);
  if (video.keyword) add(video.keyword);
  if (video.series) add(video.series);
  const subject = subjectOf({ title: video.title, seriesSubject: undefined });
  if (subject) add(subject);
  video.title.split(/[:\-–—|?]/).forEach((p) => p.trim().split(/\s+/).length <= 4 && add(p));
  const tags = [...BASE_TAGS, ...topic.slice(0, 5)];
  // YouTube allows 500 characters of tags in total.
  const out: string[] = [];
  let len = 0;
  for (const t of tags) {
    len += t.length + (t.includes(" ") ? 3 : 1);
    if (len > 480) break;
    out.push(t);
  }
  return out;
}

// ---------- Shorts scripts ----------

export const SHORT_MAX_SECONDS = 90;
export const SHORT_DEFAULT_SECONDS = "45-60";
/** Spoken words per second of the narration (about 150 wpm). */
export const WORDS_PER_SECOND = 2.6;
export const SHORT_MAX_WORDS = Math.floor(SHORT_MAX_SECONDS * WORDS_PER_SECOND); // 234
export const SHORT_DEFAULT_WORDS = "115-155";

/** The spoken lines of a script: no [bracket] directions, speaker labels removed. */
export function spokenLines(script: string) {
  return script
    .split(/\n+/)
    .map((l) => l.trim())
    .filter((l) => l && !/^\[[^\]]*\]$/.test(l))
    .map((l) => l.replace(/^\[(?:NARRATOR|[A-Z][A-Za-z .'’-]*)(?:\s*\|[^\]]*)?\]\s*/, "").replace(/^[A-Z][A-Z .'’-]{1,30}:\s+/, "").trim())
    .filter((l) => l && !/^\[(?:SFX|MUSIC|AMBIENCE|CHAPTER|PAUSE|SOURCE)/i.test(l))
    .flatMap((l) => l.split(/(?<=[.!?])\s+(?=[A-Z"“])/))
    .map((s) => s.trim())
    .filter(Boolean);
}

const words = (s: string) => s.toLowerCase().match(/[a-z0-9’']+/g) ?? [];
const STOP = new Set("the a an and or but of to in on at for with is was were be been it its this that as by from he she they his her their you your i we not no so do did does had has have".split(" "));
const keyWords = (s: string) => words(s).filter((w) => w.length > 2 && !STOP.has(w));

export const SUBSCRIBE_RE = /\bsubscribe\b/i;
const GREETING_RE = /^(hey|hi|hello|welcome|greetings|good (morning|evening)|what'?s up|today|in this|this is|have you ever|did you know|ever wonder)\b/i;

/** Problems with a Short's script against the channel's rules. Empty means it passes. */
export function checkShortScript(script: string): string[] {
  const lines = spokenLines(script);
  const problems: string[] = [];
  if (lines.length < 4) return ["The script has too few spoken lines."];
  const total = lines.reduce((n, l) => n + words(l).length, 0);
  if (total > SHORT_MAX_WORDS) problems.push(`Too long: ${total} spoken words is about ${Math.round(total / WORDS_PER_SECOND)} seconds; a Short may run at most ${SHORT_MAX_SECONDS}.`);

  const first = lines[0];
  const firstWords = words(first).length;
  if (GREETING_RE.test(first)) problems.push("The first line is a greeting or set-up, not a surprising claim.");
  if (firstWords > 9) problems.push(`The opening claim is ${firstWords} words; it must land in the first 2 seconds (9 words at most).`);

  const last = lines[lines.length - 1];
  const prev = lines[lines.length - 2];
  if (!SUBSCRIBE_RE.test(prev)) problems.push("The line before the last one must be a spoken subscribe prompt.");
  if (SUBSCRIBE_RE.test(last)) problems.push("The last line must loop back to the opening, not be the subscribe prompt.");
  const fk = new Set(keyWords(first));
  const shared = keyWords(last).filter((w) => fk.has(w));
  if (fk.size && shared.length < Math.min(2, fk.size)) problems.push("The last line doesn't loop back to the opening line (it should echo its key words).");
  return problems;
}

/** Rough length of a script in seconds. */
export const estimateSeconds = (script: string) => Math.round(spokenLines(script).reduce((n, l) => n + words(l).length, 0) / WORDS_PER_SECOND);

// ---------- Variation (intro / outro / visual rotation) ----------

export interface Variation {
  intro: string;
  outro: string;
  look: "cinematic" | "clean" | "warm";
  /** Story format (see TECHNIQUES); videos made before it existed don't have one */
  technique?: string;
  assignedAt: string;
}

export const INTRO_STYLES: { id: string; brief: string }[] = [
  { id: "myth-flip", brief: "State the popular myth as a flat reversal in the first sentence (\"Nobody was burned in Salem.\"). The claim itself is the hook." },
  { id: "number-shock", brief: "Open on one startling specific number, date or measurement and what it means (\"Six hundred years old. And it's in Harry Potter.\")." },
  { id: "scene-drop", brief: "Drop into one concrete moment in present tense, mid-action, with a sensory detail (\"It's 2 a.m. The lamp is still lit.\"). No scene-setting before it." },
  { id: "record-quote", brief: "Open on what a surviving record, will, letter or inscription actually says, in a few words, then why that's strange. Name the document, never invent wording." },
];

export const OUTRO_STYLES: { id: string; subscribe: string; brief: string }[] = [
  { id: "echo-reveal", subscribe: "Subscribe for the next case.", brief: "The last line repeats the opening line's key words with a new meaning now that the viewer knows the answer." },
  { id: "question-loop", subscribe: "Subscribe so you don't miss the next case.", brief: "The last line turns the opening claim into a question the video has just answered, or one it hasn't." },
  { id: "twist-callback", subscribe: "Subscribe, because the next case is stranger.", brief: "The last line flips the opening claim with a final twist that reuses its wording." },
];

/**
 * Story formats that inject a popular pop-culture hook (a film, series, game or book the audience
 * already knows) into a documented history story. They differ in structure, not just wording, so
 * consecutive videos don't read as one template.
 */
export const TECHNIQUES: { id: string; name: string; brief: string }[] = [
  {
    id: "real-vs-reel",
    name: "Real vs Reel",
    brief: "Take ONE claim, scene, object or character from the pop-culture hook. State what the story shows, then what the documented record says, and where the two differ. One claim only, never a list.",
  },
  {
    id: "pov-record",
    name: "POV from the record",
    brief: "Second person, present tense: 'You're the surgeon, Paris, 1567.' Put the viewer inside the real moment that inspired the pop-culture hook, narrate it from surviving accounts, then reveal how the story changed it.",
  },
  {
    id: "origin-trace",
    name: "Origin trace",
    brief: "Start from the modern thing everyone knows (a spell, prop, phrase, trope) and trace it backwards through two or three documented steps to its surprising real origin.",
  },
  {
    id: "verdict-card",
    name: "Fact / Myth / Disputed",
    brief: "Judge three claims about the pop-culture hook in quick succession. Each gets a one-word verdict (FACT, MYTH or DISPUTED) and one line of evidence. The last verdict is the surprising one.",
  },
  {
    id: "receipt-first",
    name: "Receipt first",
    brief: "Open on the physical evidence (a will, a letter, a museum object, an inscription) and describe it concretely, then work outward to show how it connects to the pop-culture hook.",
  },
];

export const LOOKS: Variation["look"][] = ["cinematic", "warm", "clean"];

/** The video's place in upload order, for neighbour checks. */
const when = (v: Video) => Date.parse(v.scheduledAt ?? v.variation?.assignedAt ?? v.createdAt);

/** Videos on the channel with a variation, in upload order, excluding `self`. */
function peers(all: Video[], self: Video) {
  return all
    .filter((v) => v.id !== self.id && v.channelId === self.channelId && v.variation)
    .sort((a, b) => when(a) - when(b));
}

/** The uploads immediately before and after `self` in the schedule. */
export function neighbours(all: Video[], self: Video, at = Date.parse(self.scheduledAt ?? "") || Date.now() + 1) {
  const list = peers(all, self);
  const before = [...list].reverse().find((v) => when(v) <= at);
  const after = list.find((v) => when(v) > at);
  return [before, after].filter(Boolean) as Video[];
}

/**
 * Picks an intro style, outro style and visual look that differ from the neighbouring uploads,
 * preferring the ones used least recently, and avoiding intro styles whose Shorts retained
 * badly (flagged by the 48-hour analytics check).
 */
export function pickVariation(all: Video[], self: Video, now = new Date()): Variation {
  const near = neighbours(all, self);
  const others = peers(all, self);
  const choose = <T extends string>(options: T[], key: keyof Omit<Variation, "assignedAt">, flagged: (o: T) => number = () => 0): T => {
    const banned = new Set(near.map((v) => v.variation![key]));
    const usage = (o: T) => {
      const i = [...others].reverse().findIndex((v) => v.variation![key] === o);
      return i === -1 ? Infinity : i; // longer ago (or never) is better
    };
    const pool = options.filter((o) => !banned.has(o));
    const from = pool.length ? pool : options;
    return [...from].sort((a, b) => flagged(a) - flagged(b) || usage(b) - usage(a))[0];
  };
  const flagsFor = (intro: string) => others.filter((v) => v.variation!.intro === intro && v.analytics?.flag).length;
  return {
    intro: choose(INTRO_STYLES.map((s) => s.id), "intro", flagsFor),
    outro: choose(OUTRO_STYLES.map((s) => s.id), "outro"),
    technique: choose(TECHNIQUES.map((t) => t.id), "technique", (t) => others.filter((v) => v.variation!.technique === t && v.analytics?.flag).length),
    look: choose([...LOOKS], "look"),
    assignedAt: now.toISOString(),
  };
}

/** Throws if this video repeats an intro, outro or visual look of the upload next to it. */
export function assertVariation(all: Video[], video: Video) {
  if (!video.variation) return;
  for (const n of neighbours(all, video)) {
    for (const key of ["intro", "outro", "look", "technique"] as const) {
      if (n.variation![key] && n.variation![key] === video.variation[key]) {
        throw new Error(
          `"${video.title}" uses the same ${key === "look" ? "visual look" : key + " style"} (${video.variation[key]}) as the neighbouring upload "${n.title}". Regenerate its script so it gets a different one.`,
        );
      }
    }
  }
}

// ---------- Scheduling (Australia/Sydney) ----------

export const DEFAULT_TZ = "Australia/Sydney";
export const SHORT_TIME = "19:00";
export const LONG_TIME = "19:00";
/** Long-form day: 0 = Sunday … 6 = Saturday (Saturday by default). */
export const LONG_DAY = 6;

interface Parts { y: number; m: number; d: number; h: number; min: number; dow: number }

function partsIn(ms: number, tz: string): Parts {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", weekday: "short" });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, min: +p.minute, dow: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday) };
}

/** The UTC instant at which the wall clock in `tz` reads y-m-d h:min (DST-safe). */
export function zonedTime(y: number, m: number, d: number, h: number, min: number, tz: string) {
  let guess = Date.UTC(y, m - 1, d, h, min);
  for (let i = 0; i < 3; i++) {
    const p = partsIn(guess, tz);
    const shown = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min);
    const diff = Date.UTC(y, m - 1, d, h, min) - shown;
    if (!diff) break;
    guess += diff;
  }
  return new Date(guess);
}

/** Local calendar day in `tz`, e.g. "2026-10-27". */
export const dayKey = (ms: number, tz: string) => {
  const p = partsIn(ms, tz);
  return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
};

/** Monday-based week key in `tz`, e.g. the local date of that week's Monday. */
export const weekKey = (ms: number, tz: string) => {
  const p = partsIn(ms, tz);
  const back = (p.dow + 6) % 7;
  return dayKey(Date.UTC(p.y, p.m - 1, p.d - back, 12), "UTC");
};

const hm = (t: string) => t.split(":").map(Number) as [number, number];

/**
 * The next free publish slot for this video: a Short takes the next day at 19:00 Sydney with no
 * other Short; a long video takes the next Saturday at 19:00 Sydney in a week with no other long video.
 * At least 30 minutes ahead, so YouTube has time to process the upload.
 */
export function nextSlot(channel: Channel, video: Pick<Video, "id" | "format">, all: Video[], from = new Date()): Date {
  const tz = channel.timeZone || DEFAULT_TZ;
  const short = video.format === "short";
  const [h, min] = hm(short ? channel.shortTime || SHORT_TIME : channel.longTime || LONG_TIME);
  const longDay = channel.longDay ?? LONG_DAY;
  const taken = all.filter(
    (v) => v.id !== video.id && v.channelId === channel.id && v.format === video.format && v.scheduledAt && (v.youtubeVideoId || v.status === "scheduled"),
  );
  const takenKeys = new Set(taken.map((v) => (short ? dayKey(Date.parse(v.scheduledAt!), tz) : weekKey(Date.parse(v.scheduledAt!), tz))));
  const earliest = from.getTime() + 30 * 60 * 1000;
  const today = partsIn(from.getTime(), tz);
  for (let i = 0; i < 400; i++) {
    const slot = zonedTime(today.y, today.m, today.d + i, h, min, tz);
    if (slot.getTime() <= earliest) continue;
    if (!short && partsIn(slot.getTime(), tz).dow !== longDay) continue;
    const key = short ? dayKey(slot.getTime(), tz) : weekKey(slot.getTime(), tz);
    if (!takenKeys.has(key)) return slot;
  }
  throw new Error("No free publish slot found in the next year.");
}

/** Throws if another upload already holds this Short's day or this long video's week. */
export function assertSlotFree(channel: Channel, video: Video, all: Video[]) {
  if (!video.scheduledAt) return;
  const tz = channel.timeZone || DEFAULT_TZ;
  const short = video.format === "short";
  const key = (ms: number) => (short ? dayKey(ms, tz) : weekKey(ms, tz));
  const mine = key(Date.parse(video.scheduledAt));
  const clash = all.find(
    (v) => v.id !== video.id && v.channelId === channel.id && v.format === video.format && v.scheduledAt && (v.youtubeVideoId || v.status === "scheduled") && key(Date.parse(v.scheduledAt)) === mine,
  );
  if (clash) {
    throw new Error(
      short
        ? `"${clash.title}" is already scheduled for that day. The channel posts 1 Short per day.`
        : `"${clash.title}" is already scheduled for that week. The channel posts 1 long video per week.`,
    );
  }
}

// ---------- Analytics (48 hours after publishing) ----------

export const ANALYTICS_AFTER_HOURS = 48;
/** The Analytics API lags 2-3 days, so numbers are refreshed until the video is this old, then frozen. */
export const ANALYTICS_FREEZE_HOURS = 96;
export const SHORT_MIN_VIEWED_PERCENT = 40;

/** Whether this video's analytics should be pulled now. */
export function analyticsDue(video: Video, now = Date.now()) {
  if (!video.youtubeVideoId || video.status !== "published" || !video.scheduledAt) return false;
  const age = (now - Date.parse(video.scheduledAt)) / 3_600_000;
  if (age < ANALYTICS_AFTER_HOURS) return false;
  if (!video.analytics) return true;
  if (video.analytics.final) return false;
  // Refresh every 12 hours until frozen.
  return age >= ANALYTICS_FREEZE_HOURS || now - Date.parse(video.analytics.pulledAt) > 12 * 3_600_000;
}

/** Marks a Short whose average percentage viewed is under 40% so its hook style gets rewritten. */
export function analyticsFlag(video: Pick<Video, "format">, averageViewPercentage: number) {
  return video.format === "short" && averageViewPercentage < SHORT_MIN_VIEWED_PERCENT;
}

/** Concrete rewrite advice for a flagged Short, naming the intro style to move away from. */
export function rewriteAdvice(video: Video) {
  const used = video.variation?.intro;
  const next = INTRO_STYLES.filter((s) => s.id !== used).map((s) => s.id);
  return `Averaged ${video.analytics?.averageViewPercentage?.toFixed(0)}% viewed (target 40%+). Rewrite the hook${used ? ` — "${used}" didn't hold viewers; try ${next.join(", ")}` : ""}.`;
}
