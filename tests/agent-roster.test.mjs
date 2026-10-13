// Each runtime names the plugin's subagent types by hand: the Pi agent tool's
// parameter description and the Subagent policy of the Pi, Copilot, and Codex
// mappings. The generator stamps only the Claude manifest's agents array from
// plugins/pstack/agents/, so these four copies are the ones that can drift.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = fileURLToPath(new URL("../plugins/pstack", import.meta.url));
const agents = readdirSync(join(pluginRoot, "agents"))
  .filter((file) => file.endsWith(".md"))
  .map((file) => basename(file, ".md"));

// Claude Code, Pi, and Copilot dispatch by the namespaced name. The Codex
// mapping lists the bare names that have no spawn_agent type. The Pi tool's
// description runs the names together in prose, so a name must not continue
// into a longer one such as pstack:poteto-agent-<level>.
const rosters = [
  ["pi/agent-tools.ts", (name) => new RegExp(`pstack:${name}(?![\\w-])`)],
  ["skills/poteto-mode/references/pi-tools.md", (name) => new RegExp(`\`pstack:${name}\``)],
  ["skills/poteto-mode/references/copilot-tools.md", (name) => new RegExp(`\`pstack:${name}\``)],
  ["skills/poteto-mode/references/codex-tools.md", (name) => new RegExp(`\`${name}\``)],
];

describe("subagent roster", () => {
  test("agents/ holds the base poteto-agent", () => {
    expect(agents).toContain("poteto-agent");
  });

  for (const [file, mention] of rosters) {
    test(`${file} names every agent under agents/`, () => {
      const text = readFileSync(join(pluginRoot, file), "utf8");
      expect(agents.filter((name) => !mention(name).test(text))).toEqual([]);
    });
  }
});
