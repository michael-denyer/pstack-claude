// Port-local rules live in files that upstream syncs hand back for manual
// merge (tools/sync.mjs reports them, never rewrites them). A rule dropped in
// that merge reads as a clean sync, so each one is pinned here by the sentence
// that carries it, with the issue or PR that earned it.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const skillsDir = fileURLToPath(new URL("../plugins/pstack/skills", import.meta.url));

const rules = [
  {
    source: "#71 callable driver policy",
    file: "poteto-mode/SKILL.md",
    phrase: "fall back to `run` when the repo has none",
  },
  {
    source: "#71 generated skill name",
    file: "create-verification-skill/SKILL.md",
    phrase: "YAML frontmatter (`name: verify`",
  },
  {
    source: "#71 preserve the original generator trigger",
    file: "create-verification-skill/SKILL.md",
    phrase: "make a control skill for this repo",
  },
  {
    source: "#71 maintain older generated skills",
    file: "maintain-verification-skill/SKILL.md",
    phrase: "or `.claude/skills/verify-*/` from an older generator",
  },
  {
    source: "#72 task fallback keeps skipped steps",
    file: "poteto-mode/SKILL.md",
    phrase: "with the playbook steps verbatim and each `skip: <reason>` line",
  },
  {
    source: "#72 task fallback is a local checklist",
    file: "poteto-mode/SKILL.md",
    phrase: "an uncommitted `todo.md` Markdown checklist",
  },
  {
    source: "#58 stop before you re-delegate",
    file: "poteto-mode/SKILL.md",
    phrase: "Stop the abandoned agent first, and confirm it stopped.",
  },
  {
    source: "#58 delegate isolation",
    file: "poteto-mode/playbooks/feature.md",
    phrase: "Give every file-writing delegate its own worktree",
  },
  {
    source: "#59 item 1 drain the roster",
    file: "poteto-mode/playbooks/opening-a-pr.md",
    phrase: "stop every one that holds it, including grandchildren you never launched",
  },
  {
    source: "#59 item 2 verify the process",
    file: "principle-prove-it-works/SKILL.md",
    phrase: "Verify the process as well as the outcome.",
  },
  {
    source: "#59 item 3 red is a colour",
    file: "principle-prove-it-works/SKILL.md",
    phrase: "Red is a colour, not a measurement.",
  },
  {
    source: "#59 item 3 quote the failure content",
    file: "tdd/SKILL.md",
    phrase: "Quote the failure content",
  },
  {
    source: "#59 item 4 search the places the rules name",
    file: "recall/SKILL.md",
    phrase: "A search that skips a place the project's rules name is not exhausted.",
  },
  {
    source: "#59 item 5 blast-radius before design",
    file: "blast-radius/SKILL.md",
    phrase: "a brief that asserts something about existing code",
  },
  {
    source: "#59 item 6 load the platform skill",
    file: "poteto-mode/SKILL.md",
    phrase: "load that platform's skill",
  },
  {
    source: "#59 item 7 severity picks the artifact",
    file: "poteto-mode/SKILL.md",
    phrase: "severity decides its artifact, not where it turned up",
  },
];

describe("port-local skill rules", () => {
  test("every pinned phrase is distinctive enough to pin a rule", () => {
    const phrases = rules.map((r) => r.phrase);
    expect(new Set(phrases).size).toBe(phrases.length);
    for (const phrase of phrases) expect(phrase.length).toBeGreaterThanOrEqual(20);
  });

  for (const { source, file, phrase } of rules) {
    test(`${file} keeps the rule from ${source}`, () => {
      expect(readFileSync(join(skillsDir, file), "utf8")).toContain(phrase);
    });
  }
});
