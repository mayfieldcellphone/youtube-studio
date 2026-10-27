import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeSnapgenClip, modelForTier, snapgenConfigured } from "../snapgen";
import { wrongBox } from "../settings";
import * as veo from "../veo";

test("snapgenConfigured detects presence of SNAPGEN_API_KEY", () => {
  const orig = process.env.SNAPGEN_API_KEY;
  try {
    delete process.env.SNAPGEN_API_KEY;
    assert.equal(snapgenConfigured(), false);
    process.env.SNAPGEN_API_KEY = "test-snapgen-key";
    assert.equal(snapgenConfigured(), true);
  } finally {
    if (orig !== undefined) process.env.SNAPGEN_API_KEY = orig;
    else delete process.env.SNAPGEN_API_KEY;
  }
});

test("modelForTier respects tier defaults and SNAPGEN_MODEL override", () => {
  const orig = process.env.SNAPGEN_MODEL;
  try {
    delete process.env.SNAPGEN_MODEL;
    assert.equal(modelForTier("best"), "veo-3.1");
    assert.equal(modelForTier("fast"), "veo-3.1-fast");
    assert.equal(modelForTier("lite"), "veo-3.1-lite");

    process.env.SNAPGEN_MODEL = "veo-2";
    assert.equal(modelForTier("best"), "veo-2");
    assert.equal(modelForTier("lite"), "veo-2");
  } finally {
    if (orig !== undefined) process.env.SNAPGEN_MODEL = orig;
    else delete process.env.SNAPGEN_MODEL;
  }
});

test("wrongBox warns if another service's key is entered as SNAPGEN_API_KEY", () => {
  assert.match(String(wrongBox("SNAPGEN_API_KEY", "sk-ant-test")), /Claude/);
  assert.match(String(wrongBox("SNAPGEN_API_KEY", "AIza-test")), /Google/);
  assert.equal(wrongBox("SNAPGEN_API_KEY", "snapgen_custom_key_12345"), undefined);
});

test("makeSnapgenClip posts multipart request, polls status 2, and downloads video", async () => {
  const origKey = process.env.SNAPGEN_API_KEY;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "snapgen-test-"));
  const outFile = path.join(tmp, "clip.mp4");

  process.env.SNAPGEN_API_KEY = "sg-secret-key";
  let postedFormData: FormData | null = null;
  let polledCount = 0;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input);
    if (url.includes("/uapi/v1/video-gen/veo") && init?.method === "POST") {
      assert.equal(init?.headers?.["x-api-key"], "sg-secret-key");
      postedFormData = init.body as FormData;
      return Response.json({ uuid: "task-uuid-123" });
    }
    if (url.includes("/uapi/v1/history/task-uuid-123")) {
      assert.equal(init?.headers?.["x-api-key"], "sg-secret-key");
      polledCount++;
      if (polledCount === 1) {
        return Response.json({ data: { status: 1 } }); // processing
      }
      return Response.json({
        data: {
          status: 2,
          generated_video: [{ video_url: "https://files.test/video.mp4" }],
        },
      });
    }
    if (url === "https://files.test/video.mp4") {
      return new Response("fake-video-content");
    }
    throw new Error(`Unexpected fetch to ${url}`);
  }) as typeof fetch;

  try {
    await makeSnapgenClip("a cinematic scene", outFile, "fast", true, { pollIntervalMs: 1 });
    assert.ok(fs.existsSync(outFile));
    assert.equal(fs.readFileSync(outFile, "utf8"), "fake-video-content");
    assert.ok(postedFormData);
    assert.equal((postedFormData as FormData).get("prompt"), "a cinematic scene");
    assert.equal((postedFormData as FormData).get("model"), "veo-3.1-fast");
    assert.equal((postedFormData as FormData).get("aspect_ratio"), "9:16");
  } finally {
    globalThis.fetch = originalFetch;
    if (origKey !== undefined) process.env.SNAPGEN_API_KEY = origKey;
    else delete process.env.SNAPGEN_API_KEY;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("makeSnapgenClip throws on failure status", async () => {
  const origKey = process.env.SNAPGEN_API_KEY;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "snapgen-fail-"));
  const outFile = path.join(tmp, "clip.mp4");

  process.env.SNAPGEN_API_KEY = "sg-secret-key";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any) => {
    const url = String(input);
    if (url.includes("/uapi/v1/video-gen/veo")) {
      return Response.json({ uuid: "task-fail-uuid" });
    }
    if (url.includes("/uapi/v1/history/task-fail-uuid")) {
      return Response.json({ data: { status: 3, failed_reason: "Content filtered" } });
    }
    throw new Error(`Unexpected fetch to ${url}`);
  }) as typeof fetch;

  try {
    await assert.rejects(
      () => makeSnapgenClip("prompt", outFile, "fast", false, { pollIntervalMs: 1 }),
      /Content filtered/,
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (origKey !== undefined) process.env.SNAPGEN_API_KEY = origKey;
    else delete process.env.SNAPGEN_API_KEY;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("makeClips tries SnapGen first and falls back to Gemini Veo for failed clips", async () => {
  const origSgKey = process.env.SNAPGEN_API_KEY;
  const origGeminiKey = process.env.GEMINI_API_KEY;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "snapgen-fallback-"));

  process.env.SNAPGEN_API_KEY = "sg-test-key";
  process.env.GEMINI_API_KEY = "AIza-test";
  process.env.AI_FOOTAGE_MONTHLY_CAP_USD = "100";

  const originalFetch = globalThis.fetch;
  const requests = [
    { prompt: "shot 1 - snapgen succeeds", outFile: path.join(tmp, "clip1.mp4") },
    { prompt: "shot 2 - snapgen fails", outFile: path.join(tmp, "clip2.mp4") },
  ];

  let geminiCalled = false;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input);
    if (url.includes("/uapi/v1/video-gen/veo")) {
      const form = init.body as FormData;
      const prompt = String(form.get("prompt"));
      if (prompt.includes("shot 1")) return Response.json({ uuid: "sg-1" });
      return new Response("SnapGen rate limit", { status: 429 });
    }
    if (url.includes("/uapi/v1/history/sg-1")) {
      return Response.json({ data: { status: 2, generated_video: [{ video_url: "https://files.test/sg1.mp4" }] } });
    }
    if (url === "https://files.test/sg1.mp4") {
      return new Response("video-sg-1");
    }
    if (url.includes("/models?pageSize")) {
      return Response.json({ models: [{ name: "models/veo-3.1-fast-generate-preview", supportedGenerationMethods: ["predictLongRunning"] }] });
    }
    if (url.includes(":predictLongRunning")) {
      geminiCalled = true;
      return Response.json({ name: "operations/gemini-op-1" });
    }
    if (url.includes("/operations/gemini-op-1")) {
      return Response.json({ done: true, response: { generatedSamples: [{ video: { uri: "https://files.test/gemini.mp4" } }] } });
    }
    if (url === "https://files.test/gemini.mp4") {
      return new Response("video-gemini-2");
    }
    throw new Error(`Unexpected fetch to ${url}`);
  }) as typeof fetch;

  try {
    const results = await veo.makeClips(requests, "fast", true, () => {});
    assert.deepEqual(results, [true, true]);
    assert.equal(geminiCalled, true, "Gemini Veo should be called for the failed clip");
    assert.equal(fs.readFileSync(requests[0].outFile, "utf8"), "video-sg-1");
    assert.equal(fs.readFileSync(requests[1].outFile, "utf8"), "video-gemini-2");
  } finally {
    globalThis.fetch = originalFetch;
    if (origSgKey !== undefined) process.env.SNAPGEN_API_KEY = origSgKey;
    else delete process.env.SNAPGEN_API_KEY;
    if (origGeminiKey !== undefined) process.env.GEMINI_API_KEY = origGeminiKey;
    else delete process.env.GEMINI_API_KEY;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

