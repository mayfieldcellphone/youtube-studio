import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./db";

/**
 * Keeps AI footage (Google Veo) inside a monthly dollar budget.
 *
 * - Every successful clip is written to a small ledger (data/ai-spend.json).
 * - Before a video's clips are made, the plan is checked against what is left this month:
 *   clips are stepped down to the cheapest model first, then the least important ones are
 *   dropped (the video maker then uses stock footage for those shots).
 * - Hook and key-moment shots get the better model; filler shots get the cheap one.
 */

export type Tier = "lite" | "fast" | "best";

/**
 * Per-second prices used for the budget. They are deliberately on the high side (Google's
 * list prices change and differ by resolution), so the budget errs towards safe.
 */
export const PRICE_PER_SECOND: Record<Tier, number> = { lite: 0.08, fast: 0.15, best: 0.4 };

/** Used until a budget is saved on the Setup page. */
export const DEFAULT_MONTHLY_CAP_USD = 40;

/** How many shots at the start of a video count as important: the hook and up to two key moments. */
export const KEY_SHOTS = 3;

const LEDGER = () => path.join(DATA_DIR, "ai-spend.json");
const EPSILON = 1e-9;

/** The monthly budget in USD: the Setup page value, else the default. 0 switches AI footage off. */
export function monthlyCapUsd() {
  const raw = (process.env.AI_FOOTAGE_MONTHLY_CAP_USD ?? "").trim();
  if (!raw) return DEFAULT_MONTHLY_CAP_USD;
  const value = Number(raw.replace(/^\$/, ""));
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_MONTHLY_CAP_USD;
}

/** Which model tier a shot should use. `index` counts AI shots in the video, hook first. */
export function tierFor(quality: Tier, index: number): Tier {
  if (quality === "lite") return "lite";
  if (index >= KEY_SHOTS) return "lite";
  // "Best" is kept for the opening hook only; other key moments use Fast.
  return quality === "best" && index === 0 ? "best" : "fast";
}

/**
 * Fits a list of wanted clips (most important first) into the money left. First the dearest
 * clips from the end are stepped down to `floor` (the cheapest model that exists), then the
 * least important clips are dropped (null). Returns the tier to use per clip, or null to skip it.
 */
export function planBudget(wanted: Tier[], seconds: number, remainingUsd: number, floor: Tier = "lite"): (Tier | null)[] {
  const plan: (Tier | null)[] = [...wanted];
  const total = () => plan.reduce<number>((sum, tier) => sum + (tier ? seconds * PRICE_PER_SECOND[tier] : 0), 0);
  for (let i = plan.length - 1; i >= 0 && total() > remainingUsd + EPSILON; i--) {
    const tier = plan[i];
    if (tier && PRICE_PER_SECOND[tier] > PRICE_PER_SECOND[floor]) plan[i] = floor;
  }
  for (let i = plan.length - 1; i >= 0 && total() > remainingUsd + EPSILON; i--) plan[i] = null;
  return plan;
}

interface Entry {
  at: string;
  usd: number;
  tier: Tier;
  model: string;
}

function read(): Entry[] {
  try {
    const data = JSON.parse(fs.readFileSync(LEDGER(), "utf8"));
    return Array.isArray(data.entries) ? data.entries : [];
  } catch {
    return [];
  }
}

/** Calendar month, in the time zone the budget follows (BUDGET_TIME_ZONE, default Australia/Sydney). */
export function monthKey(date: Date) {
  const timeZone = process.env.BUDGET_TIME_ZONE || "Australia/Sydney";
  try {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit" }).formatToParts(date);
    return `${parts.find((p) => p.type === "year")?.value}-${parts.find((p) => p.type === "month")?.value}`;
  } catch {
    return date.toISOString().slice(0, 7);
  }
}

/** Records the cost of a clip that was made. */
export function recordSpend(usd: number, info: { tier: Tier; model: string }, now = new Date()) {
  // Keep about a year of history so the file stays tiny.
  const keep = read().filter((e) => Date.now() - Date.parse(e.at) < 400 * 24 * 3600 * 1000);
  keep.push({ at: now.toISOString(), usd, ...info });
  const tmp = `${LEDGER()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ entries: keep }, null, 2));
  fs.renameSync(tmp, LEDGER());
}

export function budgetStatus(now = new Date()) {
  const month = monthKey(now);
  const spentUsd = read()
    .filter((e) => monthKey(new Date(e.at)) === month)
    .reduce((sum, e) => sum + e.usd, 0);
  const capUsd = monthlyCapUsd();
  return { month, capUsd, spentUsd, remainingUsd: Math.max(0, capUsd - spentUsd) };
}

/** Why a shot was left to stock footage, worded for the "notes" on a made video. */
export function budgetNote() {
  const { capUsd, spentUsd } = budgetStatus();
  return `Monthly AI footage budget reached ($${spentUsd.toFixed(2)} of $${capUsd.toFixed(2)} used). Raise it on the Setup page if you want more AI shots.`;
}
