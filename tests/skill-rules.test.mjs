// Port-local rules live in files the port has forked, which tools/sync.mjs
// three-way merges: a clean merge is written, and a conflict is written with
// markers for a human to resolve. A rule dropped in either reads as a clean
// sync, so each one is pinned here by the sentence that carries it, with the
// issue or PR that earned it.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const skillsDir = fileURLToPath(new URL("../plugins/pstack/skills", import.meta.url));

const rules = [
  {
    source: "#331 Codex session effort with an explicit model",
    file: "poteto-mode/references/codex-tools.md",
    phrase: "pass the final level as `reasoning_effort`",
  },
  {
    source: "#331 unknown Codex session effort",
    file: "poteto-mode/references/codex-tools.md",
    phrase: "Do not substitute an omitted `reasoning_effort` for the missing starting level.",
  },
  {
    source: "#331 resolve active Codex effort before dispatch",
    file: "poteto-mode/references/codex-tools.md",
    phrase: "run `node <poteto-mode-dir>/scripts/codex-session-effort.mjs` before dispatching",
  },
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
    source: "#71 formal skill must not take the driver name",
    file: "create-formal-verification-skill/SKILL.md",
    phrase: "never `verify` or a `verify-` prefix, which belong to the driver skill `/create-verification-skill` writes",
  },
  {
    source: "#71 formal maintainer skips the driver skill",
    file: "maintain-formal-verification-skill/SKILL.md",
    phrase: "The project `verify` skill that `/create-verification-skill` writes drives the app and is not one.",
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
    source: "#229 parallel sessions keep separate todolists",
    file: "poteto-mode/SKILL.md",
    phrase: "When several sessions share the checkout, name it `.audit/<task-slug>.todo.md`",
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
    source: "#228 delegate worktree starts from the branch",
    file: "poteto-mode/playbooks/feature.md",
    phrase: "create its worktree with `git worktree add <path> -b <delegate-branch> HEAD`",
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
  {
    source: "#86 confirm the first status read",
    file: "poteto-mode/playbooks/babysit.md",
    phrase: "confirm that the PR or stack it reports matches the request",
  },
  {
    source: "autopilot verify loop: only findings the diff causes go back",
    file: "poteto-mode/playbooks/autopilot-full.md",
    phrase: "A problem the PR's base already has, whether trunk or the PR below it in a stack, doesn't block unless the PR copies it or newly reaches it.",
  },
  {
    source: "autopilot verify loop: bounded rounds",
    file: "poteto-mode/playbooks/autopilot-full.md",
    phrase: "Two fix-forwards per PR is the ceiling.",
  },
  {
    source: "autopilot verify loop: size stated before fan-out",
    file: "poteto-mode/playbooks/autopilot-full.md",
    phrase: "A program of more than three owners waits for the operator's go on that size",
  },
  {
    source: "#188 no self-review in place of an independent one",
    file: "poteto-mode/SKILL.md",
    phrase: "Never count your own review, passing tests, or CI as the independent verdict.",
  },
  {
    source: "#188 a missing reviewer blocks the gate",
    file: "poteto-mode/SKILL.md",
    phrase: "Record `BLOCKED: independent review` in the todolist",
  },
  {
    source: "#231 reflect digest carries no verdict",
    file: "reflect/SKILL.md",
    phrase: "It states no diagnosis, verdict, or cause.",
  },
  {
    source: "#231 reflect adds nothing beside the transcript path",
    file: "reflect/SKILL.md",
    phrase: "Add nothing beside a transcript path",
  },
  {
    source: "backnotprop/pstack#14 an outside rule nobody can check is held, not deleted",
    file: "poteto-mode/references/agents/comment-sicko.md",
    phrase: "the comment stays put as a `HOLD`, the one case where doubt is not meat",
  },
  {
    source: "backnotprop/pstack#14 a kill of an outside rule cites its evidence",
    file: "poteto-mode/references/agents/comment-sicko.md",
    phrase: "dies, and the kill cites the page or file",
  },
  {
    source: "backnotprop/pstack#14 the parent keeps each HOLD",
    file: "no-comments/SKILL.md",
    phrase: "and where to check it is not an ambiguous keep. Leave it in place and report it open.",
  },
  {
    source: "backnotprop/pstack#14 a second rejection keeps the accepted findings",
    file: "no-comments/SKILL.md",
    phrase: "fail `/no-comments` for that report's rejected findings, not for the run.",
  },
  {
    source: "backnotprop/pstack#14 an outside-rule kill needs a refuting citation",
    file: "no-comments/SKILL.md",
    phrase: "unless the report cites a documentation page or source file that refutes the rule",
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
