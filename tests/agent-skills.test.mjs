import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  agentSkills,
  PORTABLE_ASSETS,
  promptStub,
  publicSkills,
  syncPortableAssets,
} from "../tools/generate.mjs";
import { validateProsePaths, validateSkillsTree } from "../tools/validate-skills.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const skillsDir = join(repoRoot, "plugins/pstack/skills");
const agentsDir = join(repoRoot, "plugins/pstack/agents");
const requiredPortableFiles = [
  "poteto-mode/references/agents/comment-sicko.md",
  "poteto-mode/references/agents/poteto-agent.md",
  "poteto-mode/references/licenses/LICENSE",
  "poteto-mode/references/licenses/LICENSE-cursor-team-kit",
  "poteto-mode/references/licenses/NOTICE.md",
];

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
    expect(() => validateSkillsTree(skillsDir)).not.toThrow();
  });

  test("no skill tells the reader to open a plugin path outside the tree", () => {
    expect(() => validateProsePaths(skillsDir)).not.toThrow();
  });

  test("a backticked plugin path in prose fails the boundary check", () => {
    const root = mkdtempSync(join(tmpdir(), "pstack-prose-paths-"));
    try {
      const skill = join(root, "example");
      mkdirSync(skill, { recursive: true });
      writeFileSync(
        join(skill, "SKILL.md"),
        "# Example\n\nRead `agents/comment-sicko.md` in full first.\n",
      );
      expect(() => validateProsePaths(root)).toThrow("example/SKILL.md -> agents/comment-sicko.md");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("prose may name a runtime directory it does not tell the reader to open", () => {
    const root = mkdtempSync(join(tmpdir(), "pstack-prose-allowed-"));
    try {
      const skill = join(root, "example");
      mkdirSync(skill, { recursive: true });
      writeFileSync(
        join(skill, "SKILL.md"),
        "# Example\n\nThe `hooks/` directory is Claude Code only and ships with the plugin.\n",
      );
      expect(() => validateProsePaths(root)).not.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a bare missing markdown target fails the boundary check", () => {
    const root = mkdtempSync(join(tmpdir(), "pstack-skills-links-"));
    const skill = join(root, "example");
    mkdirSync(skill);
    writeFileSync(
      join(skill, "SKILL.md"),
      "[missing](missing.md)\n[external](https://example.com/reference)\n",
    );

    try {
      expect(() => validateSkillsTree(root)).toThrow("example/SKILL.md -> missing.md (missing)");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("bare, dotted, and reference-style local links resolve inside the boundary", () => {
    const root = mkdtempSync(join(tmpdir(), "pstack-skills-links-"));
    const skill = join(root, "example");
    const references = join(skill, "references");
    mkdirSync(references, { recursive: true });
    writeFileSync(join(references, "guide.md"), "# Guide\n");
    writeFileSync(
      join(skill, "SKILL.md"),
      [
        "[bare](references/guide.md)",
        "[dotted](./references/guide.md#section)",
        "[reference][guide]",
        "[external](https://example.com/reference)",
        "[guide]: references/guide.md",
        "[^note]: explanatory footnote text is not a link target",
      ].join("\n"),
    );

    try {
      expect(() => validateSkillsTree(root)).not.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an escaping markdown target fails the boundary check", () => {
    const root = mkdtempSync(join(tmpdir(), "pstack-skills-links-"));
    const skill = join(root, "example");
    mkdirSync(skill);
    writeFileSync(join(skill, "SKILL.md"), "[escape](../../outside.md)\n");

    try {
      expect(() => validateSkillsTree(root)).toThrow(
        "example/SKILL.md -> ../../outside.md (escapes skills tree)",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a markdown symlink target cannot escape the boundary", () => {
    const parent = mkdtempSync(join(tmpdir(), "pstack-skills-links-"));
    const root = join(parent, "skills");
    const skill = join(root, "example");
    const outside = join(parent, "outside.md");
    mkdirSync(skill, { recursive: true });
    writeFileSync(outside, "outside\n");
    symlinkSync(outside, join(skill, "linked.md"));
    writeFileSync(join(skill, "SKILL.md"), "[escape](linked.md)\n");

    try {
      expect(() => validateSkillsTree(root)).toThrow(
        "example/SKILL.md -> linked.md (escapes skills tree through symlink)",
      );
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("the subagent definitions dispatched by name install with the skills", () => {
    const vendored = join(skillsDir, "poteto-mode", "references", "agents");
    for (const name of ["poteto-agent", "comment-sicko"]) {
      const copy = readFileSync(join(vendored, `${name}.md`), "utf8");
      expect(copy).toBe(readFileSync(join(agentsDir, `${name}.md`), "utf8"));
      expect(copy).toContain(`name: ${name}`);
    }
  });

  test("every required portable asset lives inside the skills tree", () => {
    for (const file of requiredPortableFiles) {
      expect(existsSync(join(skillsDir, file))).toBe(true);
    }
    for (const { source, target } of PORTABLE_ASSETS) {
      expect(readFileSync(join(skillsDir, target), "utf8")).toBe(
        readFileSync(join(repoRoot, source), "utf8"),
      );
    }
  });

  test("portable asset sync creates, updates, and removes generated files", () => {
    const root = mkdtempSync(join(tmpdir(), "pstack-portable-assets-"));
    const fixtureRepo = join(root, "repo");
    const fixtureSkills = join(fixtureRepo, "plugins/pstack/skills");
    const generatedDirs = new Set(PORTABLE_ASSETS.map(({ target }) => dirname(target)));

    try {
      for (const { source } of PORTABLE_ASSETS) {
        const path = join(fixtureRepo, source);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, `source: ${source}\n`);
      }
      for (const dir of generatedDirs) {
        const output = join(fixtureSkills, dir);
        mkdirSync(output, { recursive: true });
        writeFileSync(join(output, "stale.md"), "stale\n");
      }

      expect(syncPortableAssets(fixtureRepo, fixtureSkills, { log() {} })).toEqual({
        stamped: PORTABLE_ASSETS.length,
        removed: generatedDirs.size,
        total: PORTABLE_ASSETS.length,
      });
      for (const { source, target } of PORTABLE_ASSETS) {
        expect(readFileSync(join(fixtureSkills, target), "utf8")).toBe(
          readFileSync(join(fixtureRepo, source), "utf8"),
        );
      }
      for (const dir of generatedDirs) {
        expect(existsSync(join(fixtureSkills, dir, "stale.md"))).toBe(false);
      }

      expect(syncPortableAssets(fixtureRepo, fixtureSkills, { log() {} })).toEqual({
        stamped: 0,
        removed: 0,
        total: PORTABLE_ASSETS.length,
      });

      const changed = PORTABLE_ASSETS[0];
      writeFileSync(join(fixtureRepo, changed.source), "changed\n");
      expect(syncPortableAssets(fixtureRepo, fixtureSkills, { log() {} })).toEqual({
        stamped: 1,
        removed: 0,
        total: PORTABLE_ASSETS.length,
      });
      expect(readFileSync(join(fixtureSkills, changed.target), "utf8")).toBe("changed\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("portable asset sync refuses an output directory symlink escape", () => {
    const root = mkdtempSync(join(tmpdir(), "pstack-portable-assets-"));
    const fixtureRepo = join(root, "repo");
    const fixtureSkills = join(fixtureRepo, "plugins/pstack/skills");
    const agentsOutput = join(fixtureSkills, "poteto-mode/references/agents");
    const outside = join(root, "outside");

    try {
      for (const { source } of PORTABLE_ASSETS) {
        const path = join(fixtureRepo, source);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, `source: ${source}\n`);
      }
      mkdirSync(dirname(agentsOutput), { recursive: true });
      mkdirSync(outside);
      symlinkSync(outside, agentsOutput, "dir");

      expect(() => syncPortableAssets(fixtureRepo, fixtureSkills, { log() {} })).toThrow(
        "poteto-mode/references/agents resolves outside the skills tree through a symlink",
      );
      expect(existsSync(join(outside, "poteto-agent.md"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
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
