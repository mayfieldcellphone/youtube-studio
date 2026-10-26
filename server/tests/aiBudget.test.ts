import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The ledger lives in DATA_DIR, so point it at a temp folder before the module loads.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-budget-"));
process.env.DATA_DIR = dir;
const budget = await import("../aiBudget");

const SECONDS = 8;
const price = budget.PRICE_PER_SECOND;

test("hook and key moments use Fast, filler uses Lite", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 11].map((i) => budget.tierFor("fast", i)), ["fast", "fast", "fast", "lite", "lite", "lite"]);
});

test("Best is kept for the opening hook only", () => {
  assert.deepEqual([0, 1, 2, 3].map((i) => budget.tierFor("best", i)), ["best", "fast", "fast", "lite"]);
});

test("Lite quality makes everything Lite", () => {
  assert.deepEqual([0, 1, 5].map((i) => budget.tierFor("lite", i)), ["lite", "lite", "lite"]);
});

test("a plan that fits is left alone", () => {
  const wanted = ["fast", "fast", "lite"] as const;
  assert.deepEqual(budget.planBudget([...wanted], SECONDS, 100), [...wanted]);
});

test("when money is short, the last clips step down to Lite first", () => {
  const wanted = ["fast", "fast", "fast"] as const;
  // Enough for one Fast + two Lite, not for three Fast.
  const remaining = SECONDS * (price.fast + 2 * price.lite) + 0.001;
  assert.deepEqual(budget.planBudget([...wanted], SECONDS, remaining), ["fast", "lite", "lite"]);
});

test("when even Lite doesn't fit, the least important clips are dropped", () => {
  const wanted = ["fast", "fast", "lite", "lite"] as const;
  const remaining = SECONDS * price.lite * 2 + 0.001; // two Lite clips' worth
  assert.deepEqual(budget.planBudget([...wanted], SECONDS, remaining), ["lite", "lite", null, null]);
});

test("no money left skips every clip", () => {
  assert.deepEqual(budget.planBudget(["fast", "lite"], SECONDS, 0), [null, null]);
});

test("if no Lite model exists, clips can't step down and are dropped instead", () => {
  // The cheapest available model is Fast, so stepping down saves nothing.
  const remaining = SECONDS * price.fast + 0.001;
  assert.deepEqual(budget.planBudget(["fast", "fast"], SECONDS, remaining, "fast"), ["fast", null]);
});

test("the default monthly budget applies until one is saved", () => {
  delete process.env.AI_FOOTAGE_MONTHLY_CAP_USD;
  assert.equal(budget.monthlyCapUsd(), budget.DEFAULT_MONTHLY_CAP_USD);
  process.env.AI_FOOTAGE_MONTHLY_CAP_USD = "75";
  assert.equal(budget.monthlyCapUsd(), 75);
  process.env.AI_FOOTAGE_MONTHLY_CAP_USD = "$12.50";
  assert.equal(budget.monthlyCapUsd(), 12.5);
  process.env.AI_FOOTAGE_MONTHLY_CAP_USD = "0";
  assert.equal(budget.monthlyCapUsd(), 0);
  process.env.AI_FOOTAGE_MONTHLY_CAP_USD = "lots";
  assert.equal(budget.monthlyCapUsd(), budget.DEFAULT_MONTHLY_CAP_USD);
  delete process.env.AI_FOOTAGE_MONTHLY_CAP_USD;
});

test("spend is added up per calendar month and reduces what's left", () => {
  process.env.AI_FOOTAGE_MONTHLY_CAP_USD = "10";
  process.env.BUDGET_TIME_ZONE = "Australia/Sydney";
  const now = new Date("2026-10-15T03:00:00Z");
  budget.recordSpend(1.2, { tier: "fast", model: "veo-x-fast" }, now);
  budget.recordSpend(0.64, { tier: "lite", model: "veo-x-lite" }, now);
  // Last month's spend doesn't count.
  budget.recordSpend(5, { tier: "best", model: "veo-x" }, new Date("2026-09-20T03:00:00Z"));
  const status = budget.budgetStatus(now);
  assert.equal(status.month, "2026-10");
  assert.equal(Number(status.spentUsd.toFixed(2)), 1.84);
  assert.equal(Number(status.remainingUsd.toFixed(2)), 8.16);
});

test("month boundaries follow the budget time zone, not UTC", () => {
  process.env.BUDGET_TIME_ZONE = "Australia/Sydney";
  // 31 Oct 14:30 UTC is already 1 Nov in Sydney.
  assert.equal(budget.monthKey(new Date("2026-10-31T14:30:00Z")), "2026-11");
  assert.equal(budget.monthKey(new Date("2026-10-31T10:00:00Z")), "2026-10");
});

test("the remaining budget never goes below zero", () => {
  process.env.AI_FOOTAGE_MONTHLY_CAP_USD = "1";
  const now = new Date("2026-10-15T03:00:00Z");
  assert.equal(budget.budgetStatus(now).remainingUsd, 0);
});
