// Antigravity (agy) build contracts: the mapping names every Claude-specific
// term the skills use, the native manifest and SessionStart hook validate, and
// the model section names no Claude slug.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadModels } from "../tools/generate.mjs";
import { PLUGIN } from "../tools/plugin.mjs";
import { agyModelNamesSection, roleSkills, RUNTIMES, validateAgyManifest } from "../tools/runtimes.mjs";
import { mappingCoverage } from "./mapping-coverage.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
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

describe("Antigravity packaging", () => {
  const inTree = (rel) => existsSync(join(repoRoot, rel));
  const claude = JSON.parse(readFileSync(join(repoRoot, `${PLUGIN}/.claude-plugin/plugin.json`), "utf8"));
  const manifest = JSON.parse(readFileSync(join(repoRoot, `${PLUGIN}/.antigravity-plugin/plugin.json`), "utf8"));

  test("the native manifest and root hooks.json validate", () => {
    expect(agy.manifest).toBe(`${PLUGIN}/.antigravity-plugin/plugin.json`);
    expect(() => validateAgyManifest(manifest, { claude, pathExists: inTree })).not.toThrow();
  });

  test("agy-session-start.sh emits injectSteps JSON and respects session hook: off", () => {
    const home = mkdtempSync(join(tmpdir(), "pstack-agy-"));
    try {
      const hook = join(repoRoot, `${PLUGIN}/hooks/agy-session-start.sh`);
      const on = spawnSync("sh", [hook], { env: { ...process.env, HOME: home }, encoding: "utf8" });
      expect({ status: on.status, err: on.stderr }).toEqual({ status: 0, err: "" });
      const parsed = JSON.parse(on.stdout);
      expect(parsed.injectSteps?.[0]?.systemMessage?.systemMessage).toContain("references/agy-tools.md");

      mkdirSync(join(home, ".gemini/config"), { recursive: true });
      writeFileSync(join(home, ".gemini/config/pstack-models.md"), "session hook: off\n");
      const off = spawnSync("sh", [hook], { env: { ...process.env, HOME: home }, encoding: "utf8" });
      expect({ status: off.status, out: off.stdout, err: off.stderr }).toEqual({ status: 0, out: "{}\n", err: "" });
    } finally {
      rmSync(home, { recursive: true, force: true });
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
