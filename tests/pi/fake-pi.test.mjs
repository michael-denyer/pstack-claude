import { describe, expect, test } from "bun:test";

import { resultText, useWorld } from "./harness.mjs";

const setup = useWorld();

describe("fake pi script", () => {
  for (const [name, step, problem] of [
    ["two keys", { sleep: 1, reply: "x" }, 'a step needs exactly one key, got {"sleep":1,"reply":"x"}'],
    ["an unknown key", { replay: "x" }, 'unknown step key "replay"'],
    ["an unknown spawn kind", { spawn: "toString" }, 'unknown spawn kind "toString"'],
    ["mute false", { mute: false }, 'step "mute" takes only true, got false'],
    ["ignoreSigterm false", { ignoreSigterm: false }, 'step "ignoreSigterm" takes only true, got false'],
    ["askUser false", { askUser: false }, 'step "askUser" takes only true, got false'],
  ]) {
    test(`a step with ${name} ends the fake before it plays anything`, async () => {
      const { w, pi, ctx } = setup({ script: { default: [step] } });
      const result = await pi.call("agent", { description: "bad", prompt: "x" }, ctx).catch((e) => e);
      expect(result instanceof Error ? result.message : resultText(result)).toContain(`fake-pi: ${problem}`);
      expect(w.invocations()).toEqual([]);
    });
  }
});
