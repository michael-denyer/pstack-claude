import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { agentSkills, promptStub, publicSkills } from "../tools/generate.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const skillsDir = join(repoRoot, "plugins/pstack/skills");
const agentsDir = join(repoRoot, "plugins/pstack/agents");

function markdownFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return markdownFiles(path);
    return entry.name.endsWith(".md") ? [path] : [];
  });
}

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

  test("no markdown link escapes the skills tree", () => {
    const offenders = [];
    for (const file of markdownFiles(skillsDir)) {
      for (const [, target] of readFileSync(file, "utf8").matchAll(/\]\(([^)]+)\)/g)) {
        const path = target.trim().split("#")[0];
        if (!path || !/^\.{0,2}\//.test(path)) continue;
        const resolved = resolve(dirname(file), path);
        if (relative(skillsDir, resolved).startsWith("..")) {
          offenders.push(`${relative(skillsDir, file)} -> ${path}`);
        }
        if (!existsSync(resolved)) {
          offenders.push(`${relative(skillsDir, file)} -> ${path} (missing)`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("the subagent definitions dispatched by name install with the skills", () => {
    const vendored = join(skillsDir, "poteto-mode", "references", "agents");
    for (const name of ["poteto-agent", "comment-sicko"]) {
      const copy = readFileSync(join(vendored, `${name}.md`), "utf8");
      expect(copy).toBe(readFileSync(join(agentsDir, `${name}.md`), "utf8"));
      expect(copy).toContain(`name: ${name}`);
    }
  });

  test("the MIT terms covering the vendored prose travel with the skills tree", () => {
    for (const file of ["LICENSE", "LICENSE-cursor-team-kit", "NOTICE.md"]) {
      expect(readFileSync(join(skillsDir, "poteto-mode/references/licenses", file), "utf8")).toBe(
        readFileSync(join(repoRoot, file), "utf8"),
      );
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
