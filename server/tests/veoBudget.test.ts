import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Ledger and downloads go to a temp folder; Google is replaced by a fake fetch.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "veo-budget-"));
process.env.DATA_DIR = dir;
process.env.GEMINI_API_KEY = "AIza-test";
const budget = await import("../aiBudget");
const veo = await import("../veo");

const MODELS = ["models/veo-3.1-generate-preview", "models/veo-3.1-fast-generate-preview", "models/veo-3.1-lite-generate-preview"];

/** Fakes the Gemini API; `used` records which model made each clip. */
function fakeGoogle(models: string[] = MODELS) {
  const used: string[] = [];
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input);
    if (url.includes("/models?pageSize")) {
      return Response.json({ models: models.map((name) => ({ name, supportedGenerationMethods: ["predictLongRunning"] })) });
    }
    const start = /\/models\/([^:]+):predictLongRunning/.exec(url);
    if (start) {
      used.push(start[1]);
      return Response.json({ name: `operations/${used.length}` });
    }
    if (url.includes("/operations/")) {
      return Response.json({ done: true, response: { generatedSamples: [{ video: { uri: "https://files.test/clip.mp4" } }] } });
    }
    if (url === "https://files.test/clip.mp4") return new Response("video-bytes");
    throw new Error(`Unexpected request ${url} ${init?.method ?? ""}`);
  }) as typeof fetch;
  return used;
}

const requests = (n: number) => Array.from({ length: n }, (_, i) => ({ prompt: `shot ${i}`, outFile: path.join(dir, `clip-${i}.mp4`) }));
const resetLedger = () => {
  fs.rmSync(path.join(dir, "ai-spend.json"), { force: true });
  veo.forgetModels();
};

test("hook and key moments use Fast, filler uses Lite, and the spend is recorded", async () => {
  resetLedger();
  process.env.AI_FOOTAGE_MONTHLY_CAP_USD = "100";
  const used = fakeGoogle();
  const results = await veo.makeClips(requests(5), "fast", true, () => {});
  assert.deepEqual(results, [true, true, true, true, true]);
  assert.equal(used.filter((m) => m.includes("fast")).length, 3);
  assert.equal(used.filter((m) => m.includes("lite")).length, 2);
  assert.equal(used.filter((m) => !m.includes("fast") && !m.includes("lite")).length, 0, "the Quality model is never used by default");
  assert.equal(Number(budget.budgetStatus().spentUsd.toFixed(2)), 4.88); // 3 x 8s x $0.15 + 2 x 8s x $0.08
});

test("a tight budget moves clips to Lite and skips the rest, with a note for stock fallback", async () => {
  resetLedger();
  process.env.AI_FOOTAGE_MONTHLY_CAP_USD = "3";
  const used = fakeGoogle();
  const results = await veo.makeClips(requests(5), "fast", true, () => {});
  assert.deepEqual(results.slice(0, 4), [true, true, true, true]);
  assert.match(String(results[4]), /Monthly AI footage budget reached/);
  assert.ok(used.every((m) => m.includes("lite")), "every clip stepped down to Lite");
  assert.ok(budget.budgetStatus().spentUsd <= 3 + 1e-9, "never spends past the budget");
});

test("a spent budget makes no Google calls for clips", async () => {
  resetLedger();
  process.env.AI_FOOTAGE_MONTHLY_CAP_USD = "0";
  const used = fakeGoogle();
  const results = await veo.makeClips(requests(2), "fast", false, () => {});
  assert.equal(used.length, 0);
  assert.ok(results.every((r) => typeof r === "string" && /budget/i.test(r)));
});

test("Best quality is used only for the opening hook", async () => {
  resetLedger();
  process.env.AI_FOOTAGE_MONTHLY_CAP_USD = "100";
  const used = fakeGoogle();
  await veo.makeClips(requests(3), "best", true, () => {});
  assert.equal(used.length, 3);
  assert.ok(!used[0].includes("fast") && !used[0].includes("lite"));
  assert.ok(used.slice(1).every((m) => m.includes("fast")));
});

test("with no Lite model, filler uses Fast and is costed as Fast", async () => {
  resetLedger();
  process.env.AI_FOOTAGE_MONTHLY_CAP_USD = "100";
  const used = fakeGoogle(MODELS.filter((m) => !m.includes("lite")));
  await veo.makeClips(requests(4), "fast", true, () => {});
  assert.ok(used.every((m) => m.includes("fast")));
  assert.equal(Number(budget.budgetStatus().spentUsd.toFixed(2)), 4.8); // 4 x 8s x $0.15
});

test("if Veo isn't available the shots fall back with a clear reason", async () => {
  resetLedger();
  fakeGoogle([]);
  const results = await veo.makeClips(requests(2), "fast", true, () => {});
  assert.ok(results.every((r) => typeof r === "string" && r.startsWith("AI footage unavailable")));
});
