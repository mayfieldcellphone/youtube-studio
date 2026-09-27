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
  const prompt = `${channelBrief(channel)}

Come up with ${count} new video ideas for this channel. Mix YouTube Shorts and long-form videos (about 2 Shorts for every long video).
What makes an idea strong:
- A proven topic: people already search for it or it has gone viral for other channels, but this idea has a fresh angle.
- One specific, surprising detail at its core (a name, number, object, date or twist). "The lighthouse keepers who vanished and left dinner on the table" beats "Mysterious disappearances".
- A curiosity gap the title opens and the video pays off honestly. No clickbait the video can't deliver.
- Strong emotion: awe, dread, outrage, disbelief, or "wait, that's real?".
- Can be made with narration and stock footage or photos (no filming required).
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
        angle: str("One sentence: what makes this video different or worth watching"),
      }),
    },
  }));
  return result.ideas.slice(0, count);
}

/**
 * Researches a video topic on the web and returns notes plus the sources used,
 * so scripts are built on checked facts instead of the model's memory.
 */
export async function research(channel: Channel, video: Video): Promise<Omit<Research, "createdAt">> {
  const prompt = `${channelBrief(channel)}

${videoBrief(video)}

Research this video topic on the web so a scriptwriter can write an accurate, gripping script.
Write research notes in plain text (no URLs; sources are listed separately):
- KEY FACTS: the most important facts. Start each line with [Confirmed], [Disputed] or [Theory].
- TIMELINE: dates and events in order, if the topic has one.
- SURPRISING DETAILS: 3-6 details most viewers won't know. These make the best hooks.
- OPEN QUESTIONS: what is still unknown or debated.
- CAUTION: anything that must not be stated as fact (e.g. accusations against real people who were never convicted).
Use reliable sources: official records, major news outlets, museums, universities, encyclopedias. Keep it under 900 words.`;

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
      tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 8 }],
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

/** Techniques that keep viewers watching; shared by the writer and the editor pass. */
function scriptCraft(video: Video) {
  const shape =
    video.format === "short"
      ? `SHORT (vertical, 35-55 seconds, about 110-140 spoken words):
- Line 1 is the hook: the single most surprising, specific detail, stated in under 12 words. No scene-setting, no "Did you know", no question as the opener.
- Every following sentence adds new information or raises the stakes. Cut anything that repeats or explains the obvious.
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

First, list the biggest problems briefly: weak hook, slow or generic lines, clichés, vague statements, missing tension, facts not supported by the research, lines that are hard to say aloud.
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
  /** One stock-footage search per shot; the scene's time is split between them. */
  shots: string[];
  fallbackQuery: string;
}

/** Splits a script into narrated scenes, each with stock-footage search terms. */
export async function planScenes(channel: Channel, video: Video) {
  const prompt = `${channelBrief(channel)}

Script:
${video.script}

Turn this script into scenes for an automatically edited ${video.format === "short" ? "vertical YouTube Short" : "horizontal YouTube video"}.
- "narration": the exact words the narrator says in this scene, copied from the script in order. Remove anything in [square brackets] and any speaker labels. Together, the scenes must contain the whole spoken script.
- Keep each scene to 1-2 sentences.
- "shots": the visuals for the scene, one per ${video.format === "short" ? "2-3" : "3-5"} seconds of speech (1-3 shots per scene), so the picture changes often like a real edit.
  Each shot is 2-5 English words to search a stock video library (Pexels). Describe something filmable, concrete and atmospheric ("candle flickering in dark room", "fog rolling over pine forest", "hands turning old book pages"), not abstract ideas or names of real people.
  Match the mood and era of the story: for historical stories prefer old, timeless or vintage-looking subjects (ruins, candles, old documents, stone, fog, black and white) and avoid modern cars, phones or people in modern clothes.
  Vary the shots: mix wide establishing shots, close-up details and moody textures. Don't repeat the same subject.
- "fallbackQuery": a broad 1-2 word search in case a shot finds nothing ("forest", "old paper").
- "aiPrompt": one vivid shot description for an AI video generator, in English, 30-60 words: the subject, setting and era, lighting, camera movement and mood, like a film director's shot note ("Slow dolly toward a stone lighthouse on a storm-lashed Scottish cliff, 1900, grey dawn light, waves exploding below, cinematic, desaturated, tense"). It must match the narration. No text, captions or logos; no real, named people (describe anonymous figures instead); no gore.
- "keyMoment": true for the 1-2 scenes that hold the biggest reveal or emotional peak; false for all others.`;

  const result = await generate<{ scenes: Scene[] }>(prompt, obj({
    scenes: {
      type: "array",
      items: obj({
        narration: str("Spoken words for this scene"),
        shots: { type: "array", items: str("Stock footage search for one shot") },
        fallbackQuery: str("Broader stock footage search"),
        aiPrompt: str("Cinematic shot description for an AI video model"),
        keyMoment: { type: "boolean", description: "True for the biggest reveal or emotional peak" },
      }),
    },
  }));
  const scenes = result.scenes
    .filter((s) => s.narration.trim())
    .map((s) => ({ ...s, shots: s.shots.filter((q) => q.trim()).slice(0, 3) }))
    .map((s) => ({ ...s, shots: s.shots.length ? s.shots : [s.fallbackQuery] }));
  if (!scenes.length) throw new Error("The script has no spoken lines to narrate.");
  return scenes;
}
