import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { agentSkills, promptStub, publicSkills } from "../tools/generate.mjs";

const skillsDir = fileURLToPath(new URL("../plugins/pstack/skills", import.meta.url));

describe("shared Agent Skills tree", () => {
  test("every skill satisfies the portable name and description boundary", () => {
    const skills = agentSkills(skillsDir);
    expect(skills.length).toBeGreaterThan(0);
    for (const skill of skills) {
      expect(skill.name).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      expect(skill.name.length).toBeLessThanOrEqual(64);
      expect(skill.description.length).toBeGreaterThan(0);
      expect(skill.description.length).toBeLessThanOrEqual(1024);
    }
  });

  test("derives the public Codex prompts from the validated shared skills", () => {
    const skills = publicSkills(skillsDir);
    expect(skills.length).toBeGreaterThan(0);
    for (const skill of skills) {
      const out = promptStub(skill);
      expect(out).toContain(`name: ${skill.name}`);
      expect(out).toContain("disable-model-invocation: true");
      expect(out).toContain(`Invoke the \`${skill.name}\` skill and follow it.`);
    }
  });

  test("linked skills keep their own resources and sibling principle leaves", () => {
    const root = mkdtempSync(join(tmpdir(), "pstack-agent-skills-"));
    const installed = join(root, "unrelated-home", ".agents", "skills");
    mkdirSync(installed, { recursive: true });

    try {
      for (const { name } of agentSkills(skillsDir)) {
        symlinkSync(join(skillsDir, name), join(installed, name), "dir");
      }

      const poteto = join(installed, "poteto-mode");
      expect(readFileSync(join(poteto, "SKILL.md"), "utf8")).toContain("# Poteto mode");
      expect(readFileSync(join(poteto, "references", "codex-tools.md"), "utf8")).toContain(
        "# Codex tool mapping for pstack",
      );
      expect(
        readFileSync(join(poteto, "..", "principle-model-the-domain", "SKILL.md"), "utf8"),
      ).toContain("# Model the Domain");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
