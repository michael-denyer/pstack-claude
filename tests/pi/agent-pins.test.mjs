// An agent file's model and effort pins against the call's parameters and the pi models: sheet line.
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
  const pluginRoot = realpathSync(mkdtempSync(join(tmpdir(), "pstack-pins-")));
  roots.push(pluginRoot);
  mkdirSync(join(pluginRoot, "agents"));
  for (const [name, frontmatter] of Object.entries(files)) writeFileSync(join(pluginRoot, "agents", `${name}.md`), `---\n${frontmatter}\n---\nbody of ${name}\n`);
  return setup({ ...options, settings: { pluginRoot } });
}

const run = async (pi, ctx, type, params = {}) => {
  await pi.call("agent", { description: type, prompt: "x", subagent_type: `pstack:${type}`, ...params }, ctx);
};

describe("agent file pins", () => {
  test("a provider/id model pin beats the call's model, a family name or a provider/id alike, and the pi models: sheet line", async () => {
    const { w, pi, ctx } = withAgents({ pinned: "model: gw/pinned-model" }, { sheet: "pi models: opus=gw/sheet-opus\n" });
    for (const model of ["opus", "sonnet", "inherit-parent", "gw/other", undefined]) await run(pi, ctx, "pinned", { model });
    expect(w.invocations().map((inv) => flag(inv, "--model"))).toEqual(Array(5).fill("gw/pinned-model"));
  });

  test("a family name in the file is only a default: the call's model wins, and the sheet line maps it", async () => {
    const { w, pi, ctx } = withAgents({ soft: "model: opus" }, { sheet: "pi models: opus=gw/sheet-opus\n" });
    await run(pi, ctx, "soft");
    await run(pi, ctx, "soft", { model: "sonnet" });
    await run(pi, ctx, "soft", { model: "gw/explicit" });
    expect(w.invocations().map((inv) => flag(inv, "--model"))).toEqual(["gw/sheet-opus", "anthropic/fixture-sonnet", "gw/explicit"]);
  });

  test("an effort pin beats the call's effort, a pinned agent with no effort keeps the call's, and either way the session's level is the fallback", async () => {
    const { w, pi, ctx } = withAgents({ slow: "effort: max", plain: "model: gw/pinned-model" });
    await run(pi, ctx, "slow");
    await run(pi, ctx, "slow", { effort: "low" });
    await run(pi, ctx, "plain", { effort: "low" });
    await run(pi, ctx, "plain");
    expect(w.invocations().map((inv) => flag(inv, "--thinking"))).toEqual(["max", "max", "low", "medium"]);
  });

  test("a model pin and an effort pin together reach the child, and a resume keeps both", async () => {
    const { w, pi, ctx } = withAgents({ both: "model: gw/pinned-model\neffort: high" });
    await run(pi, ctx, "both", { model: "opus", effort: "low" });
    await pi.call("send_message", { to: "both", message: "again" }, ctx);
    await w.until("invocation", 2);
    expect(w.invocations().map((inv) => [flag(inv, "--model"), flag(inv, "--thinking")])).toEqual([
      ["gw/pinned-model", "high"],
      ["gw/pinned-model", "high"],
    ]);
  });

  test("an effort pin that is not a level is an error naming the levels, and no child starts", async () => {
    const { w, pi, ctx } = withAgents({ bad: "effort: turbo" });
    const err = await run(pi, ctx, "bad").catch((e) => e);
    expect(err.message).toContain(`effort "turbo" is not one of ${fixtureModels.efforts.join(", ")}`);
    expect(w.invocations()).toEqual([]);
  });
});
