// Antigravity (agy) build contracts: the mapping names every Claude-specific
// term the skills use, the native manifest and SessionStart hook validate, and
// the model section names no Claude slug.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { agentSkills, loadLeadLines, loadModels, noteSkills } from "../tools/generate.mjs";
import { PLUGIN } from "../tools/plugin.mjs";
import { agyModelNamesSection, roleSkills, RUNTIMES, validateAgyManifest } from "../tools/runtimes.mjs";
import { mappingCoverage } from "./mapping-coverage.mjs";
import { sheetCases, writeSheet } from "./session-hook-sheets.mjs";

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

describe("Antigravity packaging", () => {
  const inTree = (rel) => existsSync(join(repoRoot, rel));
  const readTree = (rel) => readFileSync(join(repoRoot, rel), "utf8");
  const claude = JSON.parse(readTree(`${PLUGIN}/.claude-plugin/plugin.json`));
  const manifest = JSON.parse(readTree(`${PLUGIN}/.antigravity-plugin/plugin.json`));
  const hook = join(repoRoot, `${PLUGIN}/hooks/agy-session-start.sh`);
  const mandate = readTree(`${PLUGIN}/hooks/session-start-agy.md`);

  test("the native manifest and root hooks.json validate", () => {
    expect(agy.manifest).toBe(`${PLUGIN}/.antigravity-plugin/plugin.json`);
    expect(() => validateAgyManifest(manifest, { claude, read: readTree, pathExists: inTree })).not.toThrow();
    expect(() => validateAgyManifest({ ...manifest, logo: "assets/nope.png" }, { claude, read: readTree, pathExists: inTree })).toThrow(
      "assets/nope.png does not exist",
    );
    expect(() =>
      validateAgyManifest(manifest, {
        claude,
        read: readTree,
        pathExists: (rel) => rel !== `${PLUGIN}/hooks/agy-context.awk` && inTree(rel),
      }),
    ).toThrow("hooks/agy-context.awk does not exist");
    expect(() =>
      validateAgyManifest(manifest, {
        claude,
        read: (rel) => (rel === `${PLUGIN}/hooks.json` ? "{}" : readTree(rel)),
        pathExists: inTree,
      }),
    ).toThrow("hooks.json must declare ./hooks/agy-session-start.sh");
  });

  test("the Antigravity mandate names only skills that exist", () => {
    const named = [...mandate.matchAll(/`([a-z0-9-]+)`/g)]
      .map((m) => m[1])
      .filter((name) => !["read_file"].includes(name));
    const skills = new Set(agentSkills(join(repoRoot, `${PLUGIN}/skills`)).map(({ name }) => name));
    expect(named).toContain("poteto-mode");
    expect(named.filter((name) => !skills.has(name))).toEqual([]);
  });

  test("agy-session-start.sh emits injectSteps JSON when no sheet exists", () => {
    const home = mkdtempSync(join(tmpdir(), "pstack-agy-"));
    try {
      const on = spawnSync("sh", [hook], { env: { ...process.env, HOME: home }, encoding: "utf8" });
      expect({ status: on.status, err: on.stderr }).toEqual({ status: 0, err: "" });
      const parsed = JSON.parse(on.stdout);
      expect(parsed.injectSteps?.[0]?.systemMessage?.systemMessage).toBe(mandate.trimEnd());
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  for (const { name, sheet, off } of sheetCases) {
    test(`agy-session-start.sh ${off ? "emits {}" : "injects the mandate"} when the sheet has ${name}`, () => {
      const home = mkdtempSync(join(tmpdir(), "pstack-agy-"));
      const dir = join(home, ".gemini/config");
      mkdirSync(dir, { recursive: true });
      writeSheet(join(dir, "pstack-models.md"), sheet);
      try {
        const r = spawnSync("sh", [hook], { env: { ...process.env, HOME: home }, encoding: "utf8" });
        expect({ status: r.status, err: r.stderr }).toEqual({ status: 0, err: "" });
        if (off) expect(r.stdout).toBe("{}\n");
        else expect(JSON.parse(r.stdout).injectSteps?.[0]?.systemMessage?.systemMessage).toBe(mandate.trimEnd());
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });
  }
});

describe("Antigravity preambles", () => {
  const leads = loadLeadLines();

  test("every skill noted for Codex is also noted for Antigravity", () => {
    const noted = (runtime) => noteSkills(runtime, readFileSync(join(repoRoot, runtime.tools), "utf8"));
    const agyNoted = noted(agy);
    for (const skill of noted(codex)) expect({ skill, noted: agyNoted.includes(skill) }).toEqual({ skill, noted: true });
  });

  test("stamps the Antigravity preamble in each noted skill", () => {
    expect(agy.preamble).toBe(
      "On Antigravity, read the [platform mapping](../poteto-mode/references/agy-tools.md), including its per-skill notes, before following this skill.",
    );
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
