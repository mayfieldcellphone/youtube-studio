import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { db, UPLOAD_DIR, type CastMember } from "./db";
import { makePortrait } from "./images";
import { geminiConfigured } from "./voices";
import { speakerKey } from "./speakers";

export type Orientation = "landscape" | "portrait";

const find = (cast: CastMember[] | undefined, name: string) => cast?.find((c) => speakerKey(c.name) === speakerKey(name));

/**
 * The painted portrait of one of a video's characters for 16:9 (landscape) or 9:16 (portrait)
 * videos, painting it first if needed. The second shape is painted from the first, so the
 * face and costume match. `regenerate` paints a new one and drops the other shape.
 */
export async function ensurePortrait(videoId: string, name: string, orientation: Orientation, regenerate = false) {
  const member = find(db.video(videoId)?.cast, name);
  if (!member) throw new Error(`${name} isn't one of this video's characters.`);
  const existing = member.portraits?.[orientation];
  if (existing && fs.existsSync(existing) && !regenerate) return existing;
  if (!geminiConfigured()) throw new Error("Portraits are painted with Gemini. Add your Gemini key (with billing) on the Setup page.");

  const other = member.portraits?.[orientation === "landscape" ? "portrait" : "landscape"];
  const reference = !regenerate && other && fs.existsSync(other) ? other : undefined;
  const appearance = member.appearance?.trim() || member.role?.trim() || `a person from the story called ${member.name}`;
  const file = await makePortrait(appearance, orientation === "portrait", path.join(UPLOAD_DIR, `portrait-${crypto.randomUUID()}`), reference);

  // Re-read: the cast may have changed while the picture was being painted.
  const video = db.video(videoId);
  const current = find(video?.cast, name);
  if (!video || !current) {
    fs.rmSync(file, { force: true });
    throw new Error(`${name} was removed from this video.`);
  }
  const replaced = regenerate ? Object.values(current.portraits ?? {}) : [current.portraits?.[orientation]];
  const portraits = { ...(regenerate ? {} : current.portraits), [orientation]: file };
  db.updateVideo(videoId, { cast: video.cast!.map((c) => (c === current ? { ...c, portraits } : c)) });
  for (const old of replaced) if (old && old !== file) fs.rm(old, { force: true }, () => {});
  return file;
}

/** The saved portrait file for a character, if there is one. */
export function portraitFile(videoId: string, name: string, orientation: Orientation) {
  const file = find(db.video(videoId)?.cast, name)?.portraits?.[orientation];
  return file && fs.existsSync(file) ? file : undefined;
}
