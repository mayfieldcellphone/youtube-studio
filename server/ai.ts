import Anthropic from "@anthropic-ai/sdk";
import type { Channel, Research, Video } from "./db";

const MODEL = "claude-opus-5";

let client: Anthropic | undefined;
let clientKey: string | undefined;
/** Recreated when the key changes on the Setup page. */
const anthropic = () => {
  if (!client || clientKey !== process.env.ANTHROPIC_API_KEY) {
    clientKey = process.env.ANTHROPIC_API_KEY;
    client = new Anthropic({ apiKey: clientKey });
  }
  return client;
};

export const aiConfigured = () => Boolean(process.env.ANTHROPIC_API_KEY);

const SYSTEM = `You are a YouTube strategist and scriptwriter who grows channels that earn money.
You know what makes people click (specific, curiosity-driven titles that tell the truth) and what makes them keep watching (a hook in the first 3 seconds, fast pacing, payoff that matches the title).
YouTube demonetizes mass-produced, repetitive or low-effort content, so every idea and script must have a real point of view, practical value or first-hand experience the creator can add. Never invent statistics, quotes or facts you are not sure of.
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
    `Format: ${video.format === "short" ? "YouTube Short (vertical, under 60 seconds)" : "Long-form video (8-12 minutes)"}`,
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

/** Calls Claude with a JSON schema and returns the parsed result. */
async function generate<T>(prompt: string, schema: Schema): Promise<T> {
  const response = await anthropic().beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    // If the model declines, the API retries on Anthropic's recommended fallback model.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: SYSTEM,
    output_config: { format: { type: "json_schema", schema } },
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

export interface Idea {
  title: string;
  hook: string;
  format: "short" | "long";
  keyword: string;
  angle: string;
}

export async function generateIdeas(channel: Channel, count: number, existingTitles: string[], focus?: string) {
  const trends = await scanTrends(channel, focus);
  const prompt = `${channelBrief(channel)}
${trends ? `\nWhat is getting attention right now (from a web search today):\n${trends}\n` : ""}
Come up with ${count} new video ideas for this channel. Mix YouTube Shorts and long-form videos (about 2 Shorts for every long video).
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
  return result.ideas.slice(0, count);
}

/** Lets Claude search the web, then returns its final written answer and the sources it used. */
async function searchWeb(prompt: string, maxSearches: number): Promise<Omit<Research, "createdAt">> {
  // Web search runs on Anthropic's servers; a long search can pause, and is resumed by
  // sending back everything the model produced so far.
  const content: Anthropic.Beta.BetaContentBlock[] = [];
  let response: Anthropic.Beta.BetaMessage | undefined;
  for (let i = 0; i < 5; i++) {
    const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: prompt }];
    if (content.length) messages.push({ role: "assistant", content });
    response = await anthropic().beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: SYSTEM,
      tools: [{ type: "web_search_20260209", name: "web_search", max_uses: maxSearches }],
      messages,
    });
    content.push(...response.content);
    if (response.stop_reason !== "pause_turn") break;
  }
  if (!response) throw new Error("Research failed.");
  if (response.stop_reason === "refusal") throw new Error("The AI declined to research this topic.");
  if (response.stop_reason === "pause_turn") throw new Error("Research took too long. Try again.");

  // Only the final answer's text counts; earlier text is the model narrating its searches.
  const lastSearch = content.map((b) => b.type).lastIndexOf("web_search_tool_result");
  const answer = content.slice(lastSearch + 1);
  const notes = answer.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
  if (!notes) throw new Error("Research returned no notes. Try again.");

  // Prefer the sources the notes actually cite; fall back to everything the search returned.
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
function scriptCraft(video: Video) {
  const shape =
    video.format === "short"
      ? `SHORT (vertical, 35-55 seconds, about 110-140 spoken words):
- Line 1 is the hook: the single most surprising, specific detail, stated in under 12 words. It must make sense instantly to someone who knows nothing about the story, and open a question they need answered. No scene-setting, no "Did you know", no question as the opener.
- Follow ONE thread. A Short has room for one mystery and one payoff; cut side details, however interesting.
- Every following sentence adds new information or raises the stakes. Cut anything that repeats or explains the obvious.
- Halfway through, re-hook with a line that raises a new question ("But the note in his pocket was stranger.").
- Build to one twist or reveal near the end.
- The last line should connect back to the first so the Short loops smoothly. No "subscribe for more" (a 3-word CTA at most, or none).`
      : `LONG VIDEO (8-11 minutes, about 1,300-1,700 spoken words):
- Cold open (first 20-30 seconds): drop straight into the most dramatic moment of the story, then cut away with a question the video will answer.
- Promise: one sentence on what the viewer will know by the end.
- 3-5 chapters. Each chapter reveals something new and ends on an open loop or cliffhanger that pulls into the next ("But that wasn't the strangest part.").
- Around 40% in, one short natural call to subscribe, tied to the story.
- Climax: the biggest reveal. Then resolution: what we know, what is still unknown, and why it matters.
- Final line teases a related story to watch next.`;

  return `${shape}

VOICE AND STYLE (this is narration for a voiceover, so write for the ear):
- Short sentences. Mix in a longer one for rhythm. One idea per sentence.
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

export async function generateScript(channel: Channel, video: Video) {
  const research = video.research
    ? `\nResearch notes (base every fact on these; say "reportedly" or "some believe" for anything marked Disputed or Theory, and respect the CAUTION section):\n${video.research.notes}\n`
    : "";

  const draft = await generate<{ script: string }>(
    `${channelBrief(channel)}

${videoBrief(video)}
${research}
Write the full narration script for this video, ready to be read aloud by a voiceover.

${scriptCraft(video)}`,
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
Then rewrite the whole script to fix them. Keep every fact accurate, keep it the right length, and make every line earn its place.

The standard it must meet:
${scriptCraft(video)}`,
    obj({ problems: str("Short list of what was wrong"), script: str("The improved complete script") }),
  );
  return edited.script;
}

export interface Metadata {
  titles: string[];
  description: string;
  tags: string[];
}

export async function generateMetadata(channel: Channel, video: Video) {
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

export interface Scene {
  narration: string;
  /** A cinematic shot description for an AI video model (Veo). */
  aiPrompt: string;
  /** The biggest reveal or emotional peak of the video. */
  keyMoment: boolean;
  /** The scene's shots; its time is split between them. */
  shots: Shot[];
  fallbackQuery: string;
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
  const parts = splitScript(video.script, 250);
  const planned: Scene[][] = new Array(parts.length);
  let next = 0;
  const worker = async () => {
    while (next < parts.length) {
      const i = next++;
      planned[i] = await planPart(channel, video, parts, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, parts.length) }, worker));
  const scenes = planned.flat();
  if (!scenes.length) throw new Error("The script has no spoken lines to narrate.");
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
  const prompt = `${channelBrief(channel)}

${script}

Turn this script into scenes for an automatically edited ${video.format === "short" ? "vertical YouTube Short" : "horizontal YouTube video"}.
- "narration": the exact words the narrator says in this scene, copied from the script in order. Remove anything in [square brackets] and any speaker labels. Together, the scenes must contain the whole spoken script.
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
  return result.scenes
    .filter((s) => s.narration.trim())
    .map((s) => ({ ...s, shots: s.shots.filter((q) => q.search.trim() || q.picture.trim()).slice(0, 3) }))
    .map((s) => ({ ...s, shots: s.shots.length ? s.shots : [{ search: s.fallbackQuery, picture: s.aiPrompt }] }));
}
