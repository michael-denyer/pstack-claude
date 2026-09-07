// Proves each static layout invariant still fails when it should. A check
// that quietly matches nothing looks identical to a pass, and that already
// happened once (the 0.9.10 quad check hunted a retired slug for a whole
// release), so every check gets a fixture that must trip it.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { agentSkills, validatePluginLayout } from "../tools/generate.mjs";

function skill(root, name, front, body = "body\n") {
  mkdirSync(join(root, "skills", name), { recursive: true });
  writeFileSync(
    join(root, "skills", name, "SKILL.md"),
    `---\nname: ${name}\ndescription: fixture\n${front}---\n\n${body}`,
  );
}

function agent(root, name) {
  mkdirSync(join(root, "agents"), { recursive: true });
  writeFileSync(join(root, "agents", `${name}.md`), `---\nname: ${name}\ndescription: fixture\n---\n`);
}

function plugin(mutate = () => {}) {
  const root = mkdtempSync(join(tmpdir(), "invariants-"));
  skill(root, "good", "");
  skill(root, "principle-good", "user-invocable: false\n");
  mutate(root);
  return root;
}

const check = (root) => {
  agentSkills(join(root, "skills"));
  validatePluginLayout(root);
};

describe("static plugin invariants", () => {
  test("a clean tree passes", () => {
    expect(() => check(plugin())).not.toThrow();
  });

  test("a commands/ directory fails", () => {
    const root = plugin((r) => mkdirSync(join(r, "commands"), { recursive: true }));
    expect(() => check(root)).toThrow("plugins/pstack/commands/ exists");
  });

  test("disable-model-invocation on a skill fails and names the file", () => {
    const root = plugin((r) => skill(r, "flagged", "disable-model-invocation: true\n"));
    expect(() => check(root)).toThrow(/skills\/flagged\/SKILL\.md: disable-model-invocation: true breaks/);
  });

  test("a principle leaf missing user-invocable: false fails", () => {
    const root = plugin((r) => skill(r, "principle-visible", ""));
    expect(() => check(root)).toThrow(/principle-visible\/SKILL\.md: principle leaves carry user-invocable: false/);
  });

  test("a principle leaf carrying disable-model-invocation fails", () => {
    const root = plugin((r) => skill(r, "principle-dead", "user-invocable: false\ndisable-model-invocation: true\n"));
    expect(() => check(root)).toThrow(/principle-dead\/SKILL\.md: disable-model-invocation/);
  });

  test("a skill dispatching a plugin agent by its bare name fails and names the site", () => {
    const root = plugin((r) => {
      agent(r, "poteto-agent");
      skill(r, "caller", "", 'Spawn with `subagent_type: "poteto-agent"`.\n');
    });
    expect(() => check(root)).toThrow(
      'skills/caller/SKILL.md:6: subagent_type: "poteto-agent" (use "pstack:poteto-agent")',
    );
  });

  test("a skill dispatching a plugin agent by its namespaced name passes", () => {
    const root = plugin((r) => {
      agent(r, "poteto-agent");
      skill(r, "caller", "", 'Spawn with `subagent_type: "pstack:poteto-agent"`.\n');
    });
    expect(() => check(root)).not.toThrow();
  });

  test("the body of a skill may mention the flag in prose", () => {
    const root = plugin();
    writeFileSync(
      join(root, "skills/good/SKILL.md"),
      "---\nname: good\ndescription: fixture\n---\n\nNever set disable-model-invocation: true on a skill.\n",
    );
    expect(() => check(root)).not.toThrow();
  });
});
