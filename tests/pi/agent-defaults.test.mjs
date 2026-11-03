// An agent file's model and effort are defaults below the call's parameters, as on Claude Code.
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { fixtureModels, flag, useWorld } from "./harness.mjs";

const setup = useWorld();

function withAgents(files, options = {}) {
  const world = setup(options);
  const dir = join(world.w.agentDir, "pstack-agents");
  mkdirSync(dir);
  for (const [name, frontmatter] of Object.entries(files)) writeFileSync(join(dir, `${name}.md`), `---\n${frontmatter}\n---\nbody of ${name}\n`);
  return world;
}

const run = async (pi, ctx, type, params = {}) => {
  await pi.call("agent", { description: type, prompt: "x", subagent_type: type, ...params }, ctx);
};

describe("agent file defaults", () => {
  test("the call's effort beats the file's, the file's is the default, and the session's level is the fallback", async () => {
    const { w, pi, ctx } = withAgents({ slow: "effort: max", plain: "description: no effort" });
    await run(pi, ctx, "slow");
    await run(pi, ctx, "slow", { effort: "low" });
    await run(pi, ctx, "plain", { effort: "low" });
    await run(pi, ctx, "plain");
    expect(w.invocations().map((inv) => flag(inv, "--thinking"))).toEqual(["max", "low", "low", "medium"]);
  });

  test("a provider/id model in the file is only a default: the call's model wins, and the pi models: line maps a family name", async () => {
    const { w, pi, ctx } = withAgents({ gw: "model: gw/file-model" }, { sheet: "pi models: opus=gw/sheet-opus\n" });
    await run(pi, ctx, "gw");
    await run(pi, ctx, "gw", { model: "opus" });
    await run(pi, ctx, "gw", { model: "gw/explicit" });
    expect(w.invocations().map((inv) => flag(inv, "--model"))).toEqual(["gw/file-model", "gw/sheet-opus", "gw/explicit"]);
  });

  test("Claude Code's model: inherit in the file runs the agent on the parent's model", async () => {
    const { w, pi, ctx } = withAgents({ copied: "model: inherit" });
    await run(pi, ctx, "copied");
    expect(w.invocations().map((inv) => flag(inv, "--model"))).toEqual(["anthropic/parent-model"]);
  });

  test("YAML quotes around a value, and a byte-order mark before the frontmatter, are not part of the field", async () => {
    const { w, pi, ctx } = withAgents({ quoted: `model: "gw/quoted-model"\neffort: 'high'` });
    const bom = String.fromCharCode(0xfeff);
    writeFileSync(join(w.agentDir, "pstack-agents", "bom.md"), `${bom}---\nmodel: gw/bom-model\neffort: max\n---\nbody of bom\n`);
    await run(pi, ctx, "quoted");
    await run(pi, ctx, "bom");
    expect(w.invocations().map((inv) => [flag(inv, "--model"), flag(inv, "--thinking"), inv.systemPrompt])).toEqual([
      ["gw/quoted-model", "high", "body of quoted"],
      ["gw/bom-model", "max", "body of bom"],
    ]);
  });

  test("a resume keeps the file's effort", async () => {
    const { w, pi, ctx } = withAgents({ slow: "effort: high" });
    await run(pi, ctx, "slow");
    await pi.call("send_message", { to: "slow", message: "again" }, ctx);
    await w.until("invocation", 2);
    expect(w.invocations().map((inv) => flag(inv, "--thinking"))).toEqual(["high", "high"]);
  });

  test("a models.json that cannot be read is its own error, naming that file, not the agent file", async () => {
    const { w, pi, ctx } = withAgents({ slow: "effort: high", big: "model: opus" });
    for (const [text, problem] of [["{}", "is not a pstack models file"], ["{", "is not valid JSON"]]) {
      writeFileSync(w.settings.modelsFile, text);
      for (const type of ["slow", "big"]) expect((await run(pi, ctx, type).catch((e) => e)).message).toStartWith(`${w.settings.modelsFile} ${problem}`);
    }
    expect(w.invocations()).toEqual([]);
  });

  test("a bad effort or model from an agent file is an error that names the file, the same value on the call is not, and no child starts", async () => {
    const { w, pi, ctx } = withAgents({ slow: "effort: turbo", odd: "model: gpt9", plain: "description: none" });
    const file = (name) => join(w.agentDir, "pstack-agents", `${name}.md`);
    const message = async (type, params) => (await run(pi, ctx, type, params).catch((e) => e)).message;
    const levels = `effort "turbo" is not one of ${fixtureModels.efforts.join(", ")}`;
    expect(await message("slow")).toBe(`${file("slow")}: ${levels}`);
    expect(await message("odd")).toStartWith(`${file("odd")}: Unknown model "gpt9".`);
    expect(await message("plain", { effort: "turbo" })).toBe(levels);
    expect(await message("plain", { model: "gpt9" })).toStartWith('Unknown model "gpt9".');
    expect(w.invocations()).toEqual([]);
  });
});
