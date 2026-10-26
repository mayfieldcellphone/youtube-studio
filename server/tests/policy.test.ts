import assert from "node:assert/strict";
import test from "node:test";
import type { Channel, Video } from "../db";
import {
  analyticsDue,
  analyticsFlag,
  assertLaneMatches,
  assertSlotFree,
  assertVariation,
  buildDescription,
  buildTags,
  checkShortScript,
  dayKey,
  finalTitle,
  nextSlot,
  pickVariation,
  zonedTime,
} from "../policy";

const channel = (o: Partial<Channel> = {}): Channel => ({
  id: "c1", name: "History's Shadows", niche: "", audience: "", tone: "", language: "English",
  postingDays: [], postingTime: "17:00", categoryId: "22", createdAt: "", ...o,
});
let n = 0;
const video = (o: Partial<Video> = {}): Video => ({
  id: `v${++n}`, channelId: "c1", status: "idea", format: "short", title: "Test", hook: "", keyword: "", angle: "",
  script: "", titleOptions: [], description: "", tags: [], createdAt: "2026-10-01T00:00:00Z", updatedAt: "", ...o,
});

test("series titles follow the Hogwarts vs History pattern and Shorts stay under 60 characters", () => {
  const t = finalTitle(video({ series: "Hogwarts vs History", title: "The Real Nicolas Flamel: Harry Potter Got Him Completely Wrong" }));
  assert.equal(t, "The Real Nicolas Flamel: What Harry Potter Got Wrong");
  const long = finalTitle(video({ series: "Hogwarts vs History", seriesSubject: "The Philosopher's Stone and Other Alchemical Legends" }));
  assert.ok(long.length < 60, long);
  assert.ok(finalTitle(video({ title: "x".repeat(120) })).length < 60);
  assert.ok(finalTitle(video({ title: "x ".repeat(80), format: "long" })).length <= 100);
});

test("description follows the template and Shorts get #Shorts", () => {
  const d = buildDescription(video({ hook: "", title: "t", description: "Nobody was burned at Salem.\n\nSummary text\n\n#shorts #foo" }));
  const parts = d.split("\n\n");
  assert.equal(parts[0], "Nobody was burned at Salem.");
  assert.equal(parts[1], "Pop-culture myths vs the real history: Harry Potter, Houdini, unsolved mysteries and more. Subscribe so you don't miss the next case.");
  assert.equal(parts[2], "Narration and visuals are AI-assisted.");
  assert.equal(parts[3], "#History #HistoryDocumentary #UnsolvedMysteries #Shorts");
  // Idempotent: rebuilding from its own output changes nothing.
  assert.equal(buildDescription(video({ description: d, title: "t" })), d);
  assert.ok(!buildDescription(video({ format: "long", description: "Hook" })).includes("#Shorts"));
});

test("tags are the five fixed tags plus 3-5 topic tags", () => {
  const tags = buildTags(video({ topicTags: ["nicolas flamel", "alchemy", "paris 1416", "philosophers stone", "extra one", "too many"], tags: [], keyword: "", title: "x" }));
  assert.deepEqual(tags.slice(0, 5), ["history", "history myths", "myths vs history", "harry potter history", "unsolved mysteries"]);
  assert.equal(tags.length, 10);
  const fallback = buildTags(video({ tags: [], keyword: "salem witch trials", series: "Hogwarts vs History", title: "The Real Witch Trials: What Harry Potter Got Wrong" }));
  assert.ok(fallback.length >= 8 && fallback.length <= 10, String(fallback.length));
});

const GOOD = `Nobody in Salem was burned.
[slow push-in on a courthouse]
Nineteen people were hanged in 1692, and one man was pressed under stones.
The myth of the fire came centuries later.
Records show the court never ordered a single burning.
But the real punishment was stranger.
Subscribe for the next case.
Nobody in Salem was burned.`;

test("Short script rules: claim first, subscribe prompt before the last line, loop back, length", () => {
  assert.deepEqual(checkShortScript(GOOD), []);
  assert.ok(checkShortScript("Hey guys, welcome back.\n" + GOOD.split("\n").slice(1).join("\n")).length > 0);
  assert.ok(checkShortScript(GOOD.replace("Subscribe for the next case.\n", "")).some((p) => /subscribe/i.test(p)));
  assert.ok(checkShortScript(GOOD.replace(/Nobody in Salem was burned\.$/, "And that is all.")).some((p) => /loop/i.test(p)));
  assert.ok(checkShortScript(GOOD + "\n" + "word ".repeat(250)).some((p) => /Too long/.test(p)));
});

test("Heartbeat Hunt can't go to the history channel and history can't go to the Heartbeat Hunt channel", () => {
  const hist = channel();
  const drama = channel({ id: "c2", name: "Heartbeat Hunt" });
  assert.throws(() => assertLaneMatches(video({ series: "Heartbeat Hunt" }), hist), /Heartbeat Hunt/);
  assert.throws(() => assertLaneMatches(video({ title: "Heartbeat Hunt Episode 3" }), hist));
  assert.throws(() => assertLaneMatches(video({ series: "Hogwarts vs History" }), drama), /History uploads/);
  assert.throws(() => assertLaneMatches(video(), drama));
  assertLaneMatches(video({ series: "Heartbeat Hunt" }), drama);
  assertLaneMatches(video({ series: "Hogwarts vs History" }), hist);
  assertLaneMatches(video(), channel({ name: "Something else" })); // unclassified channel: no guard
});

test("Sydney time handles daylight saving", () => {
  assert.equal(zonedTime(2026, 10, 27, 19, 0, "Australia/Sydney").toISOString(), "2026-10-27T08:00:00.000Z"); // AEDT +11
  assert.equal(zonedTime(2026, 7, 1, 19, 0, "Australia/Sydney").toISOString(), "2026-07-01T09:00:00.000Z"); // AEST +10
});

test("Shorts get one slot per day at 7pm Sydney; long videos one per week", () => {
  const ch = channel();
  const from = new Date("2026-10-26T02:00:00Z"); // Mon 26 Oct 13:00 Sydney
  const taken: Video[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < 10; i++) {
    const v = video();
    const slot = nextSlot(ch, v, taken, from);
    assert.equal(slot.toISOString().slice(11), "08:00:00.000Z");
    const day = dayKey(slot.getTime(), "Australia/Sydney");
    assert.ok(!seen.has(day));
    seen.add(day);
    taken.push({ ...v, status: "scheduled", scheduledAt: slot.toISOString() });
  }
  assert.equal(dayKey(Date.parse(taken[0].scheduledAt!), "Australia/Sydney"), "2026-10-26"); // today's 7pm is still ahead
  const longs: Video[] = [];
  const days = [];
  for (let i = 0; i < 3; i++) {
    const v = video({ format: "long" });
    const slot = nextSlot(ch, v, [...taken, ...longs], from);
    days.push(slot.toISOString());
    longs.push({ ...v, status: "scheduled", scheduledAt: slot.toISOString() });
  }
  assert.deepEqual(days.map((d) => new Date(d).getUTCDay()), [6, 6, 6]);
  assert.equal(new Date(days[1]).getTime() - new Date(days[0]).getTime(), 7 * 86_400_000);
  const dup = { ...video(), status: "scheduled" as const, scheduledAt: taken[0].scheduledAt };
  assert.throws(() => assertSlotFree(ch, dup, taken), /1 Short per day/);
});

test("intro, outro and look never repeat on consecutive uploads and all three intro styles rotate", () => {
  const all: Video[] = [];
  const intros = new Set<string>();
  let prev: Video | undefined;
  for (let i = 0; i < 12; i++) {
    const v = video({ createdAt: new Date(Date.UTC(2026, 9, 1 + i)).toISOString() });
    v.variation = pickVariation(all, v, new Date(Date.UTC(2026, 9, 1 + i)));
    if (prev) {
      assert.notEqual(v.variation.intro, prev.variation!.intro);
      assert.notEqual(v.variation.outro, prev.variation!.outro);
      assert.notEqual(v.variation.look, prev.variation!.look);
    }
    intros.add(v.variation.intro);
    all.push(v);
    prev = v;
  }
  assert.ok(intros.size >= 3);
  const clash = video({ variation: { ...all[0].variation! }, scheduledAt: new Date(Date.UTC(2026, 9, 1, 12)).toISOString() });
  assert.throws(() => assertVariation(all, clash), /same/);
});

test("intro styles of flagged Shorts are avoided", () => {
  const flagged = video({ createdAt: "2026-10-01T00:00:00Z", variation: { intro: "myth-flip", outro: "echo-reveal", look: "cinematic", assignedAt: "2026-10-01T00:00:00Z" }, analytics: { views: 1, averageViewPercentage: 20, subscribersGained: 0, pulledAt: "", flag: "rewrite-hook" } });
  const other = video({ createdAt: "2026-10-02T00:00:00Z", variation: { intro: "number-shock", outro: "question-loop", look: "warm", assignedAt: "2026-10-02T00:00:00Z" } });
  const v = video({ createdAt: "2026-10-03T00:00:00Z" });
  assert.notEqual(pickVariation([flagged, other], v, new Date("2026-10-03T00:00:00Z")).intro, "myth-flip");
});

test("analytics are pulled 48 hours after publishing and Shorts under 40% are flagged", () => {
  const published = (hoursAgo: number, o: Partial<Video> = {}) =>
    video({ youtubeVideoId: "abc", status: "published", scheduledAt: new Date(Date.now() - hoursAgo * 3_600_000).toISOString(), ...o });
  assert.equal(analyticsDue(published(47)), false);
  assert.equal(analyticsDue(published(49)), true);
  assert.equal(analyticsDue(published(60, { analytics: { views: 1, averageViewPercentage: 50, subscribersGained: 0, pulledAt: new Date().toISOString() } })), false);
  assert.equal(analyticsDue(published(100, { analytics: { views: 1, averageViewPercentage: 50, subscribersGained: 0, pulledAt: new Date().toISOString(), final: true } })), false);
  assert.equal(analyticsFlag({ format: "short" }, 39.9), true);
  assert.equal(analyticsFlag({ format: "short" }, 40), false);
  assert.equal(analyticsFlag({ format: "long" }, 10), false);
});
