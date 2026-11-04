import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadModels } from "../tools/generate.mjs";
import { openCodeModelNamesSection, roleSkills, RUNTIMES, validateOpenCodePackage } from "../tools/runtimes.mjs";
import { mappingCoverage } from "./mapping-coverage.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const runtime = RUNTIMES.find((row) => row.name === "OpenCode 2");
const mapping = readFileSync(join(root, runtime.tools), "utf8");
const models = loadModels();

mappingCoverage(runtime, [
  ["AskUserQuestion", "`AskUserQuestion`"],
  ["subagent_type", "`subagent_type`"],
  ["run_in_background", "`run_in_background: true`"],
  ["TodoWrite", "`TodoWrite`"],
  ["TaskCreate", "`TaskCreate`"],
  ["readonly", "`readonly: true`"],
  ["the `Skill` tool", "the `Skill` tool"],
  ["the `Agent` tool", "the `Agent` tool"],
  ["plugin-dev", "`plugin-dev:skill-development`"],
  ["CLAUDE.md", "`CLAUDE.md`"],
  ["pstack:poteto-agent", "`pstack:poteto-agent`"],
  ["general-purpose", "`general-purpose`"],
  ["isolation: \"worktree\"", "`isolation: \"worktree\"`"],
  [".claude/skills", "`.claude/skills/`"],
  ["${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects", "`${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects/`"],
  ["`loop`", "`loop` skill"],
]);

describe("OpenCode package", () => {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const pathExists = (path) => existsSync(join(root, path));
  test("validates the native server entry and rejects a missing entry or file", () => {
    expect(() => validateOpenCodePackage(manifest, { pathExists })).not.toThrow();
    expect(() => validateOpenCodePackage({ ...manifest, exports: {} }, { pathExists })).toThrow("./server");
    expect(() => validateOpenCodePackage(manifest, { pathExists: () => false })).toThrow("does not exist");
  });
});

describe("OpenCode model names", () => {
  const section = openCodeModelNamesSection(models);
  test("uses user-requested configured IDs and names all role skills", () => {
    expect(section).toContain("providerID/modelID#variant");
    expect(section).toContain("only when the user explicitly");
    expect(section).not.toMatch(/`(?:opus|fable|sonnet|haiku)`/);
    for (const skill of roleSkills(models)) expect(section).toContain(`\`${skill}\``);
  });
  test("matches the generated mapping section", () => expect(mapping).toContain(section));
});
