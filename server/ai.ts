import Anthropic from "@anthropic-ai/sdk";
import type { Channel, Video } from "./db";

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

export async function generateScript(channel: Channel, video: Video) {
  const prompt = `${channelBrief(channel)}

${videoBrief(video)}

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
- 10-15 tags, most specific first.`;

  return generate<Metadata>(prompt, obj({
    titles: { type: "array", items: str("Title option") },
    description: str("Full video description"),
    tags: { type: "array", items: str("Tag without #") },
  }));
}
