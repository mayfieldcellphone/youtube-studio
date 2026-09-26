import Anthropic from "@anthropic-ai/sdk";
import type { Channel, Research, Video } from "./db";

const MODEL = "claude-opus-5";

let client: Anthropic | undefined;
const anthropic = () => (client ??= new Anthropic());

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
Favour topics people actually search for, and ideas the creator can film themselves.
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
        hook: str("What is said or shown in the first 3 seconds"),
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

export async function generateScript(channel: Channel, video: Video) {
  const prompt = `${channelBrief(channel)}

${videoBrief(video)}
${
  video.research
    ? `\nResearch notes (base every fact on these; say "reportedly" or "some believe" for anything marked Disputed or Theory, and respect the CAUTION section):\n${video.research.notes}\n`
    : ""
}
Write the full script for this video, ready to read aloud.
- Start with the hook. No "hey guys, welcome back".
- Put filming or on-screen directions on their own line in square brackets, e.g. [Close-up of cracked screen].
- ${video.format === "short" ? "Keep it to about 130-150 spoken words." : "Use short sections with a clear payoff, and re-hook viewers every 60-90 seconds."}
- End with one natural call to action (subscribe, or watch a related video).`;

  const result = await generate<{ script: string }>(prompt, obj({ script: str("The complete script") }));
  return result.script;
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
  query: string;
  fallbackQuery: string;
}

/** Splits a script into narrated scenes, each with stock-footage search terms. */
export async function planScenes(channel: Channel, video: Video) {
  const prompt = `${channelBrief(channel)}

Script:
${video.script}

Turn this script into scenes for an automatically edited ${video.format === "short" ? "vertical YouTube Short" : "horizontal YouTube video"}.
- "narration": the exact words the narrator says in this scene, copied from the script in order. Remove anything in [square brackets] and any speaker labels. Together, the scenes must contain the whole spoken script.
- Keep each scene to 1-2 sentences (about ${video.format === "short" ? "3-6" : "6-12"} seconds of speech) so the visuals change often.
- "query": 2-4 English words to search a stock video library (Pexels) for footage that fits the scene. Describe something filmable and concrete ("old library bookshelves", "storm over ocean"), not abstract ideas or names of real people.
- "fallbackQuery": a broader 1-2 word search in case the first finds nothing ("library", "storm").`;

  const result = await generate<{ scenes: Scene[] }>(prompt, obj({
    scenes: {
      type: "array",
      items: obj({
        narration: str("Spoken words for this scene"),
        query: str("Specific stock footage search"),
        fallbackQuery: str("Broader stock footage search"),
      }),
    },
  }));
  const scenes = result.scenes.filter((s) => s.narration.trim());
  if (!scenes.length) throw new Error("The script has no spoken lines to narrate.");
  return scenes;
}
