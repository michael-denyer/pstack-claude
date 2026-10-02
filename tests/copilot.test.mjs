// GitHub Copilot build contracts: the mapping names every Claude-specific term
// the skills use, every skill with a Codex preamble also has the Copilot one,
// and the Copilot model block ships no slugs.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { copilotSessionContext, loadLeadLines, loadModels, noteSkills, parseModels, SAVED_CHOICES_MARKER } from "../tools/generate.mjs";
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

  test("every Claude model tier resolves without shipping a Copilot slug", () => {
    const names = mapping.slice(mapping.indexOf("## Model names"), mapping.indexOf("## Session routing hook"));
    expect(names).toContain("ships no default model IDs");
    expect(names).toContain("`${COPILOT_HOME:-~/.copilot}/pstack-models.md`");
    expect(names).toContain("load `setup-pstack` with the `skill` tool, and finish it first");
    expect(names).toContain("Do not ask again");
    expect(names).toContain("saved pstack model choices");
    expect(names).toContain("do not `view` the sheet");
    expect(names).toContain("use the values it just wrote");
    expect(names).toContain("`model` parameter");
    expect(names).toContain("distinct vendors");
    for (const role of models.roles.filter((r) => r.tier === "strongest")) expect(names).toContain(`\`${role.role}\``);
    for (const skill of new Set(models.roles.map((r) => r.skill))) expect(names).toContain(`\`${skill}\``);
    for (const slug of models.codex.panel) expect(mapping).not.toContain(slug);
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

describe("Copilot model block", () => {
  const raw = JSON.parse(readFileSync(join(repoRoot, "plugins/pstack/models.json"), "utf8"));
  const parse = (copilot) => () => parseModels({ ...structuredClone(raw), copilot }, () => true);

  test("ships no slugs and passes validation", () => {
    expect(raw.copilot).toEqual({ default: null, strongest: null, panel: [] });
    expect(parse(raw.copilot)).not.toThrow();
  });

  test("accepts configured IDs and rejects malformed ones", () => {
    expect(parse({ default: "a", strongest: "b", panel: ["a", "c"] })).not.toThrow();
    expect(parse({ default: null, panel: [] })).toThrow('copilot has no entry for tier "strongest"');
    expect(parse({ default: null, strongest: null, panel: ["a", "a"] })).toThrow("distinct");
    expect(parse({ default: 3, strongest: null, panel: [] })).toThrow("model ID or null");
    expect(parse(undefined)).toThrow('"copilot" must be an object');
  });
});

describe("Copilot session context", () => {
  const mandate = readFileSync(join(repoRoot, "plugins/pstack/hooks/session-start-context.md"), "utf8");
  const addendum = readFileSync(join(repoRoot, "plugins/pstack/hooks/session-start-copilot.md"), "utf8");

  test("the committed JSON is the stamp of the mandate and the addendum", () => {
    const committed = readFileSync(join(repoRoot, "plugins/pstack/hooks/session-start-context.json"), "utf8");
    const sheet = readFileSync(join(repoRoot, "plugins/pstack/hooks/session-start-copilot-sheet.md"), "utf8");
    expect(copilotSessionContext(mandate, `${addendum.trim()}\n\n${sheet}`)).toBe(committed);
    expect(committed.split(SAVED_CHOICES_MARKER)).toHaveLength(2);
    expect(sheet).toContain("saved pstack model choices");
  });

  test("the no-sheet JSON adds only the setup-first paragraph", () => {
    const noSheet = readFileSync(join(repoRoot, "plugins/pstack/hooks/session-start-copilot-nosheet.md"), "utf8");
    const committed = readFileSync(join(repoRoot, "plugins/pstack/hooks/session-start-context-nosheet.json"), "utf8");
    expect(copilotSessionContext(mandate, `${addendum.trim()}\n\n${noSheet}`)).toBe(committed);
    expect(noSheet).toContain("load `setup-pstack` with the `skill` tool");
    expect(committed).not.toContain(SAVED_CHOICES_MARKER);
  });

  test("the addendum lands inside the one closing tag", () => {
    const { additionalContext } = JSON.parse(copilotSessionContext("<T>\nbody\n</EXTREMELY_IMPORTANT>\n", "extra\n"));
    expect(additionalContext).toBe("<T>\nbody\n\nextra\n</EXTREMELY_IMPORTANT>\n");
    expect(() => copilotSessionContext("no tag", "x")).toThrow("exactly one");
    expect(() => copilotSessionContext("</EXTREMELY_IMPORTANT></EXTREMELY_IMPORTANT>", "x")).toThrow("exactly one");
  });

  test("the addendum resolves names through the mapping and the Copilot sheet", () => {
    expect(addendum).toContain("`references/copilot-tools.md`");
    expect(addendum).toContain("`${COPILOT_HOME:-~/.copilot}/pstack-models.md`");
    expect(addendum).toContain("`setup-pstack`");
    expect(addendum).toContain("saved pstack model choices");
    expect(addendum).toContain("Do not `view` the sheet");
    expect(addendum).toContain("use the values it just wrote");
  });
});

// Copilot's ask_user is single-select with one question per call, and pstack
// ships no Copilot models, so setup asks tier by tier from choice lists.
describe("Copilot setup questions", () => {
  const setupDir = join(skillsDir, "setup-pstack");
  const skill = readFileSync(join(setupDir, "SKILL.md"), "utf8");
  const questions = readFileSync(join(setupDir, "copilot.md"), "utf8");
  const sheetShape = skill.slice(skill.indexOf("### 6. Write the override sheet"), skill.indexOf("### 7."));
  const roles = [...sheetShape.matchAll(/^([a-z][a-z ,-]*): /gm)].map((m) => m[1]).filter((r) => r !== "session hook" && r !== "default effort");
  const sequence = questions.slice(questions.indexOf("## Question sequence"));

  const setupRule = skill.split("\n").find((l) => l.startsWith("On GitHub Copilot, detect models"));

  test("the setup pointer sends Copilot to the question file", () => {
    expect(setupRule).toContain("[the Copilot setup questions](copilot.md)");
    expect(setupRule).toContain("`choices` list");
  });

  // A model that skips copilot.md still reads the stamped pointer and the
  // no-sheet context, so the no-guess rule lives in both.
  test("the pointer and the no-sheet context forbid picking models for the user", () => {
    const noSheet = readFileSync(join(repoRoot, "plugins/pstack/hooks/session-start-copilot-nosheet.md"), "utf8");
    expect(setupRule).toContain("never pick a model the user has not chosen");
    expect(setupRule).toContain("When `ask_user` is not available and the request leaves a model question open, write no sheet");
    expect(noSheet).toContain("It never picks a model the user has not chosen, so when `ask_user` is not available it writes no sheet");
  });

  test("every sheet role is written by exactly one tier or panel question", () => {
    const settings = new Set(["panel vendors: any", "session hook", "default effort"]);
    const written = [...sequence.matchAll(/\bwrites ([^.]*)\./g)]
      .flatMap((m) => [...m[1].matchAll(/`([^`]+)`/g)].map((r) => r[1]))
      .filter((r) => !settings.has(r));
    expect(roles.length).toBe(17);
    expect([...written].sort()).toEqual([...roles].sort());
  });

  test("asks by tier, panel slot, override, and hook, in order", () => {
    const steps = [
      "**Default model.**",
      "**Strongest model.**",
      "**Panel model 1 of 3**",
      "**panel model 2 of 3**",
      "**panel model 3 of 3**",
      '"Add a 4th panel model?" with `Done` as the first choice',
      "**Vendor check.**",
      '"Override any individual role?" with `No, write the sheet (Recommended)` first',
      "**Session hook.**",
      "**Default effort.**",
    ];
    const at = steps.map((step) => sequence.indexOf(step));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(sequence).toContain("list the vendors not yet in the panel first");
    expect(sequence).toContain("`Pick the panel again` and `Keep it anyway`");
  });

  // The PreToolUse hook denies a single-vendor panel unless the sheet opts
  // out, so every path that keeps one must write the opt-out line.
  test("keeping a single-vendor panel writes the hook's opt-out line", () => {
    expect(sequence).toContain("`Keep it anyway` writes the line `panel vendors: any` after the `session hook` line.");
    expect(sequence).toContain("When only one vendor is detected, skip this question, write `panel vendors: any`");
    expect(sequence).toContain("not counting `inherit-parent`");
    expect(readFileSync(join(repoRoot, "plugins/pstack/hooks/sheet.awk"), "utf8")).toContain("/^panel vendors:[ \\t]*any[ \\t\\r]*$/");
  });

  test("the Copilot sheet header names no single runtime's hook", () => {
    const header = questions.slice(questions.indexOf("## Sheet header"), questions.indexOf("## Detect models"));
    expect(header).toContain("`session hook: off` stops the SessionStart hook from injecting");
    expect(header).toContain("on GitHub Copilot");
    expect(header).not.toContain("Claude Code or Codex");
    expect(header).toContain("`panel vendors: any`");
    expect(skill).toContain("`session hook: off` stops the Claude Code or Codex SessionStart hook");
  });

  test("the sheet write form is one the hook can check", () => {
    expect(questions).toContain("cat > '/absolute/path/to/pstack-models.md' <<'EOF'");
    expect(questions).toContain("Do not route around it with another command.");
  });

  test("the mapping documents the hook's script approval and its limits", () => {
    expect(mapping).toContain("`bash` that runs a vendored script in exactly this form");
    expect(mapping).toContain("Copilot prompts for a bypass whatever a hook answers");
    expect(mapping).toContain("run `/add-dir <plugin directory>` in the session");
    expect(mapping).toContain("denies a `task` call whose `agent_type` starts with `pstack:`");
  });

  test("setup names its model floor", () => {
    expect(questions).toContain("at least as strong as gpt-5.4-mini or a Sonnet-class Claude model");
    expect(mapping).toContain("at least as strong as gpt-5.4-mini or a Sonnet-class Claude model");
  });

  test("every model question is a short choices list grouped by vendor", () => {
    expect(questions).toContain("Ask every model question through `ask_user` with a `choices` list");
    expect(questions).toContain("Never ask for models as one open question");
    expect(questions).toContain("never bundle two questions into one call");
    expect(questions).toContain("**Vendor.**");
    expect(questions).toContain("so no choices list holds the whole enum");
    expect(questions).toContain("`inherit-parent (run on the session's model)`");
  });

  test("recommends no model and marks saved values as current", () => {
    expect(questions).toContain("Do not propose, pre-select, or label any model `(Recommended)`");
    expect(questions.match(/\(Recommended\)/g)).toHaveLength(2);
    expect(questions).toContain("labeled `(current)`");
    expect(skill).not.toMatch(/propose a primary model|accept as-is or change specific roles.*Copilot/);
  });

  test("writes nothing it could not ask about", () => {
    expect(questions).toContain("do not choose for the user and do not write the sheet");
    expect(questions).toContain("Do not test for the sheet or its directory with `bash`");
    expect(questions).toContain("Write the sheet in one tool call");
  });

  test("the mapping row says ask_user is single-select", () => {
    const row = mapping.split("\n").find((l) => l.includes("(`AskUserQuestion`)"));
    expect(row).toContain("`ask_user` with a `choices` list");
    expect(row).toContain("single-select only");
    expect(row).toContain("Emulate multi-select with sequential questions");
  });
});
