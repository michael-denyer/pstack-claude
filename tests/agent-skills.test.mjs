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
  codexModelNamesSection,
  PORTABLE_ASSETS,
  plan,
  problems,
  publicSkills,
  resolveModels,
} from "../tools/generate.mjs";
import { validateProsePaths, validateSkillsTree, walk } from "../tools/validate-skills.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const skillsDir = join(repoRoot, "plugins/pstack/skills");
const requiredPortableFiles = [
  "poteto-mode/references/agents/comment-sicko.md",
  "poteto-mode/references/licenses/LICENSE",
  "poteto-mode/references/licenses/LICENSE-cursor-team-kit",
  "poteto-mode/references/licenses/NOTICE.md",
];

describe("shared Agent Skills tree", () => {
  test("public skills include poteto-mode and exclude every principle leaf", () => {
    const names = publicSkills(skillsDir);
    expect(names).toContain("poteto-mode");
    expect(names.some((n) => n.startsWith("principle-"))).toBe(false);
  });

  test("the working tree breaks no cross-file contract", () => {
    expect(problems(repoRoot)).toEqual([]);
  });

  test("prose naming a real plugin file outside the skills tree fails the boundary check", () => {
    const plugin = mkdtempSync(join(tmpdir(), "pstack-prose-paths-"));
    const root = join(plugin, "skills");
    try {
      mkdirSync(join(plugin, "agents"), { recursive: true });
      writeFileSync(join(plugin, "agents/comment-sicko.md"), "# agent\n");
      const skill = join(root, "example");
      mkdirSync(skill, { recursive: true });
      for (const prose of [
        "Read `agents/comment-sicko.md` in full first.",
        "Read `./agents/comment-sicko.md` in full first.",
        "The `agents/comment-sicko.md` file ships only with the plugin.",
        "Open `../../agents/comment-sicko.md`.",
      ]) {
        writeFileSync(join(skill, "SKILL.md"), `# Example\n\n${prose}\n`);
        expect(() => validateProsePaths(root)).toThrow("agents/comment-sicko.md is not installed with the skills tree");
      }
    } finally {
      rmSync(plugin, { recursive: true, force: true });
    }
  });

  test("prose paths that resolve inside the tree or to nothing are left alone", () => {
    const plugin = mkdtempSync(join(tmpdir(), "pstack-prose-allowed-"));
    const root = join(plugin, "skills");
    try {
      mkdirSync(join(plugin, "hooks"), { recursive: true });
      mkdirSync(join(root, "mode/playbooks"), { recursive: true });
      mkdirSync(join(root, "mode/references"), { recursive: true });
      writeFileSync(join(root, "mode/playbooks/babysit.md"), "# playbook\n");
      writeFileSync(
        join(root, "mode/references/triage.md"),
        [
          "# Reference",
          "",
          "Read `../playbooks/babysit.md` first.",
          "Write the log to `/tmp/<slug>-resume.md` and run `/setup-pstack`.",
          "Edit `plugins/pstack/models.json`, then rerun `tools/generate.mjs`.",
          "Cursor keeps rules in `.cursor/rules/`; Claude Code has no `hooks/nope.md`.",
        ].join("\n"),
      );
      expect(() => validateProsePaths(root)).not.toThrow();
    } finally {
      rmSync(plugin, { recursive: true, force: true });
    }
  });

  test("walk returns a sorted listing regardless of directory order", () => {
    const root = mkdtempSync(join(tmpdir(), "pstack-walk-"));
    try {
      for (const name of ["zeta", "alpha", "mid"]) {
        mkdirSync(join(root, name));
        writeFileSync(join(root, name, "SKILL.md"), "# x\n");
      }
      expect(walk(root).map((p) => p.slice(root.length + 1))).toEqual([
        "alpha/SKILL.md",
        "mid/SKILL.md",
        "zeta/SKILL.md",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an installed node_modules under a skill is not validated", () => {
    const root = mkdtempSync(join(tmpdir(), "pstack-skills-links-"));
    const vendored = join(root, "example/scripts/node_modules/dep");
    mkdirSync(vendored, { recursive: true });
    writeFileSync(join(root, "example/SKILL.md"), "# Example\n");
    writeFileSync(join(vendored, "Readme.md"), "[docs](./docs/missing.md)\nRead `../../../../etc/passwd`.\n");

    try {
      expect(() => validateSkillsTree(root)).not.toThrow();
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

  test("every vendored subagent definition has a skill that tells Codex to read it", () => {
    const prose = walk(skillsDir)
      .filter((file) => file.endsWith(".md"))
      .map((file) => readFileSync(file, "utf8"))
      .join("\n");
    const vendored = PORTABLE_ASSETS.map(({ target }) => target).filter((target) => target.includes("/agents/"));
    expect(vendored.length).toBeGreaterThan(0);
    expect(vendored.filter((target) => !prose.includes(target))).toEqual([]);
  });

  test("every required portable asset lives inside the skills tree", () => {
    for (const file of requiredPortableFiles) {
      expect(existsSync(join(skillsDir, file))).toBe(true);
    }
  });

  test("the plan copies each portable asset from its source into a directory it owns", () => {
    const { files, ownedDirs } = plan(repoRoot);
    for (const { source, target } of PORTABLE_ASSETS) {
      expect(files[`plugins/pstack/skills/${target}`]).toBe(readFileSync(join(repoRoot, source), "utf8"));
      expect(ownedDirs).toContain(`plugins/pstack/skills/${dirname(target)}`);
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
      for (const file of [
        join(poteto, "SKILL.md"),
        join(poteto, "references", "codex-tools.md"),
        join(poteto, "..", "principle-model-the-domain", "SKILL.md"),
      ]) {
        expect(readFileSync(file, "utf8").length).toBeGreaterThan(0);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("agentSkills reads frontmatter as YAML", () => {
  function readSkill(name, text) {
    const root = mkdtempSync(join(tmpdir(), "pstack-frontmatter-"));
    try {
      mkdirSync(join(root, name));
      writeFileSync(join(root, name, "SKILL.md"), text);
      return agentSkills(root)[0];
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  test("a folded block scalar description is read as its folded value", () => {
    const skill = readSkill("folded", "---\nname: folded\ndescription: >-\n  Use when\n  folding.\n---\n\nbody\n");
    expect(skill.description).toBe("Use when folding.");
  });

  test("the 1024 limit measures the parsed description, not its YAML source", () => {
    const value = "a".repeat(990) + '"'.repeat(30);
    const quoted = readSkill("quoted", `---\nname: quoted\ndescription: ${JSON.stringify(value)}\n---\n`);
    expect(quoted.description).toBe(value);
    expect(() => readSkill("long", `---\nname: long\ndescription: >-\n  ${"a".repeat(1025)}\n---\n`)).toThrow(
      "description exceeds the portable Agent Skills limit of 1024 characters",
    );
  });

  test("a CRLF file yields its name", () => {
    expect(readSkill("crlf", "---\r\nname: crlf\r\ndescription: d\r\n---\r\n\r\nbody\r\n").name).toBe("crlf");
  });

  test("user-invocable: false with a trailing space reads as not user-invocable", () => {
    expect(readSkill("spaced", "---\nname: spaced\ndescription: d\nuser-invocable: false \n---\n").userInvocable).toBe(
      false,
    );
  });
});

describe("Codex model names", () => {
  test("names a strongest Codex model for the roles that default to it on Claude", () => {
    const raw = JSON.parse(readFileSync(join(repoRoot, "plugins/pstack/models.json"), "utf8"));
    const oneOff = raw.roles.map((r) => (r.role === "swarm workers" ? { ...r, models: ["haiku"] } : r));
    const section = codexModelNamesSection(resolveModels({ ...raw, roles: oneOff }));
    const strongestLine = section.split("\n").find((line) => line.includes("strongest Claude model"));

    expect(strongestLine).not.toContain("swarm workers");

    expect(strongestLine).toContain(`\`${raw.codex.strongest}\``);
    for (const role of ["bug-fix", "perf-issue", "hillclimb", "strongest judgment"]) {
      expect(section).toContain(role);
    }
    for (const family of raw.available) expect(section).not.toContain(`\`${family}\``);
  });
});
