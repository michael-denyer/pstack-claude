// models.json is the model policy every stamped Models section, the override
// sheet, and the Codex mapping derive from. parseModels checks its shape when
// the generator loads it, and a role label is the runtime join key between the
// override sheet the user writes and the prose that tells the agent which role
// to look up.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { loadModels, parseModels, regions } from "../tools/generate.mjs";
import { markdownFiles } from "../tools/validate-skills.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const skillsDir = join(repoRoot, "plugins/pstack/skills");
const raw = JSON.parse(readFileSync(join(repoRoot, "plugins/pstack/models.json"), "utf8"));
const models = loadModels();

describe("committed models.json", () => {
  test("the pi block gives every available alias a Pi model on anthropic, openai, and openai-codex", () => {
    expect(raw.pi.fallback).toBe("anthropic");
    expect(Object.keys(raw.pi.models).sort()).toEqual(["anthropic", "openai", "openai-codex"]);
    for (const table of Object.values(raw.pi.models)) {
      expect(Object.keys(table).sort()).toEqual([...models.available].sort());
    }
  });

  test("available models are the names the Claude Code Agent tool accepts", () => {
    // The Agent tool's `model` parameter is an enum of family names; a full ID
    // such as claude-opus-5-5 is rejected before the subagent starts.
    expect([...models.available].sort()).toEqual(["fable", "haiku", "opus", "sonnet"]);
  });

  test("the file stays one row per entry so a role change is a one-line diff", () => {
    const text = readFileSync(join(repoRoot, "plugins/pstack/models.json"), "utf8");
    expect(text.match(/^\s*\{ "/gm)).toHaveLength(raw.roles.length);
  });
});

describe("parseModels", () => {
  const anySkill = () => true;
  const parse = (mutate, skillExists = anySkill) => {
    const policy = structuredClone(raw);
    mutate(policy);
    return () => parseModels(policy, skillExists);
  };
  const role = (policy, label) => policy.roles.find((r) => r.role === label);

  test("resolves a tier by reference and keeps its name on the role", () => {
    const resolved = parseModels(structuredClone(raw), anySkill);
    const arena = role(resolved, "arena runners");
    expect(arena.tier).toBe("panel");
    expect(arena.models).toEqual(raw.tiers.panel);
    expect(role(resolved, "bug-fix").models).toEqual([raw.tiers.strongest]);
  });

  test("a missing top-level key throws naming it", () => {
    expect(parse((p) => delete p.efforts)).toThrow('models.json: "efforts" must be a list');
    expect(parse((p) => delete p.codex)).toThrow('models.json: "codex" must be an object');
  });

  test("a role naming an undefined tier throws naming the role and the tier", () => {
    expect(parse((p) => (role(p, "bug-fix").models = "strongset"))).toThrow(
      'models.json: role "bug-fix" names tier "strongset", which tiers does not define',
    );
  });

  test("a slug outside available throws naming it, in a role or a tier", () => {
    expect(parse((p) => (role(p, "swarm workers").models = ["opsu"]))).toThrow(
      'models.json: role "swarm workers" names "opsu", which is not in available',
    );
    expect(parse((p) => (p.tiers.panel = ["opus", "gpt"]))).toThrow(
      'models.json: tier "panel" names "gpt", which is not in available',
    );
  });

  test("a role with no models throws naming the role", () => {
    expect(parse((p) => (role(p, "swarm workers").models = []))).toThrow(
      'models.json: role "swarm workers" needs a tier name or a non-empty list of models',
    );
  });

  test("a role list that repeats a tier throws, so the tier is written once", () => {
    expect(parse((p) => (role(p, "arena runners").models = [...raw.tiers.panel]))).toThrow(
      'models.json: role "arena runners" lists tier "panel" literally; name the tier',
    );
  });

  test("a duplicate role label throws naming it", () => {
    expect(parse((p) => p.roles.push({ ...role(p, "how explorer") }))).toThrow(
      'models.json: role "how explorer" appears twice',
    );
  });

  test("a role whose skill directory does not exist throws naming both", () => {
    expect(parse(() => {}, (skill) => skill !== "why")).toThrow(
      'models.json: role "why investigators" names skill "why", which has no SKILL.md',
    );
  });

  test("a duplicate slug in available or in a panel throws naming it", () => {
    expect(parse((p) => p.available.push("opus"))).toThrow('models.json: available lists "opus" twice');
    expect(parse((p) => (p.tiers.panel = ["opus", "opus"]))).toThrow('models.json: tier "panel" lists "opus" twice');
    expect(parse((p) => (p.codex.panel = ["a", "a"]))).toThrow('models.json: codex "panel" lists "a" twice');
  });

  test("an effort level Claude Code does not accept, or a repeated one, throws naming it", () => {
    expect(parse((p) => p.efforts.push("extreme"))).toThrow(
      'models.json: effort "extreme" is not one of low, medium, high, xhigh, max',
    );
    expect(parse((p) => p.efforts.push("low"))).toThrow('models.json: efforts lists "low" twice');
  });

  test("a defaultEffort that is neither a level nor session throws naming it", () => {
    expect(parse((p) => (p.defaultEffort = "hgih"))).toThrow(
      'models.json: defaultEffort "hgih" is not an effort level or "session"',
    );
  });

  test("each pi provider table must map exactly the available aliases to that provider's models", () => {
    expect(parse((p) => delete p.pi)).toThrow('models.json: "pi" must be an object');
    expect(parse((p) => delete p.pi.models)).toThrow('models.json: pi needs a "models" object');
    expect(parse((p) => (p.pi.extra = 1))).toThrow('models.json: pi names "extra"; its keys are "fallback" and "models"');
    expect(parse((p) => (p.pi.fallback = "google"))).toThrow('models.json: pi.fallback "google" is not a provider in pi.models');
    expect(parse((p) => (p.pi.models.openai = "openai/gpt"))).toThrow("models.json: pi.models.openai must be an object");
    expect(parse((p) => delete p.pi.models["openai-codex"].haiku)).toThrow(
      'models.json: pi.models.openai-codex has no Pi model for "haiku"',
    );
    expect(parse((p) => (p.pi.models.anthropic.gpt = "anthropic/gpt"))).toThrow(
      'models.json: pi.models.anthropic names "gpt", which is not in available',
    );
    expect(parse((p) => (p.pi.models.anthropic.opus = "claude-opus"))).toThrow(
      'models.json: pi.models.anthropic "opus" is "claude-opus", not a anthropic/<id>',
    );
    expect(parse((p) => (p.pi.models.anthropic.opus = "openai-codex/gpt-6-sol"))).toThrow(
      'models.json: pi.models.anthropic "opus" is "openai-codex/gpt-6-sol", not a anthropic/<id>',
    );
  });

  test("a codex block that misses or adds a tier throws naming the tier", () => {
    expect(parse((p) => delete p.codex.strongest)).toThrow('models.json: codex has no example for tier "strongest"');
    expect(parse((p) => (p.codex.fastest = "gpt"))).toThrow('models.json: codex names "fastest", which is not a tier');
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
        const owned = regions(models)
          .filter((r) => r.file === relative(repoRoot, file))
          .map((r) => r.locate(lines))
          .filter(Boolean);
        return lines.filter((_, i) => !owned.some(([s, e]) => i >= s && i < e)).join("\n");
      })
      .join("\n");
  }

  for (const role of models.roles) {
    test(`"${role.role}" is named by the ${role.skill} skill outside its stamped regions`, () => {
      const needle = normalize(role.role.split(",")[0]);
      expect(normalize(skillProse(role.skill))).toContain(needle);
    });
  }
});
