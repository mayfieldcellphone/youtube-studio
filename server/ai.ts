import Anthropic from "@anthropic-ai/sdk";
import type { Channel, Research, Video } from "./db";
import { google } from "./veo";
import { allCast, NARRATOR, parseLine, scriptSpeakers, speakerKey } from "./speakers";
import { anchorCues, prepareScript } from "./screenplay";
import { db } from "./db";
import {
  buildDescription,
  buildTags,
  checkShortScript,
  finalTitle,
  INTRO_STYLES,
  isHistoryChannel,
  OUTRO_STYLES,
  pickVariation,
  SERIES,
  SHORT_DEFAULT_SECONDS,
  SHORT_DEFAULT_WORDS,
  SHORT_MAX_SECONDS,
  SHORT_MAX_WORDS,
  SHORT_TITLE_MAX,
  spokenLines,
  type Variation,
} from "./policy";

/** Current Claude model. If it declines a request, the API retries on Anthropic's recommended fallback model. */
const CLAUDE_MODEL = "claude-opus-5-5";
const CLAUDE_FALLBACK = { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const };

const GEMINI_MODELS = [
  "gemini-2.5-flash",
  "gemini-2.0-flash",
  "gemini-1.5-flash",
  "gemini-1.5-pro",
];

let client: Anthropic | undefined;
let clientKey: string | undefined;
/** Recreated when the key changes on the Setup page. */
const anthropic = () => {
  if (!client || clientKey !== process.env.ANTHROPIC_API_KEY) {
    clientKey = process.env.ANTHROPIC_API_KEY;
    client = clientKey ? new Anthropic({ apiKey: clientKey }) : undefined;
  }
  return client;
};

/** Any OpenAI-compatible service (Groq, OpenRouter, Mistral, Together, …) set up on the Setup page. */
export const extraAiConfigured = () =>
  Boolean(process.env.EXTRA_AI_BASE_URL && process.env.EXTRA_AI_API_KEY && process.env.EXTRA_AI_MODEL);

export const aiConfigured = () => Boolean(process.env.ANTHROPIC_API_KEY || process.env.GEMINI_API_KEY || extraAiConfigured());

const SYSTEM = `You are a YouTube strategist and scriptwriter who grows channels that earn money.
You know what makes people click (specific, curiosity-driven titles that tell the truth) and what makes them keep watching (a hook in the first 3 seconds, fast pacing, payoff that matches the title).
Follow YouTube's policies in everything you write:
- Monetization (inauthentic content): YouTube demonetizes mass-produced, repetitive, template-like or low-effort videos. Every idea and script needs its own angle, real research, and commentary or storytelling that adds value; never reuse the same structure, phrasing or hook pattern from video to video.
- Misinformation and accuracy: never invent statistics, quotes, dates or facts. Mark theories and disputed claims as such. Never present speculation about real people as fact.
- Spam and deceptive practices: titles, hooks, descriptions and thumbnails must match what the video actually shows. No clickbait the video doesn't pay off, no misleading claims, no keyword stuffing or unrelated tags.
- Community Guidelines: no graphic violence or gore, no sexual content, no hate or harassment, no dangerous challenges or instructions. Tell dark or tragic history respectfully, without sensationalizing victims' deaths.
- Advertiser-friendly: avoid profanity and shock content, so videos stay eligible for full ads.
- Copyright: rely on narration you write; never quote song lyrics or long passages from books, films or other creators.
Write in the channel's language and tone.`;

function channelBrief(channel: Channel) {
  return [
    `Channel name: ${channel.name}`,
    `Niche: ${channel.niche}`,
    `Target audience: ${channel.audience || "general"}`,
    `Tone: ${channel.tone || "friendly, clear and energetic"}`,
    `Language: ${channel.language || "English"}`,
  ].join("\n");
}

function videoBrief(video: Video) {
  return [
    `Format: ${video.format === "short" ? `YouTube Short (vertical, ${SHORT_DEFAULT_SECONDS} seconds, never over ${SHORT_MAX_SECONDS})` : "Long-form video (6-10 minutes)"}`,
    video.series && `Series: ${video.series}`,
    `Working title: ${video.title}`,
    video.hook && `Hook idea: ${video.hook}`,
    video.angle && `Angle: ${video.angle}`,
    video.keyword && `Search keyword: ${video.keyword}`,
  ]
    .filter(Boolean)
    .join("\n");
}

type Schema = Record<string, unknown>;
const str = (description: string): Schema => ({ type: "string", description });
const obj = (properties: Record<string, Schema>): Schema => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

/** Calls Gemini with JSON output mode. */
async function generateWithGemini<T>(prompt: string, schema: Schema): Promise<T> {
  if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not configured.");
  const instruction = `${SYSTEM}\n\nYou must return strictly valid JSON matching this schema:\n${JSON.stringify(schema, null, 2)}`;
  let lastErr: any;
  for (const model of GEMINI_MODELS) {
    try {
      const data = await google(`/models/${model}:generateContent`, {
        method: "POST",
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: `${prompt}\n\nReturn strictly valid JSON only.` }] }],
          systemInstruction: { parts: [{ text: instruction }] },
          generationConfig: {
            responseMimeType: "application/json",
          },
        }),
      });
      const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!rawText) throw new Error("No text returned from Gemini.");
      const cleaned = rawText
        .replace(/^```json\s*/i, "")
        .replace(/^```\s*/i, "")
        .replace(/```\s*$/i, "")
        .trim();
      return JSON.parse(cleaned) as T;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error("Gemini generation failed.");
}

/** Calls Claude with a JSON schema and returns the parsed result. */
async function generateWithAnthropic<T>(prompt: string, schema: Schema): Promise<T> {
  const c = anthropic();
  if (!c) throw new Error("ANTHROPIC_API_KEY is not configured.");
  const response = await c.beta.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 16000,
    ...CLAUDE_FALLBACK,
    system: SYSTEM,
    // Writing quality matters more than speed here; this model's default effort is medium.
    output_config: { effort: "high", format: { type: "json_schema", schema } },
    messages: [{ role: "user", content: prompt }],
  });

  if (response.stop_reason === "refusal") {
    throw new Error("The AI declined this request. Try rewording the idea.");
  }
  if (response.stop_reason === "max_tokens") {
    throw new Error("The AI response was cut off. Try again.");
  }
  const text = response.content.find((b) => b.type === "text");
  if (!text || text.type !== "text") throw new Error("The AI returned no text.");
  return JSON.parse(text.text) as T;
}

/** Parses a model's JSON answer, tolerating code fences and text around the object. */
export function parseJsonAnswer<T>(raw: string): T {
  const cleaned = raw.replace(/^\s*```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1)) as T;
    throw new Error("The AI didn't return valid JSON.");
  }
}

/** Calls any OpenAI-compatible chat endpoint (the "extra AI" on the Setup page) in JSON mode. */
async function generateWithExtra<T>(prompt: string, schema: Schema): Promise<T> {
  if (!extraAiConfigured()) throw new Error("The extra AI isn't set up.");
  const base = process.env.EXTRA_AI_BASE_URL!.replace(/\/+$/, "");
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.EXTRA_AI_API_KEY}` },
    body: JSON.stringify({
      model: process.env.EXTRA_AI_MODEL,
      temperature: 0.8,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: `${SYSTEM}\n\nReturn ONLY one JSON object matching this schema, with no other text:\n${JSON.stringify(schema)}` },
        { role: "user", content: prompt },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Extra AI error ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data: any = await res.json();
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error("The extra AI returned no text.");
  return parseJsonAnswer<T>(text);
}

type ProviderName = "claude" | "gemini" | "extra";

/** The AI services that are set up, in the order they are tried: Claude, Gemini, then the extra one. */
export function providerOrder(env: Record<string, string | undefined> = process.env): ProviderName[] {
  const order: ProviderName[] = [];
  if (env.ANTHROPIC_API_KEY) order.push("claude");
  if (env.GEMINI_API_KEY) order.push("gemini");
  if (env.EXTRA_AI_BASE_URL && env.EXTRA_AI_API_KEY && env.EXTRA_AI_MODEL) order.push("extra");
  return order;
}

/** Calls the first AI service that works, with a JSON schema, and returns the parsed result. */
async function generate<T>(prompt: string, schema: Schema): Promise<T> {
  const chain = providerOrder();
  if (!chain.length) {
    throw new Error("No AI API key configured. Add your Claude (Anthropic), Gemini (Google AI Studio) or another AI's key on the Setup page.");
  }
  let firstErr: unknown;
  for (const name of chain) {
    try {
      return name === "claude" ? await generateWithAnthropic<T>(prompt, schema) : name === "gemini" ? await generateWithGemini<T>(prompt, schema) : await generateWithExtra<T>(prompt, schema);
    } catch (err) {
      firstErr ??= err;
      console.warn(`${name} generation error${name === chain[chain.length - 1] ? "" : ", trying the next AI"}:`, (err as Error).message);
    }
  }
  throw firstErr;
}

export interface Idea {
  title: string;
  hook: string;
  format: "short" | "long";
  keyword: string;
  angle: string;
}

export async function generateIdeas(channel: Channel, count: number, existingTitles: string[], focus?: string) {
  const safeCount = Math.min(5, Math.max(2, count));
  const trends = await scanTrends(channel, focus);
  const prompt = `${channelBrief(channel)}
${trends ? `\nWhat is getting attention right now (from a web search today):\n${trends}\n` : ""}
Come up with ${safeCount} new video ideas for this channel. Mix YouTube Shorts and long-form videos (about 2 Shorts for every long video).
What makes an idea strong:
- A proven topic: people already search for it or it has gone viral for other channels, but this idea has a fresh angle.
- One specific, surprising detail at its core (a name, number, object, date or twist). "The lighthouse keepers who vanished and left dinner on the table" beats "Mysterious disappearances".
- A curiosity gap the title opens and the video pays off honestly. No clickbait the video can't deliver.
- Strong emotion: awe, dread, outrage, disbelief, or "wait, that's real?".
- Can be made with narration and stock footage or AI pictures (no filming required).
- Prefer the timely and untold opportunities from the web search above; skip topics it lists as overdone unless the angle is genuinely new.
${focus ? `Focus on: ${focus}\n` : ""}${
    existingTitles.length
      ? `Do not repeat these existing videos:\n${existingTitles.map((t) => `- ${t}`).join("\n")}\n`
      : ""
  }`;

  const result = await generate<{ ideas: Idea[] }>(prompt, obj({
    ideas: {
      type: "array",
      items: obj({
        title: str("Clickable, honest title under 70 characters"),
        hook: str("The exact first sentence the narrator says: the most surprising specific detail, no scene-setting"),
        format: { type: "string", enum: ["short", "long"] },
        keyword: str("Main search phrase this video should rank for"),
        angle: str("One sentence: what makes this video different, and why people want it now"),
      }),
    },
  }));
  return result.ideas.slice(0, safeCount);
}

/** Researches the topic, using Anthropic web search if available, or direct AI research with Claude/Gemini. */
async function searchWeb(prompt: string, maxSearches: number): Promise<Omit<Research, "createdAt">> {
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const c = anthropic();
      if (c) {
        const content: Anthropic.Beta.BetaContentBlock[] = [];
        let response: Anthropic.Beta.BetaMessage | undefined;
        for (let i = 0; i < 5; i++) {
          const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: prompt }];
          if (content.length) messages.push({ role: "assistant", content });
          response = await c.beta.messages.create({
            model: CLAUDE_MODEL,
            max_tokens: 16000,
            ...CLAUDE_FALLBACK,
            system: SYSTEM,
            tools: [{ type: "web_search_20260209", name: "web_search", max_uses: maxSearches }],
            messages,
          });
          content.push(...response.content);
          if (response.stop_reason !== "pause_turn") break;
        }

        if (response && response.stop_reason !== "refusal" && response.stop_reason !== "pause_turn") {
          const lastSearch = content.map((b) => b.type).lastIndexOf("web_search_tool_result");
          const answer = content.slice(lastSearch + 1);
          const notes = answer.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
          if (notes) {
            const cited = new Map<string, string>();
            const found = new Map<string, string>();
            for (const block of content) {
              if (block.type === "text") {
                for (const c of block.citations ?? []) {
                  if (c.type === "web_search_result_location") cited.set(c.url, c.title ?? c.url);
                }
              } else if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
                for (const r of block.content) found.set(r.url, r.title);
              }
            }
            const sources = [...(cited.size ? cited : found)].map(([url, title]) => ({ url, title })).slice(0, 15);
            return { notes, sources };
          }
        }
      }
    } catch (err) {
      console.warn("Anthropic web search unavailable, falling back to direct AI research:", err);
    }
  }

  // Direct research fallback: works with Gemini or Claude without requiring web search tool
  const res = await generate<{ notes: string; sources: { url: string; title: string }[] }>(
    `${prompt}\n\nReturn rich, factual research notes and a list of reliable reference sources.`,
    obj({
      notes: str("Comprehensive research notes with KEY FACTS, TIMELINE, SURPRISING DETAILS, HUMAN STORY, OPEN QUESTIONS, CAUTION"),
      sources: {
        type: "array",
        items: obj({ url: str("Source URL or archive name"), title: str("Source title or description") }),
      },
    }),
  );
  return {
    notes: res.notes || "Factual notes compiled from historical records and documentation.",
    sources: res.sources && res.sources.length ? res.sources : [{ url: "https://wikipedia.org", title: "Historical Archives" }],
  };
}

/**
 * Researches a video topic on the web and returns notes plus the sources used,
 * so scripts are built on checked facts instead of the model's memory.
 */
export function research(channel: Channel, video: Video) {
  return searchWeb(
    `${channelBrief(channel)}

${videoBrief(video)}

Research this video topic on the web so a scriptwriter can write an accurate, gripping script.
Write research notes in plain text (no URLs; sources are listed separately):
- KEY FACTS: the most important facts. Start each line with [Confirmed], [Disputed] or [Theory].
- TIMELINE: dates and events in order, if the topic has one.
- SURPRISING DETAILS: 3-6 details most viewers won't know. These make the best hooks.
- HUMAN STORY: the people involved, what they wanted, feared or lost; quotes from records or witnesses if reliable.
- OPEN QUESTIONS: what is still unknown or debated.
- CAUTION: anything that must not be stated as fact (e.g. accusations against real people who were never convicted).
Use reliable sources: official records, major news outlets, museums, universities, encyclopedias. Keep it under 900 words.`,
    8,
  );
}

/**
 * Scans the web for what is getting attention in the channel's niche right now, so ideas
 * come from real demand instead of the model's memory. Returns undefined if the scan fails.
 */
async function scanTrends(channel: Channel, focus?: string) {
  const today = new Date().toISOString().slice(0, 10);
  try {
    const { notes } = await searchWeb(
      `${channelBrief(channel)}
${focus ? `Focus: ${focus}\n` : ""}
Today is ${today}. Search the web to find video topics for this channel that people want to watch right now. Look for:
- Recent news in the niche: new discoveries, reopened cases, anniversaries in the next 2 months, new documentaries, books or court rulings.
- Topics getting a lot of views on YouTube and social media lately in this niche, and which angles are already overdone.
- Lesser-known stories with a strong, specific hook that big channels haven't covered well.
Write plain-text notes: 12-20 topic opportunities, one per line, each with the specific hook and why it would get views now (timely, proven demand, or untold). Then list 5 topics that are overdone and should be avoided unless there is a genuinely new angle. Under 700 words, no URLs.`,
      6,
    );
    return notes;
  } catch (err) {
    console.error(`Trend scan failed, writing ideas without it: ${(err as Error).message}`);
    return undefined;
  }
}

/** Techniques that keep viewers watching; shared by the writer and the editor pass. */
function scriptCraft(video: Video, variation?: Variation) {
  const intro = INTRO_STYLES.find((i) => i.id === variation?.intro);
  const outro = OUTRO_STYLES.find((o) => o.id === variation?.outro);
  const strictShort = video.format === "short" && Boolean(intro && outro);
  const shape = strictShort
    ? `SHORT (vertical, ${SHORT_DEFAULT_SECONDS} seconds by default, about ${SHORT_DEFAULT_WORDS} spoken words; go up to ${SHORT_MAX_SECONDS} seconds / ${SHORT_MAX_WORDS} words only when the story needs it, never beyond):
- Line 1 is the surprising claim, in 9 words or fewer, so it lands in the first 2 seconds. It is NOT a greeting: no "Hey", "Welcome", "Today", "In this video", "Did you know", no question, no scene-setting. It must make sense to someone who knows nothing about the story and open a question they need answered.
- Opening style for this video: ${intro!.brief}
- Follow ONE thread. A Short has room for one mystery and one payoff; cut side details, however interesting.
- Every following sentence adds new information or raises the stakes. Cut anything that repeats or explains the obvious.
- Halfway through, re-hook with a line that raises a new question ("But the note in his pocket was stranger.").
- Build to one twist or reveal near the end.
- The second-to-last spoken line is the spoken subscribe prompt, in these words or very close to them: "${outro!.subscribe}"
- The LAST spoken line loops back to line 1: ${outro!.brief} It must reuse at least two key words from line 1, must not contain the word "subscribe", and nothing comes after it.`
    : video.format === "short"
      ? `SHORT (vertical, 35-55 seconds, about 110-140 spoken words):
- Line 1 is the hook: the single most surprising, specific detail, stated in under 12 words. It must make sense instantly to someone who knows nothing about the story, and open a question they need answered. No scene-setting, no "Did you know", no question as the opener.
- Follow ONE thread. A Short has room for one mystery and one payoff; cut side details, however interesting.
- Every following sentence adds new information or raises the stakes. Cut anything that repeats or explains the obvious.
- Halfway through, re-hook with a line that raises a new question ("But the note in his pocket was stranger.").
- Build to one twist or reveal near the end.
- The last line should connect back to the first so the Short loops smoothly. No "subscribe for more" (a 3-word CTA at most, or none).`
      : `LONG VIDEO (6-10 minutes, about 950-1,550 spoken words):
- Cold open (first 20-30 seconds): drop straight into the most dramatic moment of the story, then cut away with a question the video will answer.
- Promise: one sentence on what the viewer will know by the end.
- 3-5 chapters. Each chapter reveals something new and ends on an open loop or cliffhanger that pulls into the next ("But that wasn't the strangest part.").
- Around 40% in, one short natural call to subscribe, tied to the story.
- Climax: the biggest reveal. Then resolution: what we know, what is still unknown, and why it matters.
- Final line teases a related story to watch next.`;

  return `${shape}

VOICE AND STYLE (this is narration for a voiceover, so write for the ear):
- The first sentence is the hook and must land inside the first 5 seconds of speech: a concrete, startling moment, not background.
- Short, punchy sentences. Vary the length on purpose: a run of short ones, then one long sentence that rolls, then a very short one to land the beat. One idea per sentence.
- Keep what is confirmed apart from what is disputed. Confirmed facts are stated flatly ("Records show…"); disputed or unproven claims are labelled as such in the same breath ("Some researchers believe…", "No document proves it, but…"). Never state a theory as fact.
- Concrete and sensory: names, places, dates, numbers, what it looked, sounded and felt like. Show, don't summarise.
- Use present tense for dramatic moments ("It's 2 a.m. The radio goes silent.").
- Occasionally speak to the viewer as "you" to pull them in.
- Easy to follow by ear, because viewers can't rewind: at most 3 names and 3 numbers or dates in a Short (6 of each in a long video). Round or drop the rest ("in 1948", not "on the first of December 1948"; "a scientist", not his full name, unless the name matters).
- Make people care: give the viewer a person to feel for (what they lost, feared or wanted) and say what was at stake. A list of facts, however accurate, is dull.
- End on the strongest beat: the most shocking, ironic or unsettling fact, or a question that lingers. Never let the energy drop at the end (no "the case remains open" as a flat final line).
- Create tension with open questions, contrasts and reveals, not with adjectives.
- Never use these clichés: "in this video", "let's dive in", "buckle up", "without further ado", "little did they know", "shrouded in mystery", "the rest is history", "imagine a world", "delve", "tapestry", "hey guys", "welcome back".
- No filler, no rhetorical question chains, no moralising at the end.
- Put visual directions on their own line in [square brackets]; they are not read aloud.`;
}

/**
 * When the channel has a cast of character voices, scripts may include short dramatised
 * scenes in which those characters speak (see speakers.ts for the format).
 */
function castCraft(channel: Channel, video: Video) {
  const cast = allCast(channel, video);
  const names = cast.map((c) => speakerKey(c.name));
  if (!names.length) return "";
  const who = cast
    .map((c) => `${speakerKey(c.name)}${c.role ? ` (${c.role})` : ""}${c.tone ? `, voice: ${c.tone}` : ""}`)
    .join("; ");
  return `

SCREENPLAY FORMAT (this video has actors for these speakers: ${who}):
Write the script as a screenplay, one event per line:
[NARRATOR] The documentary voice: facts, context, transitions. Most lines are this.
[SPEAKER | emotion] A character speaking in their own voice, e.g. [HOUDINI | tired, whispering] I can still feel the blow.
[SFX: train whistle] A sound effect, on its own line, only where it adds atmosphere.
[MUSIC: low strings, tense] A change in the music, on its own line, rarely. Use "out" or "silence" to drop the music completely until the next [MUSIC] line, and "swell" to lift it for a climax.
[AMBIENCE: rain on a tin roof] A quiet looping sound bed for the location, placed where the scene changes place. It plays until the next [AMBIENCE] line.
[CHAPTER: The Hospital] Between the chapters of a long video: plays a short stinger. Skip it in Shorts.
[PAUSE: 600ms] A deliberate silence before the next line (200-1500 ms), used for dread, a reveal or after a shock.
Visual directions go on their own line in [square brackets] with no label or colon, e.g. [slow push-in on the empty tent]; they are not spoken.

Rules for characters:
- Only use these speaker labels: ${names.join(", ")}, plus NARRATOR. A line with no tag is read by the narrator.
- Character dialogue is at most 30-40% of the spoken words; the narrator carries the story and every fact.
- Put dialogue at the key moments (a confrontation, a confession, a last goodbye), in short exchanges of 2-6 lines, not speeches. Open each dramatised scene with a narrator line that signals it ("Imagine the room that night.").
- Emotion tags are one to three words describing how the line is spoken (firm, whispering, afraid, cold, laughing, interrupting). Use "interrupting" when a character cuts in on the one before, and end the line that gets cut off with a dash.
- Use words actually recorded in the research (trial records, letters, inscriptions) only where they exist, and mark such a line with its source: [HOUDINI | firm] [SOURCE: letter to his brother, 1924] The words as recorded. Every other character line is a reconstruction: it must be short, plausible for the person and era, and must never be presented as something they really said. Never put invented words in a real person's mouth as a quote.
- A line that is an invented reconstruction needs no extra tag (it is treated as dramatised); do not write the narrator as saying "he said" before an invented line.`;
}

export async function generateScript(channel: Channel, video: Video) {
  const history = isHistoryChannel(channel);
  // Each script comes from its own research notes, never a reused template.
  if (history && !video.research?.notes?.trim()) {
    throw new Error("Run research on this video first: every script on this channel is written from its own research notes.");
  }
  const research = video.research
    ? `\nResearch notes (base every fact on these; say "reportedly" or "some believe" for anything marked Disputed or Theory, and respect the CAUTION section):\n${video.research.notes}\n`
    : "";

  // A fresh intro style, outro style and visual look, different from the neighbouring uploads.
  let variation: Variation | undefined;
  let avoid = "";
  if (history) {
    variation = pickVariation(db.videos(), video);
    db.updateVideo(video.id, { variation });
    const recent = db
      .videos(video.channelId)
      .filter((v) => v.id !== video.id && v.script.trim())
      .sort((x, y) => y.updatedAt.localeCompare(x.updatedAt))
      .slice(0, 6)
      .map((v) => `- ${spokenLines(v.script)[0] ?? ""}`)
      .join("\n");
    if (recent) avoid = `\nOpening lines of the channel's recent videos. Do not echo their wording or sentence shape:\n${recent}\n`;
  }
  const craft = scriptCraft(video, variation);

  const draft = await generate<{ script: string }>(
    `${channelBrief(channel)}

${videoBrief(video)}
${research}${avoid}
Write the full narration script for this video, ready to be read aloud by a voiceover.

${craft}${castCraft(channel, video)}`,
    obj({ script: str("The complete script") }),
  );

  // A second pass as a tough editor reliably makes the hook sharper and cuts flat lines.
  const edited = await generate<{ problems: string; script: string }>(
    `${channelBrief(channel)}

${videoBrief(video)}
${research}
You are the channel's toughest script editor. Here is a draft:

${draft.script}

First, list the biggest problems briefly: a hook that needs context to understand, slow or generic lines, clichés, vague statements, too many names, dates and numbers to follow by ear, no person to care about, missing tension or re-hook, a flat or anticlimactic ending, facts not supported by the research, lines that are hard to say aloud.
Judge it as a viewer scrolling at midnight: would they stop at line 1, and still be there at the end?
Then rewrite the whole script to fix them. Keep every fact accurate, keep it the right length, and make every line earn its place. If the script uses screenplay tags ([NARRATOR], [NAME | emotion], [SFX: ...], [MUSIC: ...], [PAUSE: ...], [SOURCE: ...]), keep that exact format on every line.

The standard it must meet:
${craft}${castCraft(channel, video)}`,
    obj({ problems: str("Short list of what was wrong"), script: str("The improved complete script") }),
  );
  let script = edited.script;

  // Shorts on this channel must pass the hard rules (claim first, subscribe prompt, loop, length).
  if (history && video.format === "short") {
    for (let attempt = 0; attempt < 2; attempt++) {
      const problems = checkShortScript(script);
      if (!problems.length) break;
      const fixed = await generate<{ script: string }>(
        `${channelBrief(channel)}

${videoBrief(video)}
${research}
This Short script breaks the channel's rules:
${problems.map((p) => `- ${p}`).join("\n")}

Script:
${script}

Rewrite it so every rule is met, keeping the facts and the story. Rules:
${craft}${castCraft(channel, video)}`,
        obj({ script: str("The corrected complete script") }),
      );
      script = fixed.script;
    }
    const left = checkShortScript(script);
    if (left.length) console.warn(`Script for "${video.title}" still breaks rules after two fixes: ${left.join(" ")}`);
  }
  return script;
}

export interface SuggestedCharacter {
  name: string;
  role: string;
  voiceDescription: string;
  appearance: string;
  sampleLine: string;
}

/**
 * Proposes the people who should speak in a story's dramatised scenes, each with a voice
 * description for ElevenLabs Voice Design and a line to hear the voice with. Nothing is
 * created: the user reviews and approves first.
 */
export async function suggestCast(channel: Channel, video: Video) {
  const research = video.research ? `\nResearch notes:\n${video.research.notes}\n` : "";
  const script = video.script.trim() ? `\nCurrent script:\n${video.script}\n` : "";
  const result = await generate<{ characters: SuggestedCharacter[] }>(
    `${channelBrief(channel)}

${videoBrief(video)}
${research}${script}
This video will include 2-4 short dramatised scenes where real people from the story speak in their own voices, between the narrator's lines.
Choose the ${video.format === "short" ? "1-2" : "2-4"} people whose spoken lines would make the strongest scenes: the central figure, an opponent, a witness or official. Only real people documented in this story (or an anonymous role such as "a guard" or "the prosecutor" when the records don't name them). No narrator.
For each give:
- "name": the speaker label for the script, 1-2 words in capitals (JOAN, PROSECUTOR, FLAMEL).
- "role": who they are in this story, under 12 words ("Joan of Arc, 19, on trial for heresy in 1431").
- "voiceDescription": a description for an AI voice designer, 120-300 characters: gender, age, accent fitting their country and era (spoken in English), pitch, pace, tone and personality, recording quality ("clear, close studio recording"). Describe a voice type only; never ask it to imitate any real person or actor.
- "appearance": how they look, for a painted portrait, 120-300 characters: sex, approximate age, face, hair, build, and clothing accurate to their country, era and rank. Don't use their name; describe them so a painter who has never heard of them could paint them ("a stern French cleric in his fifties, clean-shaven, grey tonsure, black and white Dominican habit, 1430s").
- "sampleLine": a line they could plausibly say in the video, in English, 110-220 characters, in their voice and era. Use recorded words from the research when there are any; otherwise invent nothing factual.`,
    obj({
      characters: {
        type: "array",
        items: obj({
          name: str("Speaker label in capitals"),
          role: str("Who they are in the story"),
          voiceDescription: str("Voice design description, 120-300 characters"),
          appearance: str("How they look for a painted portrait, 120-300 characters, without their name"),
          sampleLine: str("A line to preview the voice, 110-220 characters"),
        }),
      },
    }),
  );
  return result.characters
    .map((c) => ({
      name: speakerKey(c.name).replace(/[^A-Z .'-]/g, "").trim().slice(0, 40),
      role: c.role.trim().slice(0, 200),
      voiceDescription: c.voiceDescription.trim().slice(0, 1000),
      appearance: (c.appearance ?? "").trim().slice(0, 1000),
      sampleLine: c.sampleLine.trim().slice(0, 900),
    }))
    .filter((c) => c.name && c.name !== NARRATOR && c.voiceDescription.length >= 20)
    .slice(0, 4);
}

export interface Metadata {
  titles: string[];
  description: string;
  tags: string[];
  /** 3-5 topic-specific tags (History's Shadows rules) */
  topicTags?: string[];
  /** Main subject of the video, used in series titles */
  subject?: string;
}

export async function generateMetadata(channel: Channel, video: Video): Promise<Metadata> {
  if (isHistoryChannel(channel)) return generateHistoryMetadata(channel, video);
  const prompt = `${channelBrief(channel)}

${videoBrief(video)}
${video.script ? `\nScript:\n${video.script}` : ""}

Write the YouTube upload details for this video:
- 5 title options under 70 characters. Put the search keyword near the start where it reads naturally.
- A description: the first 2 lines must hook and include the keyword (they show in search), then a short summary${video.format === "long" ? ", then a chapters placeholder list" : ""}, then 3-5 relevant hashtags on the last line${video.format === "short" ? " including #shorts" : ""}.
- 10-15 tags, most specific first.
- If the video gives financial, health or legal information, add a one-line disclaimer (e.g. "Not financial advice.").${
    channel.affiliateLinks?.trim()
      ? `\n- Where relevant to this video, add these links in the description with a short line each, marked as affiliate links:\n${channel.affiliateLinks.trim()}`
      : ""
  }`;

  return generate<Metadata>(prompt, obj({
    titles: { type: "array", items: str("Title option") },
    description: str("Full video description"),
    tags: { type: "array", items: str("Tag without #") },
  }));
}

/** History's Shadows: the AI writes only the creative parts; code applies the fixed template. */
async function generateHistoryMetadata(channel: Channel, video: Video): Promise<Metadata> {
  const short = video.format === "short";
  const def = Object.entries(SERIES).find(([name]) => name.toLowerCase() === (video.series ?? "").toLowerCase())?.[1];
  const prompt = `${channelBrief(channel)}

${videoBrief(video)}
${video.script ? `\nScript:\n${video.script}` : ""}

Write the YouTube upload details for this video:
- 5 title options, each under ${short ? SHORT_TITLE_MAX + 1 : 70} characters, honest to the video, search keyword near the start where it reads naturally.${
    def?.title ? `\n- This video is part of the "${video.series}" series. Every title must follow exactly: ${def.title("[Name]")}. Put the subject's name in place of [Name].` : ""
  }
- subject: the main person, object or event the video is about, as a short name (used in series titles).
- hook: ONE line (under 110 characters) that opens the description. A concrete, true claim from the video. No hashtags, no emoji.
- topicTags: 3-5 tags specific to THIS video (people, objects, places, events), lower case, no #. Do not repeat generic tags like "history" or "unsolved mysteries".`;

  const res = await generate<{ titles: string[]; subject: string; hook: string; topicTags: string[] }>(
    prompt,
    obj({
      titles: { type: "array", items: str("Title option") },
      subject: str("Main subject, short name"),
      hook: str("One-line description hook"),
      topicTags: { type: "array", items: str("Topic tag without #") },
    }),
  );
  const subject = res.subject?.trim() || undefined;
  const base = { ...video, seriesSubject: video.seriesSubject || subject };
  const titles = [...new Set(res.titles.map((t) => finalTitle({ ...base, title: t })))];
  const topicTags = res.topicTags.slice(0, 5);
  // Persisted by the caller; the description and tags here are what will be uploaded.
  const merged = { ...base, description: res.hook, topicTags, tags: [] as string[] };
  return {
    titles,
    subject,
    topicTags,
    description: buildDescription(merged, [], true),
    tags: buildTags(merged),
  };
}

export interface Scene {
  narration: string;
  /** Who speaks this scene: NARRATOR, or a speaker label from the script such as "JOAN" */
  speaker: string;
  /** Delivery cue for a character line ("firm", "whispering"), or empty */
  delivery: string;
  /** A cinematic shot description for an AI video model (Veo). */
  aiPrompt: string;
  /** The biggest reveal or emotional peak of the video. */
  keyMoment: boolean;
  /** The scene's shots; its time is split between them. */
  shots: Shot[];
  /** Sound cues from the screenplay, in script order, placed before this scene's speech */
  cues?: SceneCue[];
  fallbackQuery: string;
}

export interface SceneCue {
  kind: "sfx" | "music" | "ambience" | "chapter" | "pause";
  text?: string;
  ms?: number;
}

export interface Shot {
  /** Stock footage search */
  search: string;
  /** Description for an AI picture of this exact moment */
  picture: string;
}

/** Splits a script into narrated scenes, each with its shots (stock searches and AI picture descriptions). */
export async function planScenes(channel: Channel, video: Video) {
  // A long script is planned in parts at the same time: one reply can't hold a detailed
  // shot list for a whole 10-minute video.
  // Screenplay tags ([HOUDINI | tired], [SFX: ...], [PAUSE: 600ms]) are turned into the plain
  // labelled form the planner reads; the sound cues are attached to their scenes afterwards.
  const prepared = prepareScript(video.script);
  const planVideo: Video = { ...video, script: prepared.spoken };
  const parts = splitScript(prepared.spoken, 250);
  const planned: Scene[][] = new Array(parts.length);
  let next = 0;
  const worker = async () => {
    while (next < parts.length) {
      const i = next++;
      planned[i] = await planPart(channel, planVideo, parts, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, parts.length) }, worker));
  const scenes = planned.flat();
  if (!scenes.length) throw new Error("The script has no spoken lines to narrate.");
  const anchors = anchorCues(prepared.cues, scenes.map((s) => s.narration));
  prepared.cues.forEach((cue, k) => {
    const scene = scenes[anchors[k]];
    if (!scene) return;
    (scene.cues ??= []).push({ kind: cue.kind, ...(cue.text ? { text: cue.text } : {}), ...(cue.ms ? { ms: cue.ms } : {}) });
  });
  return scenes;
}

/** Splits a script at line breaks (or sentences, for very long paragraphs) into parts of about maxWords. */
export function splitScript(script: string, maxWords: number) {
  const words = (t: string) => t.split(/\s+/).filter(Boolean).length;
  const pieces = script
    .split(/\n+/)
    .map((p) => p.trim())
    .filter(Boolean)
    .flatMap((p) => (words(p) > maxWords ? p.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) ?? [p] : [p]));
  const parts: string[] = [];
  let current: string[] = [];
  for (const piece of pieces) {
    if (current.length && words([...current, piece].join(" ")) > maxWords) {
      parts.push(current.join("\n"));
      current = [];
    }
    current.push(piece.trim());
  }
  if (current.length) parts.push(current.join("\n"));
  return parts;
}

async function planPart(channel: Channel, video: Video, parts: string[], index: number) {
  const pictures = channel.visuals === "pictures";
  // AI pictures cost per picture, so long videos hold each one a little longer.
  const pace = video.format === "short" ? "2-3" : pictures ? "5-7" : "3-5";
  const script =
    parts.length === 1
      ? `Script:\n${parts[0]}`
      : `The whole script, for context only (keep people, places and era consistent with it):\n${video.script}\n\n` +
        `Only turn THIS PART (part ${index + 1} of ${parts.length}) into scenes:\n${parts[index]}`;
  // Recurring characters keep one look: the same description is repeated in every picture they appear in.
  const looks = allCast(channel, video).filter((c) => c.appearance);
  const castLooks = looks.length
    ? `\nCHARACTER LOOKS (when a shot shows one of these people, repeat their description word for word inside "picture" and "aiPrompt", in the same clothes and era, so they look like the same person in every shot):\n${looks
        .map((c) => `- ${speakerKey(c.name)}: ${c.appearance}`)
        .join("\n")}\nFor lines spoken by a character, prefer over-the-shoulder shots, silhouettes, hands and objects, or a reaction cutaway over a straight-on face, unless the scene is a close-up of that character.\n`
    : "";
  const prompt = `${channelBrief(channel)}

${script}
${castLooks}
Turn this script into scenes for an automatically edited ${video.format === "short" ? "vertical YouTube Short" : "horizontal YouTube video"}.
- "narration": the exact words spoken in this scene, copied from the script in order. Remove visual directions in [square brackets] and any speaker labels. Together, the scenes must contain the whole spoken script.
- "speaker": who speaks the scene. A script line that starts with a capitalised label and a colon ("JOAN: I deny it.") is spoken by that character: give it its own scene with "speaker" set to the label exactly as written ("JOAN"). Every other line is "${NARRATOR}". Never put two speakers in one scene.
- "delivery": for a character line, the cue in [square brackets] straight after the speaker label ("firm" for "JOAN: [firm] ..."), without brackets; otherwise "".
- Keep each scene to 1-2 sentences.
- "shots": the visuals for the scene, one per ${pace} seconds of speech (1-3 shots per scene), so the picture changes often like a real edit. Each shot has:
  - "search": 2-5 English words to search a stock video library (Pexels). Something filmable, concrete and atmospheric ("candle flickering in dark room", "fog rolling over pine forest", "hands turning old book pages"), not abstract ideas or names of real people. For historical stories prefer old, timeless or vintage-looking subjects and avoid modern cars, phones or modern clothes.
  - "picture": a description for an AI image generator showing exactly what the narrator is saying at that moment, in English, 25-50 words. Name the concrete subject, setting, era and place, clothing, time of day, lighting and camera framing (wide establishing shot, close-up of an object, over-the-shoulder, aerial). Be specific to the story ("Nine young hikers in 1950s wool coats and fur hats pitch a canvas tent on a bare snowy slope in the Ural Mountains at dusk, wide shot, wind blowing snow"), not generic ("a mountain"). Depict real historical people only as anonymous figures from behind or at a distance, never as recognizable portraits; no gore or dead bodies; no text.
  Vary the shots like a film editor: alternate wide shots, medium shots and close-up details (hands, objects, documents, footprints). Don't repeat the same subject twice in a row.
- "fallbackQuery": a broad 1-2 word search in case a shot finds nothing ("forest", "old paper").
- "aiPrompt": one vivid shot description for an AI video generator, in English, 30-60 words: the subject, setting and era, lighting, camera movement and mood, like a film director's shot note ("Slow dolly toward a stone lighthouse on a storm-lashed Scottish cliff, 1900, grey dawn light, waves exploding below, cinematic, desaturated, tense"). It must match the narration. No text, captions or logos; no real, named people (describe anonymous figures instead); no gore.
- "keyMoment": true for the 1-2 scenes that hold the biggest reveal or emotional peak of the whole video; false for all others${parts.length > 1 ? " (and for every scene if this part has none of them)" : ""}.`;

  const result = await generate<{ scenes: Scene[] }>(prompt, obj({
    scenes: {
      type: "array",
      items: obj({
        narration: str("Spoken words for this scene"),
        speaker: str(`${NARRATOR}, or the character's speaker label from the script`),
        delivery: str("Delivery cue for a character line, or empty"),
        shots: {
          type: "array",
          items: obj({ search: str("Stock footage search"), picture: str("AI picture description of this exact moment") }),
        },
        fallbackQuery: str("Broader stock footage search"),
        aiPrompt: str("Cinematic shot description for an AI video model"),
        keyMoment: { type: "boolean", description: "True for the biggest reveal or emotional peak" },
      }),
    },
  }));
  const speakers = new Set(scriptSpeakers(video.script));
  return result.scenes
    .map((s) => withSpeaker(s, speakers))
    .filter((s) => s.narration.trim())
    .map((s) => ({ ...s, shots: s.shots.filter((q) => q.search.trim() || q.picture.trim()).slice(0, 3) }))
    .map((s) => ({ ...s, shots: s.shots.length ? s.shots : [{ search: s.fallbackQuery, picture: s.aiPrompt }] }));
}

/**
 * Settles who speaks a planned scene. A label the AI left in the narration wins; a speaker
 * that never appears as a label in the script falls back to the narrator.
 */
function withSpeaker(scene: Scene, speakers: Set<string>): Scene {
  const parsed = parseLine(scene.narration ?? "");
  // Only strip a leading "WORD:" when it really is a speaker in this script.
  const line =
    speakers.has(parsed.speaker) || parsed.speaker === NARRATOR
      ? parsed
      : { speaker: NARRATOR, delivery: "", text: (scene.narration ?? "").trim() };
  let speaker = line.speaker !== NARRATOR ? line.speaker : speakerKey(scene.speaker || NARRATOR);
  let delivery = line.delivery || (scene.delivery ?? "").replace(/[[\]]/g, "").trim();
  if (!speakers.has(speaker)) [speaker, delivery] = [NARRATOR, ""];
  return { ...scene, narration: line.text, speaker, delivery: speaker === NARRATOR ? "" : delivery };
}

export interface SeriesEpisode {
  part: number;
  totalParts: number;
  title: string;
  hook: string;
  angle: string;
  keyword: string;
  script: string;
  visualAnchor: string;
}

/**
 * Takes any story (or user-submitted text in any language) and breaks it down into a
 * serialized, high-retention multi-part episode series for YouTube Shorts or long videos.
 */
export async function splitStoryIntoSeries(
  channel: Channel,
  storyOrTopic: string,
  partsCount: number = 3,
  format: "short" | "long" = "short",
  visualStyle?: string,
): Promise<SeriesEpisode[]> {
  const prompt = `${channelBrief(channel)}

Input Story or Topic (may be provided in any language):
"""
${storyOrTopic}
"""

You are a master viral storyteller and YouTube series director.
Take this story and turn it into a high-retention serialized ${partsCount}-part ${format === "short" ? "YouTube Shorts" : "video"} series.
Rules:
1. Translate / adapt into the channel's target language (${channel.language || "English"}), maintaining emotional depth and suspense.
2. Break the narrative cleanly across exactly ${partsCount} continuous parts:
   - Part 1: The Gripping Hook & Disruption. Introduce the central figure/mystery, set the stakes, end on a steep cliffhanger ("Follow for Part 2...").
   - Part 2 (to ${partsCount - 1}): Rising tension, unexpected twists, clues, discoveries, or failed investigations.
   - Part ${partsCount} (Finale): The terrifying climax, reveal, aftermath, and lingering question.
3. Length: Each part must be timed for ${format === "short" ? "45-55 seconds (approx 110-140 words)" : "7-10 minutes"}, written in punchy, cinematic sentences.
4. Retention & Tone:
   - Match the channel's tone: "${channel.tone || "Suspenseful, cinematic documentary storyteller"}".
   - Never use clichés like "welcome back" or "buckle up".
   - In [square brackets], include visual cues that describe the exact historical setting, characters, and atmosphere.
5. Visual Consistency ("visualAnchor"):
   - Define a shared visual anchor style (characters, lighting, era clothing, color palette) so all parts feel like they belong to the same film.
   ${visualStyle ? `User visual preference: ${visualStyle}` : ""}`;

  const result = await generate<{ series: SeriesEpisode[] }>(
    prompt,
    obj({
      series: {
        type: "array",
        items: obj({
          part: { type: "number", description: "Part index (1, 2, ...)" },
          totalParts: { type: "number", description: "Total parts in series" },
          title: str("Viral episode title with Part number, e.g. 'The Disappearance [Part 1/3]'"),
          hook: str("3-second opening hook line"),
          angle: str("The emotional angle/thesis of this episode"),
          keyword: str("Search keyword for YouTube SEO"),
          script: str("Complete spoken script for this episode including [visual cues]"),
          visualAnchor: str("Shared visual setting & aesthetic definition for this series"),
        }),
      },
    }),
  );

  return result.series;
}

