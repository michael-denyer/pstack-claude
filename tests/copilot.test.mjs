// GitHub Copilot build contracts: the mapping names every Claude-specific term
// the skills use, every skill with a Codex preamble also has the Copilot one,
// and Copilot setup writes every role in models.json exactly once.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { loadLeadLines, loadModels, noteSkills } from "../tools/generate.mjs";
import { RUNTIMES } from "../tools/runtimes.mjs";
import { markdownFiles } from "../tools/validate-skills.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const skillsDir = join(repoRoot, "plugins/pstack/skills");
const mappingPath = join(skillsDir, "poteto-mode/references/copilot-tools.md");
const mapping = readFileSync(mappingPath, "utf8");
const models = loadModels();

// Claude-specific terms a skill may name, and the text copilot-tools.md must
// carry to map each one. A term the skills stop using drops out of the check.
const TERMS = [
  ["AskUserQuestion", "`AskUserQuestion`"],
  ["subagent_type", "`subagent_type"],
  ["run_in_background", "`run_in_background: true`"],
  ["TodoWrite", "`TodoWrite`"],
  ["TaskCreate", "`TaskCreate`"],
  ["TaskUpdate", "`TaskUpdate`"],
  ["readonly", "`readonly: true`"],
  ["the `Skill` tool", "the `Skill` tool"],
  ["the `Agent` tool", "the `Agent`/`Task` tool"],
  ["`Read`", "`Read`"],
  ["`loop`", "`loop`"],
  ["/loop", "`/loop`"],
  ["plugin-dev", "`plugin-dev:skill-development`"],
  [".claude/projects", "`~/.claude/projects/"],
  [".claude/skills", "`.claude/skills/`"],
  ["~/.claude/orchestrate", "`~/.claude/orchestrate/`"],
  ["CLAUDE.md", "`CLAUDE.md`"],
  ["mcp__", "`mcp__`"],
  ["pstack:poteto-agent", "`pstack:poteto-agent`"],
  ["pstack:comment-sicko", "`pstack:comment-sicko`"],
  ["general-purpose", "`general-purpose`"],
];

const skillText = markdownFiles(skillsDir)
  .filter((f) => !f.endsWith("/codex-tools.md") && !f.endsWith("/copilot-tools.md"))
  .map((f) => [relative(skillsDir, f), readFileSync(f, "utf8")]);

describe("copilot-tools.md coverage", () => {
  for (const [term, row] of TERMS) {
    const users = skillText.filter(([, text]) => text.includes(term)).map(([rel]) => rel);
    test(`${term} (${users.length} files) has a Copilot mapping`, () => {
      if (users.length) expect(mapping).toContain(row);
    });
  }

  test("the mapping ships no model slug", () => {
    for (const slug of [...models.codex.panel, models.codex.default, models.codex.strongest]) expect(mapping).not.toContain(slug);
  });

  test("every skill with a per-skill note exists and every pointed skill has one or needs none", () => {
    const table = mapping.slice(mapping.indexOf("## Per-skill notes"), mapping.indexOf("## Vendored scripts"));
    const noted = [...table.matchAll(/^\| `([a-z0-9-]+)` \|/gm)].map((m) => m[1]);
    const skills = new Set(skillText.filter(([rel]) => rel.endsWith("/SKILL.md")).map(([rel]) => rel.split("/")[0]));
    for (const name of noted) expect(skills.has(name)).toBe(true);
    for (const name of ["interrogate", "setup-pstack", "no-comments", "reflect", "recall", "babysit"]) {
      expect(noted).toContain(name);
    }
  });

  test("names both surfaces and the app-only primitives with CLI fallbacks", () => {
    for (const s of ["create_session", "save_session_automation", "`orchestrate`", "`pr-stack`", "`git worktree add`", "`/fleet`"]) {
      expect(mapping).toContain(s);
    }
  });
});

describe("Copilot preambles", () => {
  const [codex, , copilot] = RUNTIMES;
  const leads = loadLeadLines();

  test("every skill noted for Codex is also noted for Copilot", () => {
    const noted = (runtime) => noteSkills(runtime, readFileSync(join(repoRoot, runtime.tools), "utf8"));
    const copilotNoted = noted(copilot);
    for (const skill of noted(codex)) expect({ skill, noted: copilotNoted.includes(skill) }).toEqual({ skill, noted: true });
  });

  test("the Copilot preamble follows the Codex preamble in each stamped skill", () => {
    const stamped = [...leads].filter(([, lines]) => lines.includes(copilot.preamble));
    expect(stamped.length).toBeGreaterThan(0);
    for (const [file, lines] of stamped) {
      const text = readFileSync(join(repoRoot, file), "utf8");
      expect(text).toContain(copilot.preamble);
      if (lines.includes(codex.preamble)) expect(text).toContain(`${codex.preamble}\n\n${copilot.preamble}\n`);
    }
  });

  test("poteto-mode's Platform Adaptation names the Copilot mapping", () => {
    const text = readFileSync(join(skillsDir, "poteto-mode/SKILL.md"), "utf8");
    expect(text).toContain("On GitHub Copilot, CLI or app, read [`references/copilot-tools.md`](references/copilot-tools.md)");
  });
});

// Copilot's ask_user is single-select with one question per call, and pstack
// ships no Copilot models, so setup asks tier by tier from choice lists.
describe("Copilot setup questions", () => {
  const setupDir = join(skillsDir, "setup-pstack");
  const skill = readFileSync(join(setupDir, "SKILL.md"), "utf8");
  const questions = readFileSync(join(setupDir, "copilot.md"), "utf8");
  const sequence = questions.slice(questions.indexOf("## Question sequence"));
  const roles = models.roles.map((r) => r.role);

  test("step 6's sheet shape has a line for every role in models.json", () => {
    const sheetShape = skill.slice(skill.indexOf("### 6. Write the override sheet"), skill.indexOf("### 7."));
    const shaped = [...sheetShape.matchAll(/^([a-z][a-z ,-]*): /gm)].map((m) => m[1]).filter((r) => r !== "session hook" && r !== "default effort");
    expect(shaped).toEqual(roles);
  });

  test("the roles-by-tier table lists every role once, under its tier", () => {
    const table = questions.slice(questions.indexOf("| Tier | Roles |"), questions.indexOf("## Question sequence"));
    const rows = [...table.matchAll(/^\| (\w+) \| (.+) \|$/gm)].filter((m) => m[1] !== "Tier");
    const listed = rows.flatMap((m) => [...m[2].matchAll(/`([^`]+)`/g)].map((r) => [m[1].toLowerCase(), r[1]]));
    expect(listed.sort()).toEqual(models.roles.map((r) => [r.tier, r.role]).sort());
  });

  test("asks by tier, panel slot, override, and hook, in order", () => {
    const steps = [
      "0. **Session model.**",
      "1. **Default model.**",
      "2. **Strongest model.**",
      "3. **Panel model 1 of 3**",
      "4. **More panel models.**",
      "5. **Vendor check.**",
      "6. **Overrides.**",
      "7. **Session hook.**",
      "8. **Default effort.**",
    ];
    const at = steps.map((step) => sequence.indexOf(step));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  test("setup runs the vendored sheet check after writing", () => {
    const check = "scripts/check-sheet.sh";
    expect(questions).toContain(`sh <this skill's directory>/${check}`);
    expect(existsSync(join(setupDir, check))).toBe(true);
  });
});
