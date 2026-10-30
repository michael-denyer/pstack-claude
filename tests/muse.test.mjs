// Muse build contracts: the mapping names every Claude-specific term the
// skills use, the native manifest lists exactly the shipped skills, and the
// Muse model section renders Muse IDs with no Claude slug.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { agentSkills, loadModels } from "../tools/generate.mjs";
import { PLUGIN } from "../tools/plugin.mjs";
import { museModelNamesSection, RUNTIMES, stampMuseManifest } from "../tools/runtimes.mjs";
import { mappingCoverage } from "./mapping-coverage.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const skillsDir = join(repoRoot, PLUGIN, "skills");
const muse = RUNTIMES.find((runtime) => runtime.key === "muse");
const mapping = readFileSync(join(repoRoot, muse.tools), "utf8");
const models = loadModels();
const manifest = JSON.parse(readFileSync(join(repoRoot, PLUGIN, ".muse-plugin/plugin.json"), "utf8"));

// Claude-specific terms a skill may name, and the text muse-tools.md must
// carry to map each one.
mappingCoverage(muse, [
  ["AskUserQuestion", "`AskUserQuestion`"],
  ["subagent_type", "`subagent_type"],
  ["run_in_background", "`run_in_background: true`"],
  ["TodoWrite", "`TodoWrite`"],
  ["TaskCreate", "`TaskCreate`"],
  ["readonly", "`readonly: true`"],
  ["the `Skill` tool", "the `Skill` tool"],
  ["the `Agent` tool", "the `Agent`/`Task` tool"],
  ["plugin-dev", "`plugin-dev:skill-development`"],
  [".claude/skills", "`.claude/skills/`"],
  ["CLAUDE.md", "`CLAUDE.md`"],
  ["pstack:poteto-agent", "`pstack:poteto-agent`"],
  ["general-purpose", "`general-purpose`"],
]);

describe("muse-tools.md Model names", () => {
  test("the Model names section carries the Muse tier models", () => {
    for (const id of [models.muse.default, models.muse.strongest, models.muse.worker, ...models.muse.panel]) {
      expect(mapping).toContain(id);
    }
    const section = museModelNamesSection(models);
    expect(section).toContain("subagent_spawn");
    expect(section).not.toMatch(/`(?:opus|fable|sonnet|haiku)`/);
  });
});

describe("Muse manifest", () => {
  test("lists exactly the shipped skills, each at its SKILL.md, and no commands", () => {
    const shipped = agentSkills(skillsDir).map(({ name }) => name).sort();
    const listed = manifest.capabilities.skills.map(({ id }) => id).sort();
    expect(listed).toEqual(shipped);
    for (const entry of manifest.capabilities.skills) {
      expect(entry.path).toBe(`skills/${entry.id}/SKILL.md`);
      expect(existsSync(join(repoRoot, PLUGIN, entry.path))).toBe(true);
    }
    expect(manifest.capabilities.commands).toEqual([]);
  });

  test("stampMuseManifest rewrites the skill list and the hooks", () => {
    const stale = structuredClone(manifest);
    stale.capabilities.skills = [];
    stale.capabilities.hooks = [];
    const stamped = JSON.parse(stampMuseManifest(JSON.stringify(stale), { skills: ["how", "poteto-mode"] }));
    expect(stamped.capabilities.skills).toEqual([
      { id: "how", path: "skills/how/SKILL.md", enabledDefault: true },
      { id: "poteto-mode", path: "skills/poteto-mode/SKILL.md", enabledDefault: true },
    ]);
    expect(stamped.capabilities.hooks).toEqual(manifest.capabilities.hooks);
  });
});
