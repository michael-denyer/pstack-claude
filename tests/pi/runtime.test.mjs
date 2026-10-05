// CLI regressions against installed Pi, with no model calls or credentials.
import { describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { AgentRunner } from "../../plugins/pstack/pi/agents.ts";
import { findPiPackage } from "../../tools/pi-package.mjs";
import { useWorld } from "./harness.mjs";

const piDir = findPiPackage();
const noNode = spawnSync("node", ["--version"]).status !== 0;
const setup = useWorld();
if (process.env.PSTACK_PI_REQUIRE_RUNTIME === "1" && (!piDir || noNode)) throw new Error("The Pi runtime tests require an installed Pi package and node.");

describe.skipIf(!piDir || noNode)("installed Pi child startup", () => {
  for (const [isolation, installed] of [[undefined, false], ["worktree", false], ["worktree", true]]) {
    test(`loads pstack once, isolation=${isolation}, globally installed=${installed}`, async () => {
      const { w, pi, ctx } = setup({ ctx: { model: null } });
      if (installed) writeFileSync(join(w.agentDir, "settings.json"), JSON.stringify({ packages: [join(import.meta.dir, "../..")] }));
      execFileSync("git", ["init", "-b", "main", w.cwd], { stdio: "ignore" });
      execFileSync("git", ["-C", w.cwd, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "base"], { stdio: "ignore" });
      // Isolate Pi's configuration without modifying the test runner's environment.
      const config = join(w.agentDir, "environment.mjs");
      writeFileSync(config, `process.env.PI_CODING_AGENT_DIR = ${JSON.stringify(w.agentDir)};`);
      const runner = new AgentRunner(pi.api, {
        ...w.settings,
        pi: { command: "node", args: ["--import", config, join(piDir, "dist/cli.js")] },
      });
      try {
        // /loop without arguments only prints usage. A handled command proves
        // pstack loaded, without starting a model run in the child.
        const started = runner.start({ description: "startup probe", prompt: "/loop", isolation }, ctx);
        const result = await runner.wait(started.agent.id);
        expect(result.finalText).toContain("consumed the prompt as an extension command");
        expect(result.exitCode).toBe(0);
      } finally {
        await runner.stopAll();
      }
    }, 15000);
  }
});
