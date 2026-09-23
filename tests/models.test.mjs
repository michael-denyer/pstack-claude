// models.json is the model policy every stamped Models section, the override
// sheet, and the Codex mapping derive from. Nothing else validates its shape,
// and a role label is the runtime join key between the override sheet the
// user writes and the prose that tells the agent which role to look up.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadModels, resolveModels, section } from "../tools/generate.mjs";
import { markdownFiles } from "../tools/validate-skills.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const skillsDir = join(repoRoot, "plugins/pstack/skills");
const raw = JSON.parse(readFileSync(join(repoRoot, "plugins/pstack/models.json"), "utf8"));
const models = loadModels();
const available = new Set(models.available);

describe("models.json shape", () => {
  test("available slugs are unique and every tier names them", () => {
    expect(available.size).toBe(models.available.length);
    for (const slug of Object.values(raw.tiers).flat()) expect(available.has(slug)).toBe(true);
    expect(new Set(raw.tiers.panel).size).toBe(raw.tiers.panel.length);
  });

  test("available models are the names the Claude Code Agent tool accepts", () => {
    // The Agent tool's `model` parameter is an enum of family names; a full ID
    // such as claude-opus-5-5 is rejected before the subagent starts.
    expect([...available].sort()).toEqual(["fable", "haiku", "opus", "sonnet"]);
  });

  test("every role names a tier or available models, and a skill directory that exists", () => {
    const labels = new Set();
    for (const role of raw.roles) {
      expect(typeof role.role).toBe("string");
      expect(labels.has(role.role)).toBe(false);
      labels.add(role.role);
      expect(existsSync(join(skillsDir, role.skill, "SKILL.md"))).toBe(true);
      if (typeof role.models === "string") {
        expect(Object.hasOwn(raw.tiers, role.models)).toBe(true);
        continue;
      }
      expect(Array.isArray(role.models) && role.models.length > 0).toBe(true);
      for (const slug of role.models) expect(available.has(slug)).toBe(true);
    }
  });

  test("each tier is written once and resolved by reference", () => {
    const tierLists = Object.values(raw.tiers).map((t) => [t].flat().join());
    const literal = raw.roles.filter((r) => Array.isArray(r.models) && tierLists.includes(r.models.join()));
    expect(literal).toEqual([]);
    for (const role of resolveModels(raw).roles.filter((r) => r.tier)) {
      expect(role.models).toEqual([raw.tiers[role.tier]].flat());
    }
  });

  test("the file stays one row per entry so a role change is a one-line diff", () => {
    const text = readFileSync(join(repoRoot, "plugins/pstack/models.json"), "utf8");
    expect(text.split("\n").length).toBeLessThan(raw.roles.length * 2);
    expect(text.match(/^\s*\{ "/gm)).toHaveLength(raw.roles.length);
  });

  test("the codex examples cover every tier and the panel names distinct models", () => {
    expect(Object.keys(raw.codex).sort()).toEqual(Object.keys(raw.tiers).sort());
    expect(new Set(raw.codex.panel).size).toBe(raw.codex.panel.length);
  });
});

describe("role labels reach the prose", () => {
  // The prose may hyphenate a label ("how-explorer" for the sheet's
  // "how explorer") and names only the first segment of a comma-joined label.
  const normalize = (text) => text.toLowerCase().replace(/[-\s]+/g, " ");

  function skillProse(skill) {
    return markdownFiles(join(skillsDir, skill))
      .map((file) => {
        const lines = readFileSync(file, "utf8").split("\n");
        const owned = section("Models")(lines);
        if (owned) lines.splice(owned[0] - 1, owned[1] - owned[0] + 1);
        return lines.join("\n");
      })
      .join("\n");
  }

  for (const role of models.roles) {
    test(`"${role.role}" is named by the ${role.skill} skill outside its stamped section`, () => {
      const needle = normalize(role.role.split(",")[0]);
      expect(normalize(skillProse(role.skill))).toContain(needle);
    });
  }
});
