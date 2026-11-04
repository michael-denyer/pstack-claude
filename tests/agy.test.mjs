import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadLeadLines, loadModels, noteSkills } from "../tools/generate.mjs";
import { agyModelNamesSection, roleSkills, RUNTIMES } from "../tools/runtimes.mjs";
import { mappingCoverage } from "./mapping-coverage.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const codex = RUNTIMES.find((runtime) => runtime.name === "Codex");
const agy = RUNTIMES.find((runtime) => runtime.name === "Antigravity");
const mapping = readFileSync(join(repoRoot, agy.tools), "utf8");
const models = loadModels();

mappingCoverage(agy, [
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
  ["`loop`", "Use the `schedule` tool"],
]);

describe("Antigravity preambles", () => {
  const leads = loadLeadLines();

  test("every skill noted for Codex is also noted for Antigravity", () => {
    const noted = (runtime) => noteSkills(runtime, readFileSync(join(repoRoot, runtime.tools), "utf8"));
    const agyNoted = noted(agy);
    for (const skill of noted(codex)) expect({ skill, noted: agyNoted.includes(skill) }).toEqual({ skill, noted: true });
  });

  test("stamps the Antigravity preamble in each noted skill", () => {
    const stamped = [...leads].filter(([, lines]) => lines.includes(agy.preamble));
    expect(stamped.length).toBeGreaterThan(0);
    for (const [file] of stamped) {
      expect(readFileSync(join(repoRoot, file), "utf8")).toContain(agy.preamble);
    }
  });
});

describe("agy-tools.md Model names", () => {
  const section = agyModelNamesSection(models);

  test("names no Claude alias", () => {
    expect(section).not.toMatch(/`(?:opus|fable|sonnet|haiku)`/);
    expect(section).toContain("`~/.gemini/config/pstack-models.md`");
    for (const skill of roleSkills(models)) expect(section).toContain(`\`${skill}\``);
  });

  test("is the section the mapping file carries", () => {
    expect(mapping).toContain(section);
  });
});
