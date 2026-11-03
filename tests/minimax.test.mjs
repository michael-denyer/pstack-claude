// MiniMax Code build contracts: the mapping names every Claude-specific term
// the skills use, the plugin directory keeps MiniMax Code on its Claude Code
// reader, and the model section names no Claude slug.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadModels } from "../tools/generate.mjs";
import { PLUGIN } from "../tools/plugin.mjs";
import { MINIMAX_MANIFESTS, minimaxModelNamesSection, roleSkills, RUNTIMES, validateMiniMaxPackage } from "../tools/runtimes.mjs";
import { mappingCoverage } from "./mapping-coverage.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const minimax = RUNTIMES.find((runtime) => runtime.name === "MiniMax Code");
const mapping = readFileSync(join(repoRoot, minimax.tools), "utf8");
const models = loadModels();

mappingCoverage(minimax, [
  ["AskUserQuestion", "`AskUserQuestion`"],
  ["subagent_type", "`subagent_type"],
  ["run_in_background", "`run_in_background: true`"],
  ["TodoWrite", "`TodoWrite`"],
  ["TaskCreate", "`TaskCreate`"],
  ["readonly", "`readonly: true`"],
  ["the `Skill` tool", "the `Skill` tool"],
  ["the `Agent` tool", "the `Agent`/`Task` tool"],
  ["plugin-dev", "`plugin-dev:skill-development`"],
  ["CLAUDE.md", "`CLAUDE.md`"],
  ["pstack:poteto-agent", "`pstack:poteto-agent`"],
  ["general-purpose", "`general-purpose`"],
  ["isolation: \"worktree\"", "`isolation: \"worktree\"`"],
  [".claude/skills", "`.claude/skills/`"],
  ["${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects", "`${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects/`"],
  ["`loop`", "`self_reminder`, set again after each check"],
]);

describe("MiniMax Code packaging", () => {
  const inTree = (rel) => existsSync(join(repoRoot, rel));

  test("the shipped plugin is read through the Claude Code manifest", () => {
    expect(minimax.manifest).toBe(`${PLUGIN}/.claude-plugin/plugin.json`);
    expect(() => validateMiniMaxPackage({ pathExists: inTree })).not.toThrow();
  });

  test.each(MINIMAX_MANIFESTS.slice(0, 2))("a %s in the plugin fails, since MiniMax Code would read it first", (file) => {
    const pathExists = (rel) => rel === `${PLUGIN}/${file}` || inTree(rel);
    expect(() => validateMiniMaxPackage({ pathExists })).toThrow(`${PLUGIN}/${file}: MiniMax Code reads this manifest instead`);
  });
});

describe("minimax-tools.md Model names", () => {
  const section = minimaxModelNamesSection(models);

  test("names no Claude alias and ships no default model", () => {
    expect(section).not.toMatch(/`(?:opus|fable|sonnet|haiku)`/);
    expect(section).toContain("`<provider>/<model>`");
  });

  test("names the sheet, the task fields, and every skill that dispatches on a role model", () => {
    expect(section).toContain("`~/.minimax/pstack-models.md`");
    expect(section).toContain("the `task` tool's `model`");
    expect(section).toContain("as `effort`");
    for (const skill of roleSkills(models)) expect(section).toContain(`\`${skill}\``);
  });

  test("is the section the mapping file carries", () => {
    expect(mapping).toContain(section);
  });
});
