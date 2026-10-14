import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_PRESETS, MAX_TEMPO, gapSeconds, modelChain, presetFor, resolvePresets, settingsFor, snapStability, supportsAudioTags,
} from "../voicePresets";

test("defaults sit inside the documented ranges and the brief's targets", () => {
  for (const p of Object.values(DEFAULT_PRESETS)) {
    assert.ok(p.speed >= 0.7 && p.speed <= 1.2);
    assert.ok(p.stability >= 0 && p.stability <= 1);
  }
  const doc = DEFAULT_PRESETS.documentary_narration;
  assert.ok(doc.stability >= 0.35 && doc.stability <= 0.5);
  assert.ok(doc.speed >= 1.05 && doc.speed <= 1.12);
  assert.ok(DEFAULT_PRESETS.fast_short.speed >= 1.1 && DEFAULT_PRESETS.fast_short.speed <= 1.15);
  assert.ok(DEFAULT_PRESETS.dramatic_reveal.speed < 1);
  assert.ok(DEFAULT_PRESETS.dramatic_reveal.stability < doc.stability);
});

test("saved values override defaults and are forced into range", () => {
  const p = resolvePresets({ documentary_narration: { speed: 5, stability: -1, tempo: 2, gapMs: [500, 100] } });
  assert.equal(p.documentary_narration.speed, 1.2);
  assert.equal(p.documentary_narration.stability, 0);
  assert.equal(p.documentary_narration.tempo, MAX_TEMPO);
  assert.ok(p.documentary_narration.gapMs[1] >= p.documentary_narration.gapMs[0]);
  assert.equal(p.fast_short.speed, DEFAULT_PRESETS.fast_short.speed);
  assert.deepEqual(resolvePresets(null), resolvePresets({}));
});

test("Shorts are brisk, key moments dramatic, the rest documentary", () => {
  assert.equal(presetFor({ keyMoment: true }, "short"), "fast_short");
  assert.equal(presetFor({ keyMoment: true }, "long"), "dramatic_reveal");
  assert.equal(presetFor({ keyMoment: false }, "long"), "documentary_narration");
  assert.equal(presetFor({}, "long"), "documentary_narration");
});

test("model chain: configured first, no duplicates, cheaper model for Shorts only when set", () => {
  assert.deepEqual(modelChain({}, "long"), ["eleven_v4", "eleven_v3", "eleven_multilingual_v2"]);
  assert.deepEqual(modelChain({ ELEVENLABS_MODEL: "eleven_v3" }, "long"), ["eleven_v3", "eleven_multilingual_v2"]);
  assert.deepEqual(modelChain({ ELEVENLABS_SHORT_MODEL: "eleven_flash_v2_5" }, "short")[0], "eleven_flash_v2_5");
  assert.equal(modelChain({ ELEVENLABS_SHORT_MODEL: "eleven_flash_v2_5" }, "long")[0], "eleven_v4");
  assert.ok(supportsAudioTags("eleven_v4") && supportsAudioTags("eleven_v3") && !supportsAudioTags("eleven_multilingual_v2"));
});

test("settings ladder steps down: style, then v3 stability steps, then speed", () => {
  const preset = DEFAULT_PRESETS.documentary_narration;
  const full = settingsFor("eleven_v4", preset, 0);
  assert.equal(full.style, preset.style);
  assert.equal(full.speed, preset.speed);
  assert.equal(full.stability, preset.stability);
  assert.equal(settingsFor("eleven_v4", preset, 1).style, undefined);
  assert.equal(settingsFor("eleven_v4", preset, 2).stability, snapStability(preset.stability));
  assert.equal(settingsFor("eleven_v4", preset, 3).speed, undefined);
  // v3 only takes stability steps and no style, whatever the level.
  const v3 = settingsFor("eleven_v3", preset, 0);
  assert.ok([0, 0.5, 1].includes(v3.stability));
  assert.equal(v3.style, undefined);
});

test("gaps stay inside the preset's range and repeat for the same script", () => {
  for (const preset of Object.values(DEFAULT_PRESETS)) {
    for (let n = 0; n < 200; n++) {
      const g = gapSeconds(preset, n);
      assert.ok(g >= preset.gapMs[0] / 1000 - 1e-9 && g <= preset.gapMs[1] / 1000 + 1e-9, `gap ${g}`);
      assert.equal(g, gapSeconds(preset, n));
    }
  }
  const spread = new Set(Array.from({ length: 50 }, (_, n) => gapSeconds(DEFAULT_PRESETS.documentary_narration, n).toFixed(3)));
  assert.ok(spread.size > 20, "gaps should vary, not be one fixed silence");
});
