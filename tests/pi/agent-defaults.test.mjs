// An agent file's model and effort are defaults below the call's parameters, as on Claude Code.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fixtureModels, flag, useWorld } from "./harness.mjs";

const setup = useWorld();
const roots = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

// A plugin root holding only these agent files; the extension reads nothing else from it at install.
function withAgents(files, options = {}) {
  const pluginRoot = realpathSync(mkdtempSync(join(tmpdir(), "pstack-defaults-")));
  roots.push(pluginRoot);
  mkdirSync(join(pluginRoot, "agents"));
  for (const [name, frontmatter] of Object.entries(files)) writeFileSync(join(pluginRoot, "agents", `${name}.md`), `---\n${frontmatter}\n---\nbody of ${name}\n`);
  return setup({ ...options, settings: { pluginRoot } });
}

const run = async (pi, ctx, type, params = {}) => {
  await pi.call("agent", { description: type, prompt: "x", subagent_type: `pstack:${type}`, ...params }, ctx);
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

  test("a resume keeps the file's effort", async () => {
    const { w, pi, ctx } = withAgents({ slow: "effort: high" });
    await run(pi, ctx, "slow");
    await pi.call("send_message", { to: "slow", message: "again" }, ctx);
    await w.until("invocation", 2);
    expect(w.invocations().map((inv) => flag(inv, "--thinking"))).toEqual(["high", "high"]);
  });

  test("a file effort that is not a level is an error naming the levels, and no child starts", async () => {
    const { w, pi, ctx } = withAgents({ bad: "effort: turbo" });
    const err = await run(pi, ctx, "bad").catch((e) => e);
    expect(err.message).toContain(`effort "turbo" is not one of ${fixtureModels.efforts.join(", ")}`);
    expect(w.invocations()).toEqual([]);
  });
});
