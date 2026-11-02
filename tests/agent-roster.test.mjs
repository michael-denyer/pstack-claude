// Each runtime mapping names the plugin's subagent types by hand in its
// Subagent policy: Pi, Copilot, and Codex. Claude Code registers
// plugins/pstack/agents/ by default, and the Pi agent tool's description is
// built from that folder, so these three copies are the ones that can drift.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = fileURLToPath(new URL("../plugins/pstack", import.meta.url));
const agents = readdirSync(join(pluginRoot, "agents"))
  .filter((file) => file.endsWith(".md"))
  .map((file) => basename(file, ".md"));

// Claude Code, Pi, and Copilot dispatch by the namespaced name. The Codex
// mapping lists the bare names that have no spawn_agent type.
const rosters = [
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
