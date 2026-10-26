import assert from "node:assert/strict";
import test from "node:test";
import type { Channel } from "../db";
import { buildCompilation, cleanThumbBrief, demandVerdict, nextSlot } from "../policy";

const channel: Channel = {
  id: "c1", name: "History's Shadows", niche: "", audience: "", tone: "", language: "English",
  postingDays: [], postingTime: "17:00", categoryId: "22", createdAt: "", lane: "history", timeZone: "Australia/Sydney",
} as Channel;

test("a trend date in the future pushes the slot to the first 7pm Sydney slot after it", () => {
  const from = new Date("2026-10-26T01:00:00Z");
  const plain = nextSlot(channel, { id: "a", format: "short" }, [], from);
  const trendy = nextSlot(channel, { id: "a", format: "short", trendAt: "2026-11-05T00:00:00Z" }, [], from);
  assert.ok(trendy.getTime() > plain.getTime());
  assert.ok(trendy.getTime() > Date.parse("2026-11-05T00:00:00Z"));
  assert.ok(trendy.getTime() - Date.parse("2026-11-05T00:00:00Z") < 36 * 3_600_000);
});

test("a past trend date does not change the slot", () => {
  const from = new Date("2026-10-26T01:00:00Z");
  const plain = nextSlot(channel, { id: "a", format: "short" }, [], from);
  const old = nextSlot(channel, { id: "a", format: "short", trendAt: "2026-10-01T00:00:00Z" }, [], from);
  assert.equal(old.getTime(), plain.getTime());
});

test("demandVerdict separates gap, crowded and open", () => {
  assert.equal(demandVerdict({ recentUploads: 2, topRecentViews: 5000, topViews: 400_000 }).verdict, "gap");
  assert.equal(demandVerdict({ recentUploads: 15, topRecentViews: 90_000, topViews: 900_000 }).verdict, "crowded");
  assert.equal(demandVerdict({ recentUploads: 1, topRecentViews: 100, topViews: 900 }).verdict, "open");
  assert.equal(demandVerdict({ recentUploads: -1, topRecentViews: 0, topViews: -1 }).verdict, "unknown");
});

test("cleanThumbBrief limits each line to 4 words and rejects empty briefs", () => {
  const b = cleanThumbBrief({ top: "this was never in the books", bottom: "it was real", emotion: "shock", visual: "the bezoar stone" });
  assert.equal(b?.top, "THIS WAS NEVER IN");
  assert.equal(b?.bottom, "IT WAS REAL");
  assert.equal(cleanThumbBrief({ top: "", bottom: "x", visual: "y" }), undefined);
  assert.equal(cleanThumbBrief(null), undefined);
});

test("buildCompilation needs 3 episodes and keeps their ids", () => {
  const ep = (i: number) => ({ id: `v${i}`, title: `T${i}`, seriesSubject: `Name${i}`, angle: "" });
  assert.throws(() => buildCompilation("Hogwarts vs History", [ep(1), ep(2)]), /at least 3/);
  const c = buildCompilation("Hogwarts vs History", [ep(1), ep(2), ep(3)]);
  assert.deepEqual(c.sourceIds, ["v1", "v2", "v3"]);
  assert.match(c.title, /3 Cases/);
  assert.match(c.angle, /Name1, Name2 and Name3/);
});
