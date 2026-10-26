import assert from "node:assert/strict";
import test from "node:test";
import { parseJsonAnswer, providerOrder } from "../ai";
import { findFreeVisual, isPublicDomain, pickWikimedia } from "../stockImages";

const page = (id: number, license: string, w: number, h: number, mime = "image/jpeg") => ({
  pageid: id,
  imageinfo: [{ mime, width: w, height: h, url: `full-${id}`, thumburl: `thumb-${id}`, extmetadata: { LicenseShortName: { value: license } } }],
});

test("only public-domain and CC0 Wikimedia pictures are used", () => {
  assert.ok(isPublicDomain("Public domain"));
  assert.ok(isPublicDomain("CC0"));
  assert.ok(isPublicDomain("PD-old-70"));
  assert.ok(!isPublicDomain("CC BY-SA 4.0"));
  assert.ok(!isPublicDomain("CC BY 2.0"));
  assert.ok(!isPublicDomain(undefined));
  const pages = [page(1, "CC BY-SA 4.0", 3000, 2000), page(2, "Public domain", 400, 300), page(3, "Public domain", 2400, 1800), page(4, "CC0", 1800, 2600), page(5, "Public domain", 2000, 1500, "image/svg+xml")];
  assert.equal(pickWikimedia(pages, false, new Set())?.id, "w3");
  assert.equal(pickWikimedia(pages, true, new Set())?.id, "w4"); // portrait frame prefers the tall picture
  assert.equal(pickWikimedia(pages, false, new Set(["w3"]))?.id, "w4"); // used pictures are skipped; any shape is cropped to fit
  assert.equal(pickWikimedia([page(1, "CC BY 2.0", 3000, 2000)], false, new Set()), null);
  assert.equal(pickWikimedia(pages, false, new Set()) && pickWikimedia(pages, false, new Set())!.url, "thumb-3");
});

test("free sources are tried in order, per search, and a failing source is skipped", async () => {
  const calls: string[] = [];
  const finder = (name: string, hit?: string, fail = false) => async (q: string) => {
    calls.push(`${name}:${q}`);
    if (fail) throw new Error("rate limit");
    return hit === q ? { id: `${name}-1`, kind: "photo" as const, url: "u" } : null;
  };
  const finders = { pexels: finder("pexels"), pixabay: finder("pixabay", undefined, true), wikimedia: finder("wikimedia", "broad") };
  const broken = new Set<string>();
  const found = await findFreeVisual(["specific", "broad"], false, new Set(), broken, ["pexels", "pixabay", "wikimedia"], finders);
  assert.equal(found?.id, "wikimedia-1");
  assert.deepEqual(calls, ["pexels:specific", "pixabay:specific", "wikimedia:specific", "pexels:broad", "wikimedia:broad"]);
  assert.deepEqual([...broken], ["pixabay"]);
  assert.equal(await findFreeVisual(["nothing"], false, new Set(), new Set(), ["pexels"], { pexels: finder("pexels") }), null);
});

test("AI services are tried Claude, then Gemini, then the extra one, only when set up", () => {
  assert.deepEqual(providerOrder({}), []);
  assert.deepEqual(providerOrder({ GEMINI_API_KEY: "k" }), ["gemini"]);
  assert.deepEqual(providerOrder({ ANTHROPIC_API_KEY: "a", GEMINI_API_KEY: "g", EXTRA_AI_BASE_URL: "u", EXTRA_AI_API_KEY: "k", EXTRA_AI_MODEL: "m" }), ["claude", "gemini", "extra"]);
  assert.deepEqual(providerOrder({ EXTRA_AI_BASE_URL: "u", EXTRA_AI_API_KEY: "k" }), []); // model name missing
});

test("JSON answers from free models survive code fences and chatter", () => {
  assert.deepEqual(parseJsonAnswer('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJsonAnswer('Sure! Here you go:\n{"a":{"b":2}}\nHope that helps.'), { a: { b: 2 } });
  assert.throws(() => parseJsonAnswer("no json here"));
});
