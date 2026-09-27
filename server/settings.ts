import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DATA_DIR } from "./db";

/**
 * Keys and settings the user can enter on the Setup page. They are saved to
 * data/settings.json and override the same names from .env, so non-technical
 * users never have to edit files.
 */
export const SETTING_KEYS = [
  "ANTHROPIC_API_KEY",
  "ELEVENLABS_API_KEY",
  "GEMINI_API_KEY",
  "PEXELS_API_KEY",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "APP_URL",
  "APP_PASSWORD",
] as const;
export type SettingKey = (typeof SETTING_KEYS)[number];

/** Settings shown in full on the Setup page; everything else is secret and only hinted at. */
const PUBLIC_KEYS: SettingKey[] = ["APP_URL", "GOOGLE_CLIENT_ID"];

const FILE = path.join(DATA_DIR, "settings.json");

function read(): Record<string, string> {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    return {};
  }
}

function write(data: Record<string, string>) {
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
}

const LOOKS_LIKE: [RegExp, string][] = [
  [/^sk-ant-/, "a Claude (Anthropic) key"],
  [/^AIza/, "a Google / Gemini (AI Studio) key"],
  [/^sk_[0-9a-f]{20,}/i, "an ElevenLabs key"],
  [/^GOCSPX-/, "a Google Client secret"],
  [/\.apps\.googleusercontent\.com$/, "a Google Client ID"],
];
const EXPECTED: Partial<Record<SettingKey, { pattern: RegExp; name: string; box: string }>> = {
  ANTHROPIC_API_KEY: { pattern: /^sk-ant-/, name: "a Claude (Anthropic) key", box: "1. AI writing (Claude)" },
  GEMINI_API_KEY: { pattern: /^AIza/, name: "a Google / Gemini (AI Studio) key", box: "2a. Gemini voice" },
  ELEVENLABS_API_KEY: { pattern: /^sk_/, name: "an ElevenLabs key", box: "2b. ElevenLabs voice" },
  GOOGLE_CLIENT_ID: { pattern: /\.apps\.googleusercontent\.com$/, name: "a Google Client ID", box: "4. YouTube (Client ID)" },
  GOOGLE_CLIENT_SECRET: { pattern: /^GOCSPX-/, name: "a Google Client secret", box: "4. YouTube (Client secret)" },
};

/** Explains a key that was pasted into the wrong box, or undefined if it looks right. */
export function wrongBox(key: SettingKey, value: string) {
  const expected = EXPECTED[key];
  if (!expected || !value || expected.pattern.test(value)) return undefined;
  const actual = LOOKS_LIKE.find(([pattern]) => pattern.test(value))?.[1];
  if (!actual) return undefined; // Unknown format: let the service itself judge it.
  const home = Object.values(EXPECTED).find((e) => e!.name === actual)?.box;
  return `This looks like ${actual}, not ${expected.name}.${home ? ` Paste it in the "${home}" box instead.` : ""}`;
}

/** Saved keys that are in the wrong box (e.g. a Gemini key saved as the Claude key). */
export function keyProblems() {
  return SETTING_KEYS.flatMap((key) => {
    const problem = wrongBox(key, process.env[key] ?? "");
    return problem ? [`${EXPECTED[key]!.box}: ${problem}`] : [];
  });
}

/** Loads saved settings into process.env. Also creates the login-cookie secret on first run. */
export function loadSettings() {
  const saved = read();
  for (const key of SETTING_KEYS) {
    if (saved[key]) process.env[key] = saved[key];
  }
  if (!process.env.SESSION_SECRET) {
    saved.SESSION_SECRET ??= crypto.randomBytes(32).toString("hex");
    write(saved);
    process.env.SESSION_SECRET = saved.SESSION_SECRET;
  }
}

/** Saves settings; an empty string clears one. Takes effect immediately. */
export function saveSettings(values: Partial<Record<SettingKey, string>>) {
  const saved = read();
  for (const key of SETTING_KEYS) {
    const value = values[key];
    if (value === undefined) continue;
    const trimmed = value.trim();
    if (trimmed) {
      saved[key] = trimmed;
      process.env[key] = trimmed;
    } else {
      delete saved[key];
      delete process.env[key];
    }
  }
  write(saved);
}

/** What the Setup page may see: public values in full, secrets as "set" plus their last 4 characters. */
export function describeSettings() {
  return Object.fromEntries(
    SETTING_KEYS.map((key) => {
      const value = process.env[key] ?? "";
      if (PUBLIC_KEYS.includes(key)) return [key, { set: Boolean(value), value }];
      return [key, { set: Boolean(value), hint: value && key !== "APP_PASSWORD" ? `…${value.slice(-4)}` : "" }];
    }),
  );
}
