import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveSkill, loadLeadLines, loadModels } from "../tools/generate.mjs";
import {
  applySubstitutions,
  changedLines,
  classify,
  denylistHits,
  mergeFile,
  parseForks,
  parseRule,
  parseSubstitutions,
  syncComponent,
} from "../tools/sync.mjs";

const RULES = parseSubstitutions(JSON.parse(readFileSync(join(import.meta.dir, "../tools/substitutions.json"), "utf8")));

const fixtures = [];
afterEach(() => {
  for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tree(files) {
  const dir = mkdtempSync(join(tmpdir(), "sync-fixture-"));
  fixtures.push(dir);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return dir;
}

function sync(overrides) {
  return syncComponent({ rules: RULES.substitutions, denylist: RULES.denylist, ...overrides });
}

describe("applySubstitutions", () => {
  test("rewrites Cursor primitives and counts per rule", () => {
    const { text, counts } = applySubstitutions(
      "Use the `Task` tool, then AskQuestion. Skills live in .cursor/skills/.",
      RULES.substitutions,
    );
    expect(text).toBe("Use the `Agent` tool, then AskUserQuestion. Skills live in .claude/skills/.");
    expect(counts.get("AskQuestion")).toBe(1);
  });

  test("leaves AskUserQuestion alone", () => {
    const { text } = applySubstitutions("Prefer AskUserQuestion here.", RULES.substitutions);
    expect(text).toBe("Prefer AskUserQuestion here.");
  });

  test("the override sheet path survives the generic .cursor/rules/ rule", () => {
    const { text } = applySubstitutions(
      "Use `arena runners` from `~/.cursor/rules/pstack-models.mdc` when present. Rules in .cursor/rules/ apply.",
      RULES.substitutions,
    );
    expect(text).toBe(
      "Use `arena runners` from `pstack-models.md` when present. Rules in CLAUDE.md imports apply.",
    );
  });

  test("the driver-skill and model-default phrases rewrite as the port writes them", () => {
    const { text } = applySubstitutions(
      [
        "Capture a trace via the matching control skill.",
        "Reproduce via the control skill.",
        "Drive via the relevant control skill and through its control skill.",
        "<control skill path> and the control skill's commands",
        "Multiple `Task` calls in the Task tool.",
        "on \"restart Cursor\"",
      ].join("\n"),
      RULES.substitutions,
    );
    expect(text).toBe(
      [
        "Capture a trace via the matching driver skill.",
        "Reproduce via the driver skill.",
        "Drive via the relevant driver skill and through its driver skill.",
        "<driver skill path> and the driver skill's commands",
        "Multiple `Agent` calls in the `Agent` tool.",
        "on \"restart Claude Code\"",
      ].join("\n"),
    );
  });

  test("a model default points at the Models section that owns the file, whatever the slug", () => {
    const line = (slug) => `your configured hillclimb model (default \`${slug}\`)`;
    for (const slug of ["grok-4.7-xhigh-fast", "claude-fable-5-1-thinking-max", "gpt-6-sol-max"]) {
      expect(applySubstitutions(line(slug), RULES.substitutions, "skills/poteto-mode/playbooks/hillclimb.md").text).toBe(
        "your configured hillclimb model (default in poteto-mode's Models section)",
      );
      expect(applySubstitutions(line(slug), RULES.substitutions, "skills/reflect/SKILL.md").text).toBe(
        "your configured hillclimb model (default in [Models](#models))",
      );
    }
    expect(applySubstitutions("(default `true`)", RULES.substitutions, "skills/reflect/SKILL.md").text).toBe(
      "(default `true`)",
    );
  });

  test("every rule's replacement is free of the denylist", () => {
    for (const rule of RULES.substitutions) {
      expect(denylistHits("rule", rule.replacement, RULES.denylist)).toEqual([]);
    }
  });

  test("no rule rewrites another rule's output", () => {
    for (const rel of ["skills/x/SKILL.md", "skills/poteto-mode/playbooks/x.md"]) {
      for (const rule of RULES.substitutions) {
        expect(applySubstitutions(rule.replacement, RULES.substitutions, rel).text).toBe(rule.replacement);
      }
    }
  });

  // One upstream sentence per rule that reaches more than one upstream file,
  // and the one form the port writes for it.
  test.each([
    [
      "skills/how/SKILL.md",
      "Each spawn below names a role line in the `pstack-models.mdc` rule and a default. Set `model` to that line's value, or to the default if the rule or the line is missing.",
      "Each spawn below names a role line in `pstack-models.md` and a default in [Models](#models). Set `model` to that line's value, or to the default if the sheet or the line is missing.",
    ],
    [
      "skills/how/SKILL.md",
      "If the Task tool rejects a slug, use the default and say so.",
      "If the `Agent` tool rejects a slug, use the default and say so.",
    ],
    [
      "skills/how/SKILL.md",
      "- `model`: the `how explorer` line, default `grok-4.7-xhigh-fast`",
      "- `model`: the `how explorer` line, default in [Models](#models)",
    ],
    [
      "skills/architect/SKILL.md",
      "Take the runners from the `architect runners` line in the `pstack-models.mdc` rule, in place of the `arena runners` line. If the rule or that line is missing, use",
      "Take the runners from the `architect runners` line in `pstack-models.md`, in place of the `arena runners` line. If the sheet or that line is missing, use",
    ],
    [
      "skills/arena/SKILL.md",
      "Families go by prefix: `claude-*`, `gpt-*`, and `grok-*`.",
      "Families go by model name, such as Opus, Fable, or Sonnet.",
    ],
    [
      "skills/reflect/SKILL.md",
      "One message, three `Task` calls, `subagent_type: generalPurpose`, with `model` set as below.",
      'One message, three `Agent` calls, `subagent_type: "general-purpose"`, with `model` set as below.',
    ],
    [
      "skills/reflect/references/judgment-reviewer.md",
      "plugin-installed paths under `~/.cursor/plugins/`)\n- `Task` prompts that name a skill path",
      "plugin-installed paths under `~/.claude/plugins/`)\n- `Agent` prompts that name a skill path",
    ],
    [
      "skills/show-me-your-work/SKILL.md",
      "Read this run's transcript under the active workspace's `agent-transcripts/` directory (the system prompt names the path). Don't glob across `~/.cursor/projects/*/`.",
      "Read this run's transcript under Claude Code's per-project transcripts directory at `~/.claude/projects/<encoded-cwd>/`. Don't glob across `~/.claude/projects/`.",
    ],
    [
      "skills/poteto-mode/playbooks/eval.md",
      "Read each candidate's local transcript under the active workspace's `agent-transcripts/` directory (the system prompt names this path).",
      "Read each candidate's local transcript under Claude Code's per-project transcripts directory at `~/.claude/projects/<encoded-cwd>/`.",
    ],
    [
      "skills/poteto-mode/playbooks/multi-phase-plan.md",
      'Explore in subagents with `subagent_type: "poteto-agent"` and an explicit model.',
      'Explore in subagents with `subagent_type: "pstack:poteto-agent"` and an explicit model.',
    ],
    [
      "skills/automate-me/SKILL.md",
      "an inline mining pass, Cursor's built-in `create-skill` (authoring), and the **unslop** skill. Use Cursor's built-in `create-skill` skill to author the skill. Follow `create-skill`'s YAML rules.",
      "an inline mining pass, the **plugin-dev:skill-development** skill (authoring), and the **unslop** skill. Use the **plugin-dev:skill-development** skill to author the skill. Follow `plugin-dev:skill-development`'s YAML rules.",
    ],
    [
      "skills/poteto-mode/playbooks/authoring-a-skill.md",
      "1. Use the **create-skill** skill (Cursor's built-in for authoring SKILL.md files).",
      "1. Use the **plugin-dev:skill-development** skill (Claude Code's authoring guidance for SKILL.md files).",
    ],
    [
      "skills/poteto-mode/playbooks/autonomous-run.md",
      "Pick the wake mechanism using Cursor's `/loop` command (a built-in, not a pstack skill).",
      "Pick the wake mechanism using Claude Code's `loop` skill (a built-in, not a pstack skill).",
    ],
    [
      "skills/poteto-mode/SKILL.md",
      "on an explicit pause, going offline, a Cursor restart, or imminent context compaction.",
      "on an explicit pause, going offline, a session restart, or imminent context compaction.",
    ],
    [
      "skills/poteto-mode/playbooks/babysit.md",
      'This playbook replaces Cursor\'s built-in babysit skill for these requests, for "address the bugbot comments".',
      'This playbook replaces the bundled **babysit** skill for these requests, for "address the review-bot comments".',
    ],
    [
      "skills/poteto-mode/playbooks/autopilot-full.md",
      "One Cursor cloud agent per PR owns build, skeptical Bugbot triage, and the fixes.",
      "One background subagent per PR, in its own worktree, owns build, skeptical review-bot triage, and the fixes.",
    ],
    [
      "skills/poteto-mode/playbooks/autopilot-stack.md",
      "On the operator's explicit go, arm a `/goal` with the full program objective. The goal continues across turns until the chain is done.",
      "On the operator's explicit go, write the full program objective into the standing orders and restate it in your todolist. That objective stands across turns until the chain is done.",
    ],
  ])("%s: an upstream sentence takes the port's one form", (rel, upstream, port) => {
    const { text } = applySubstitutions(upstream, RULES.substitutions, rel);
    expect(text).toBe(port);
    expect(denylistHits(rel, text, RULES.denylist)).toEqual([]);
  });
});

describe("parseSubstitutions", () => {
  const rule = (fields) => ({ replacement: "X", rationale: "fixture", ...fields });

  test("a misspelled field fails naming the rule instead of matching everywhere", () => {
    expect(() => parseRule(rule({ patern: "a" }), 3)).toThrow('substitutions[3]: unknown field "patern"');
    expect(() => parseRule(rule({ pattern: "a", file: "^skills/" }), 0)).toThrow('unknown field "file"');
  });

  test("a rule needs exactly one matcher, a replacement, and a rationale", () => {
    expect(() => parseRule(rule({}), 0)).toThrow("exactly one of a non-empty pattern or regex");
    expect(() => parseRule(rule({ pattern: "a", regex: "a" }), 0)).toThrow("exactly one");
    expect(() => parseRule(rule({ pattern: "" }), 0)).toThrow("exactly one");
    expect(() => parseRule({ pattern: "a", rationale: "fixture" }, 0)).toThrow("needs a replacement string");
    expect(() => parseRule({ pattern: "a", replacement: "X" }, 0)).toThrow("needs a rationale");
  });

  test("a pattern that contains an earlier rule's pattern fails, since it could never match", () => {
    const generic = rule({ pattern: "`Task`", replacement: "`Agent`" });
    const specific = rule({ pattern: "Spawn `Task` with", replacement: "Spawn an `Agent` with" });
    expect(() => parseSubstitutions({ substitutions: [generic, specific], denylist: [] })).toThrow(
      'substitutions[1] "Spawn `Task` with" contains substitutions[0] "`Task`"',
    );
    const { substitutions } = parseSubstitutions({ substitutions: [specific, generic], denylist: [] });
    expect(applySubstitutions("Spawn `Task` with it. One `Task` call.", substitutions).text).toBe(
      "Spawn an `Agent` with it. One `Agent` call.",
    );
  });

  test("one regex scoped to two path sets counts under two keys", () => {
    const { substitutions } = parseSubstitutions({
      substitutions: [
        rule({ regex: "a+", files: "^one/" }),
        rule({ regex: "a+", files: "^two/" }),
      ],
      denylist: [],
    });
    expect([...applySubstitutions("aa", substitutions, "one/x.md").counts.keys()]).toEqual(["a+ in ^one/"]);
    expect([...applySubstitutions("aa", substitutions, "two/x.md").counts.keys()]).toEqual(["a+ in ^two/"]);
  });
});

describe("parseForks", () => {
  const components = { kit: { localPath: "plugins/pstack/skills" } };
  const path = "plugins/pstack/skills/s.md";
  const entry = { kind: "policy", why: "Fixture fork.", since: "0.9.48", upstream: "not-proposed" };
  const parse = (fields) => parseForks({ kit: { [path]: { ...entry, ...fields } } }, components);

  test("keys each entry by its path under the component", () => {
    expect(parse({}).kit).toEqual(new Map([["s.md", entry]]));
  });

  test("a malformed entry fails naming the component and path", () => {
    expect(() => parse({ reason: "x" })).toThrow(`forks.json kit "${path}": unknown field "reason"`);
    expect(() => parse({ why: undefined })).toThrow(`forks.json kit "${path}": missing field "why"`);
    expect(() => parse({ kind: "translation" })).toThrow(`forks.json kit "${path}": unknown kind "translation"`);
    expect(() => parse({ since: "latest" })).toThrow(`forks.json kit "${path}": since "latest" is not a version`);
    expect(() => parse({ upstream: "maybe" })).toThrow(`forks.json kit "${path}": upstream "maybe"`);
  });

  test("an unknown component or a path outside the component fails", () => {
    expect(() => parseForks({ other: {} }, components)).toThrow('forks.json: unknown component "other"');
    expect(() => parseForks({ kit: { "tools/s.md": entry } }, components)).toThrow("not under plugins/pstack/skills");
  });
});

describe("denylistHits", () => {
  test("a Cursor model slug fails the scan", () => {
    expect(denylistHits("playbook.md", "default `grok-4.8-fast`", RULES.denylist)).toHaveLength(1);
    expect(denylistHits("playbook.md", "default `gpt-5.6-sol-max`", RULES.denylist)).toHaveLength(1);
    expect(denylistHits("playbook.md", "default `gpt-6-sol-max`", RULES.denylist)).toHaveLength(1);
    expect(denylistHits("arena.md", "one each on `claude-opus-5-5-max`", RULES.denylist)).toHaveLength(1);
    expect(denylistHits("how.md", "the role line in the `pstack-models.mdc` rule", RULES.denylist)).toHaveLength(1);
  });

  test("a model name in an example is not a Cursor slug", () => {
    expect(denylistHits("synthesizer.md", "we renamed `gpt-4` to `gpt-4o` in `encodingForModel`", RULES.denylist)).toEqual([]);
  });

  test("UI repair advice points to the canonical driver policy", () => {
    const hits = denylistHits("playbook.md", "Drive with control-ui.", RULES.denylist);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain("poteto-mode/SKILL.md");
    expect(hits[0]).not.toContain("`verify` built-in");
  });

  test("rejects the old UI instruction but permits project and legacy skill references", () => {
    expect(denylistHits("playbook.md", "Use the `verify` skill (UIs).", RULES.denylist)).toHaveLength(1);
    const supported = "The bundled `/verify` is user-invocable only. " +
      "Use the project `verify` skill or maintain `.claude/skills/verify-*/`.";
    expect(denylistHits("policy.md", supported, RULES.denylist)).toEqual([]);
  });

  test("flags residual Cursor-isms with file, line, and hint", () => {
    const hits = denylistHits("skills/x/SKILL.md", "line one\nrun control-cli now\n", RULES.denylist);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain("skills/x/SKILL.md:2");
    expect(hits[0]).toContain("control-cli");
  });

  test.each([
    ["create-skill", "hand to Cursor's built-in `create-skill` skill"],
    ["generalPurpose", "three `Task` calls, `subagent_type: generalPurpose`, with `model` set"],
    ["agent-transcripts", "The system prompt names the active workspace's `agent-transcripts/` directory."],
    ['environment: "cloud"', 'Always `environment: "cloud"` unless the task needs this machine'],
    ["is_background", "is_background: true"],
  ])("an upstream sentence carrying %s fails the scan", (token, sentence) => {
    const hits = denylistHits("skills/x/SKILL.md", sentence, RULES.denylist);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain(`"${token}"`);
  });
});

describe("mergeFile", () => {
  const base = ["l1", "l2", "l3", "l4", "l5"].join("\n") + "\n";

  test("returns the merged bytes when the two sides do not overlap", () => {
    const merged = mergeFile(
      Buffer.from(base.replace("l1", "ours")),
      Buffer.from(base),
      Buffer.from(base.replace("l5", "theirs")),
    );
    expect(merged.clean).toBe(true);
    expect(merged.buffer.toString("utf8")).toBe(base.replace("l1", "ours").replace("l5", "theirs"));
  });

  test("returns the hunk count and git's labelled markers when the sides overlap", () => {
    const merged = mergeFile(
      Buffer.from(base.replace("l3", "ours")),
      Buffer.from(base),
      Buffer.from(base.replace("l3", "theirs")),
    );
    expect(merged.clean).toBe(false);
    expect(merged.hunks).toBe(1);
    expect(merged.buffer.toString("utf8")).toBe(
      "l1\nl2\n<<<<<<< local\nours\n=======\ntheirs\n>>>>>>> upstream\nl4\nl5\n",
    );
  });

  test("throws when git fails instead of reporting its exit status as a hunk count", () => {
    const nul = (s) => Buffer.from(`${s}\0\n`);
    expect(() => mergeFile(nul("ours"), nul("base"), nul("theirs"))).toThrow("Command failed");
  });
});

describe("changedLines", () => {
  test("throws git's error instead of counting zero when git cannot read the local file", () => {
    expect(() => changedLines(Buffer.from("one\n"), join(tree({}), "missing.md"))).toThrow("Could not access");
  });
});

describe("classify", () => {
  const COUNTS = new Map([["AskQuestion", 1]]);
  const bytes = (text) => Buffer.from(text);
  const port = (text, mode = 0o644) => ({ bytes: bytes(text), mode });
  const upstream = (text, mode = 0o644) => ({ ...port(text, mode), binary: false, counts: COUNTS });
  const older = (text, mode = 0o644) => ({ ...upstream(text, mode), counts: new Map([["Task", 1]]) });
  const written = (kind, text, mode = 0o644) => ({ kind, write: { bytes: bytes(text), mode }, counts: COUNTS });
  const base = ["l1", "l2", "l3", "l4", "l5"].join("\n") + "\n";

  test.each([
    ["an upstream symlink", { old: older("a\n"), new: { symlink: true }, local: port("a\n") }, { kind: "symlink" }],
    ["a new upstream file", { new: upstream("a\n") }, written("added", "a\n")],
    ["a local copy equal to new", { old: older("a\n"), new: upstream("b\n"), local: port("b\n") }, { kind: "unchanged", kept: bytes("b\n") }],
    ["a local copy equal to old", { old: older("a\n"), new: upstream("b\n"), local: port("a\n") }, written("updated", "b\n")],
    ["an upstream mode change", { old: older("a\n"), new: upstream("a\n", 0o755), local: port("a\n") }, written("updated", "a\n", 0o755)],
    [
      "a port edit upstream left alone",
      { old: older("a\n"), new: upstream("a\n"), local: port("a\nport\n") },
      { kind: "forked", kept: bytes("a\nport\n"), base: bytes("a\n") },
    ],
    ["a port mode change upstream left alone", { old: older("a\n"), new: upstream("a\n"), local: port("a\n", 0o755) }, { kind: "mode-only", kept: bytes("a\n") }],
    [
      "a binary changed on both sides",
      { old: older("\0old"), new: { ...upstream("\0new"), binary: true }, local: port("\0port") },
      { kind: "binary-conflict" },
    ],
    [
      "edits on both sides that do not overlap",
      { old: older(base), new: upstream(base.replace("l5", "l5 upstream")), local: port(base.replace("l1", "l1 port")) },
      written("merged", base.replace("l1", "l1 port").replace("l5", "l5 upstream")),
    ],
    ["a port mode change under an upstream edit", { old: older("a\n"), new: upstream("b\n"), local: port("a\n", 0o755) }, written("merged", "b\n", 0o755)],
    [
      "a port edit and mode change under an upstream edit",
      { old: older(base), new: upstream(base.replace("l5", "l5 upstream")), local: port(base.replace("l1", "l1 port"), 0o755) },
      written("merged", base.replace("l1", "l1 port").replace("l5", "l5 upstream"), 0o755),
    ],
    [
      "edits on both sides that overlap",
      { old: older(base), new: upstream(base.replace("l3", "l3 upstream")), local: port(base.replace("l3", "l3 port")) },
      { ...written("conflicted", "l1\nl2\n<<<<<<< local\nl3 port\n=======\nl3 upstream\n>>>>>>> upstream\nl4\nl5\n"), hunks: 1 },
    ],
    [
      "a port mode change under an overlapping upstream edit",
      { old: older(base), new: upstream(base.replace("l3", "l3 upstream")), local: port(base.replace("l3", "l3 port"), 0o755) },
      { ...written("conflicted", "l1\nl2\n<<<<<<< local\nl3 port\n=======\nl3 upstream\n>>>>>>> upstream\nl4\nl5\n", 0o755), hunks: 1 },
    ],
    [
      "an upstream mode change under a port edit",
      { old: older(base), new: upstream(base, 0o755), local: port(base.replace("l1", "l1 port")) },
      written("merged", base.replace("l1", "l1 port"), 0o755),
    ],
    [
      "mode changes on both sides under an overlapping edit",
      { old: older(base), new: upstream(base.replace("l3", "l3 upstream"), 0o755), local: port(base.replace("l3", "l3 port"), 0o600) },
      { ...written("conflicted", "l1\nl2\n<<<<<<< local\nl3 port\n=======\nl3 upstream\n>>>>>>> upstream\nl4\nl5\n", 0o755), hunks: 1 },
    ],
    [
      "a file new on both sides, which has no common mode and takes upstream's",
      { new: upstream("upstream\n"), local: port("port\n", 0o755) },
      { ...written("conflicted", "<<<<<<< local\nport\n=======\nupstream\n>>>>>>> upstream\n"), hunks: 1 },
    ],
    [
      "a file that replaced an upstream symlink, which has no common mode and takes upstream's",
      { old: { symlink: true }, new: upstream("upstream\n"), local: port("port\n", 0o755) },
      { ...written("conflicted", "<<<<<<< local\nport\n=======\nupstream\n>>>>>>> upstream\n"), hunks: 1 },
    ],
    ["an upstream deletion the port never edited", { old: older("a\n"), local: port("a\n") }, { kind: "deleted" }],
    ["an upstream deletion of a port edit", { old: older("a\n"), local: port("port\n") }, { kind: "removed-upstream", kept: bytes("port\n") }],
    ["an upstream deletion the port already made", { old: older("a\n") }, null],
  ])("%s", (_, input, outcome) => {
    expect(classify(input)).toEqual(outcome);
  });
});

describe("syncComponent", () => {
  test("installed plugin text passes sync validation without changes", () => {
    const plugin = join(import.meta.dir, "../plugins/pstack");
    const report = sync({ oldDir: plugin, newDir: plugin, localDir: plugin, dryRun: true });
    expect(report.written).toEqual([]);
    expect(report.hits).toEqual([]);
  });

  test("clean update, new file, and port-edited file each route correctly", () => {
    const oldUp = tree({
      "skills/a/SKILL.md": "Step 1: AskQuestion about scope.\n",
      "skills/b/SKILL.md": "Old b body.\n",
    });
    const newUp = tree({
      "skills/a/SKILL.md": "Step 1: AskQuestion about scope. Step 2: verify.\n",
      "skills/b/SKILL.md": "New b body.\n",
      "skills/c/SKILL.md": "Brand new skill. AskQuestion early.\n",
    });
    const local = tree({
      "skills/a/SKILL.md": "Step 1: AskUserQuestion about scope.\n",
      "skills/b/SKILL.md": "Old b body, plus a Platform note the port added.\n",
    });

    const report = sync({ oldDir: oldUp, newDir: newUp, localDir: local });

    expect(report.written).toEqual([
      { kind: "updated", rel: "skills/a/SKILL.md" },
      { kind: "conflicted", rel: "skills/b/SKILL.md" },
      { kind: "added", rel: "skills/c/SKILL.md" },
    ]);
    expect(report.conflicts).toEqual([{ rel: "skills/b/SKILL.md", reason: "conflict", hunks: 1 }]);
    expect(report.counts.get("AskQuestion")).toBe(2);
    expect(report.hits).toEqual([]);
    expect(readFileSync(join(local, "skills/a/SKILL.md"), "utf8")).toBe(
      "Step 1: AskUserQuestion about scope. Step 2: verify.\n",
    );
    expect(readFileSync(join(local, "skills/c/SKILL.md"), "utf8")).toBe("Brand new skill. AskUserQuestion early.\n");
    expect(readFileSync(join(local, "skills/b/SKILL.md"), "utf8")).toBe(
      "<<<<<<< local\nOld b body, plus a Platform note the port added.\n=======\nNew b body.\n>>>>>>> upstream\n",
    );
  });

  test("excluded upstream paths are neither added, updated, deleted, nor scanned", () => {
    const oldUp = tree({
      "skills/a/SKILL.md": "keep\n",
      "docs/guide/01.md": "old guide\n",
      "README.md": "old readme\n",
    });
    const newUp = tree({
      "skills/a/SKILL.md": "keep\n",
      "docs/guide/01.md": "run control-cli\n",
      "README.md": "run control-ui\n",
      "automations/benny/README.md": "lives in .cursor/\n",
    });
    const local = tree({ "skills/a/SKILL.md": "keep\n", "README.md": "the port's own readme\n" });

    const report = sync({ oldDir: oldUp, newDir: newUp, localDir: local, exclude: ["docs/", "automations", "README.md"] });

    expect(report.written).toEqual([]);
    expect(report.deleted).toEqual([]);
    expect(report.conflicts).toEqual([]);
    expect(report.forked).toEqual([]);
    expect(report.hits).toEqual([]);
    expect(report.excluded).toBe(3);
    expect(report.unchanged).toBe(1);
    expect(existsSync(join(local, "docs/guide/01.md"))).toBe(false);
    expect(readFileSync(join(local, "README.md"), "utf8")).toBe("the port's own readme\n");
  });

  test("an upstream deletion removes the local copy when the port never edited it", () => {
    const oldUp = tree({ "a.md": "keep\n", "gone.md": "AskQuestion here\n", "forked.md": "old\n" });
    const newUp = tree({ "a.md": "keep\n" });
    const local = tree({ "a.md": "keep\n", "gone.md": "AskUserQuestion here\n", "forked.md": "old, port edit\n" });

    const report = sync({ oldDir: oldUp, newDir: newUp, localDir: local });

    expect(report.deleted).toEqual(["gone.md"]);
    expect(report.conflicts).toEqual([{ rel: "forked.md", reason: "removed-upstream" }]);
    expect(existsSync(join(local, "gone.md"))).toBe(false);
    expect(existsSync(join(local, "forked.md"))).toBe(true);
  });

  test("a denylist hit leaves an update unapplied on every identical retry", () => {
    const oldUp = tree({ "s.md": "old\n" });
    const newUp = tree({ "s.md": "run control-cli\n" });
    const local = tree({ "s.md": "old\n" });

    const first = sync({ oldDir: oldUp, newDir: newUp, localDir: local });
    const second = sync({ oldDir: oldUp, newDir: newUp, localDir: local });

    expect(first.written).toEqual([{ kind: "updated", rel: "s.md" }]);
    expect(second.written).toEqual([{ kind: "updated", rel: "s.md" }]);
    expect(first.hits).toHaveLength(1);
    expect(second.hits).toHaveLength(1);
    expect(readFileSync(join(local, "s.md"), "utf8")).toBe("old\n");
  });

  test("an unchanged forbidden file is scanned in actual and dry-run modes", () => {
    for (const dryRun of [false, true]) {
      const oldUp = tree({ "s.md": "run control-cli\n" });
      const newUp = tree({ "s.md": "run control-cli\n" });
      const local = tree({ "s.md": "run control-cli\n" });

      const report = sync({ oldDir: oldUp, newDir: newUp, localDir: local, dryRun });

      expect(report.unchanged).toBe(1);
      expect(report.hits).toHaveLength(1);
      expect(readFileSync(join(local, "s.md"), "utf8")).toBe("run control-cli\n");
    }
  });

  test("an undeclared fork blocks every write, and a declared one does not", () => {
    const oldUp = tree({ "forked.md": "a\n", "updated.md": "old\n" });
    const newUp = tree({ "forked.md": "a\n", "updated.md": "new\n" });
    const local = tree({ "forked.md": "a\nport\n", "updated.md": "old\n" });
    const declared = new Map([["forked.md", { kind: "policy" }]]);

    const blocked = sync({ oldDir: oldUp, newDir: newUp, localDir: local, forks: new Map() });

    expect(blocked.undeclared).toEqual(["forked.md"]);
    expect(readFileSync(join(local, "updated.md"), "utf8")).toBe("old\n");

    const report = sync({ oldDir: oldUp, newDir: newUp, localDir: local, forks: declared });

    expect(report.undeclared).toEqual([]);
    expect(report.stale).toEqual([]);
    expect(readFileSync(join(local, "updated.md"), "utf8")).toBe("new\n");
  });

  test("a declared path that is merged or conflicted still counts as forked", () => {
    const oldUp = tree({ "merged.md": "a\nb\nc\nd\ne\n", "conflicted.md": "one\n" });
    const newUp = tree({ "merged.md": "a\nb\nc\nd\nE\n", "conflicted.md": "two\n" });
    const local = tree({ "merged.md": "A\nb\nc\nd\ne\n", "conflicted.md": "port\n" });
    const forks = new Map([["merged.md", {}], ["conflicted.md", {}]]);

    const report = sync({ oldDir: oldUp, newDir: newUp, localDir: local, forks, dryRun: true });

    expect(report.written.map(({ kind, rel }) => `${kind} ${rel}`).sort()).toEqual(["conflicted conflicted.md", "merged merged.md"]);
    expect(report.undeclared).toEqual([]);
    expect(report.stale).toEqual([]);
  });

  test("a declaration whose path is no longer forked or no longer exists is stale", () => {
    const up = tree({ "clean.md": "same\n" });
    const local = tree({ "clean.md": "same\n" });
    const forks = new Map([["clean.md", {}], ["gone.md", {}]]);

    const report = sync({ oldDir: up, newDir: up, localDir: local, forks, dryRun: true });

    expect(report.stale).toEqual([
      { rel: "clean.md", reason: "is no longer forked (unchanged)" },
      { rel: "gone.md", reason: "no longer exists" },
    ]);
  });

  test("a hit prevents valid sibling additions, updates, and deletions", () => {
    const oldUp = tree({
      "bad.md": "old bad\n",
      "gone.md": "old gone\n",
      "updated.md": "old update\n",
    });
    const newUp = tree({
      "bad.md": "run control-cli\n",
      "new.md": "new sibling\n",
      "updated.md": "new update\n",
    });
    const local = tree({
      "bad.md": "old bad\n",
      "gone.md": "old gone\n",
      "updated.md": "old update\n",
    });

    const report = sync({ oldDir: oldUp, newDir: newUp, localDir: local });

    expect(report.written).toEqual([
      { kind: "updated", rel: "bad.md" },
      { kind: "added", rel: "new.md" },
      { kind: "updated", rel: "updated.md" },
    ]);
    expect(report.deleted).toEqual(["gone.md"]);
    expect(report.hits).toHaveLength(1);
    expect(readFileSync(join(local, "bad.md"), "utf8")).toBe("old bad\n");
    expect(readFileSync(join(local, "updated.md"), "utf8")).toBe("old update\n");
    expect(readFileSync(join(local, "gone.md"), "utf8")).toBe("old gone\n");
    expect(existsSync(join(local, "new.md"))).toBe(false);
  });

  test("a conflict's marked bytes are scanned, so a Cursor-ism on upstream's side fails the run", () => {
    const oldUp = tree({ "s.md": "old\n" });
    const newUp = tree({ "s.md": "run control-cli\n" });
    const local = tree({ "s.md": "manual correction\n" });

    const report = sync({ oldDir: oldUp, newDir: newUp, localDir: local });

    expect(report.conflicts).toEqual([{ rel: "s.md", reason: "conflict", hunks: 1 }]);
    expect(report.hits).toHaveLength(1);
    expect(report.hits[0]).toStartWith("s.md:4:");
    expect(readFileSync(join(local, "s.md"), "utf8")).toBe("manual correction\n");
  });

  test("a retained forked file removed upstream blocks sibling writes on every retry", () => {
    const oldDir = tree({ "gone.md": "old\n", "sibling.md": "old\n" });
    const newDir = tree({ "sibling.md": "new\n" });
    const localDir = tree({ "gone.md": "run control-cli\n", "sibling.md": "old\n" });
    for (const dryRun of [true, false, false]) {
      const report = sync({ oldDir, newDir, localDir, dryRun });
      expect(report.conflicts).toEqual([{ rel: "gone.md", reason: "removed-upstream" }]);
      expect(report.hits).toHaveLength(1);
      expect(readFileSync(join(localDir, "sibling.md"), "utf8")).toBe("old\n");
    }
  });

  test("a substitution added after a failed attempt allows a valid retry", () => {
    const oldUp = tree({ "s.md": "old\n" });
    const newUp = tree({ "s.md": "run control-cli\n" });
    const local = tree({ "s.md": "old\n" });

    const failed = sync({ oldDir: oldUp, newDir: newUp, localDir: local });
    const rules = [parseRule({ pattern: "run control-cli", replacement: "run cli", rationale: "fixture" }, 0)];
    const recovered = sync({
      oldDir: oldUp,
      newDir: newUp,
      localDir: local,
      rules,
    });
    const unchanged = sync({
      oldDir: oldUp,
      newDir: newUp,
      localDir: local,
      rules,
    });

    expect(failed.hits).toHaveLength(1);
    expect(readFileSync(join(local, "s.md"), "utf8")).toBe("run cli\n");
    expect(recovered.written).toEqual([{ kind: "updated", rel: "s.md" }]);
    expect(recovered.hits).toEqual([]);
    expect(unchanged.written).toEqual([]);
    expect(unchanged.unchanged).toBe(1);
    expect(unchanged.hits).toEqual([]);
  });

  test("dry-run and actual mode report the same plan and dry-run preserves bytes", () => {
    const base = ["l1", "l2", "l3", "l4", "l5", "l6", "l7", "l8", "l9"].join("\n") + "\n";
    const makeFixture = () => {
      const oldDir = tree({
        "bad.md": "old\n",
        "gone.md": "gone\n",
        "updated.md": "old update\n",
        "merged.md": base,
        "clash.md": base,
        "untouched.md": base,
      });
      const newDir = tree({
        "bad.md": "run control-cli\n",
        "new.md": "new\n",
        "updated.md": "new update\n",
        "merged.md": base.replace("l9", "l9 upstream"),
        "clash.md": base.replace("l5", "l5 upstream"),
        "untouched.md": base,
      });
      const localDir = tree({
        "bad.md": "old\n",
        "gone.md": "gone\n",
        "updated.md": "old update\n",
        "merged.md": base.replace("l1", "l1 port"),
        "clash.md": base.replace("l5", "l5 port"),
        "untouched.md": base.replace("l1", "l1 port"),
      });
      return { oldDir, newDir, localDir };
    };
    const actualFixture = makeFixture();
    const dryRunFixture = makeFixture();
    const beforeDryRun = readFileSync(join(dryRunFixture.localDir, "updated.md"));
    const beforeMerged = readFileSync(join(dryRunFixture.localDir, "merged.md"));

    const actual = sync({ ...actualFixture });
    const dryRun = sync({ ...dryRunFixture, dryRun: true });

    expect(dryRun.written).toEqual(actual.written);
    expect(dryRun.deleted).toEqual(actual.deleted);
    expect(dryRun.conflicts).toEqual(actual.conflicts);
    expect(dryRun.forked).toEqual(actual.forked);
    expect(dryRun.hits).toEqual(actual.hits);
    expect(actual.written).toContainEqual({ kind: "merged", rel: "merged.md" });
    expect(actual.conflicts).toContainEqual({ rel: "clash.md", reason: "conflict", hunks: 1 });
    expect(actual.forked).toEqual([{ rel: "untouched.md", changed: 2 }]);
    expect(readFileSync(join(dryRunFixture.localDir, "updated.md")).equals(beforeDryRun)).toBe(true);
    expect(readFileSync(join(dryRunFixture.localDir, "merged.md")).equals(beforeMerged)).toBe(true);
    expect(existsSync(join(dryRunFixture.localDir, "new.md"))).toBe(false);
    expect(existsSync(join(dryRunFixture.localDir, "gone.md"))).toBe(true);
  });

  test("derive turns substituted upstream text into the port's form before comparing", () => {
    const oldUp = tree({ "s.md": "flag: on\nbody\n" });
    const newUp = tree({ "s.md": "flag: on\nbody two\n" });
    const local = tree({ "s.md": "flag: off\nbody\n" });
    const derive = (rel, text) => text.replace("flag: on", "flag: off");
    const report = sync({ oldDir: oldUp, newDir: newUp, localDir: local, derive });
    expect(report.written).toEqual([{ kind: "updated", rel: "s.md" }]);
    expect(readFileSync(join(local, "s.md"), "utf8")).toBe("flag: off\nbody two\n");
  });

  test("dryRun reports without touching the tree", () => {
    const oldUp = tree({ "s.md": "one\n", "gone.md": "x\n" });
    const newUp = tree({ "s.md": "two\n", "new.md": "y\n" });
    const local = tree({ "s.md": "one\n", "gone.md": "x\n" });
    const report = sync({ oldDir: oldUp, newDir: newUp, localDir: local, dryRun: true });
    expect(report.written).toEqual([
      { kind: "added", rel: "new.md" },
      { kind: "updated", rel: "s.md" },
    ]);
    expect(report.deleted).toEqual(["gone.md"]);
    expect(readFileSync(join(local, "s.md"), "utf8")).toBe("one\n");
    expect(existsSync(join(local, "gone.md"))).toBe(true);
    expect(existsSync(join(local, "new.md"))).toBe(false);
  });

  test("a binary file of any extension is copied byte for byte and never substituted", () => {
    const invalidUtf8 = Buffer.concat([Buffer.from("AskQuestion "), Buffer.from([0xff, 0xfe, 0x80])]);
    const withNul = Buffer.from("AskQuestion\0");
    const oldUp = tree({});
    const newUp = tree({});
    writeFileSync(join(newUp, "doc.pdf"), invalidUtf8);
    writeFileSync(join(newUp, "blob.bin"), withNul);
    writeFileSync(join(newUp, "bun.lock"), "AskQuestion\n");
    const local = tree({});

    const report = sync({ oldDir: oldUp, newDir: newUp, localDir: local });

    expect(report.counts).toEqual(new Map());
    expect(readFileSync(join(local, "doc.pdf")).equals(invalidUtf8)).toBe(true);
    expect(readFileSync(join(local, "blob.bin")).equals(withNul)).toBe(true);
    expect(readFileSync(join(local, "bun.lock"), "utf8")).toBe("AskQuestion\n");
  });

  test("a binary file of any extension differing three ways blocks every write", () => {
    const oldUp = tree({ "sibling.md": "old\n" });
    const newUp = tree({ "sibling.md": "new\n" });
    const local = tree({ "sibling.md": "old\n" });
    writeFileSync(join(oldUp, "font.ttf"), Buffer.from([0x00, 0xff, 0x01]));
    writeFileSync(join(newUp, "font.ttf"), Buffer.from([0x00, 0xff, 0x02]));
    writeFileSync(join(local, "font.ttf"), Buffer.from([0x00, 0xff, 0x03]));

    const report = sync({ oldDir: oldUp, newDir: newUp, localDir: local });

    expect(report.binaryConflicts).toEqual(["font.ttf"]);
    expect(report.conflicts).toEqual([]);
    expect(readFileSync(join(local, "font.ttf")).equals(Buffer.from([0x00, 0xff, 0x03]))).toBe(true);
    expect(readFileSync(join(local, "sibling.md"), "utf8")).toBe("old\n");
  });

  test("an upstream symlink is reported, never followed", () => {
    const outside = tree({ "secret.txt": "local secret\n", "dir/inner.md": "inner\n" });
    const oldUp = tree({ "was-file.md": "body\n" });
    const newUp = tree({});
    symlinkSync(join(outside, "secret.txt"), join(newUp, "file-link.md"));
    symlinkSync(join(outside, "dir"), join(newUp, "dir-link"));
    symlinkSync(join(outside, "missing.md"), join(newUp, "was-file.md"));
    symlinkSync(join(outside, "secret.txt"), join(oldUp, "old-link.md"));
    const local = tree({ "was-file.md": "body\n", "old-link.md": "local secret\n" });

    const report = sync({ oldDir: oldUp, newDir: newUp, localDir: local });

    expect(report.conflicts).toEqual([
      { rel: "dir-link", reason: "symlink" },
      { rel: "file-link.md", reason: "symlink" },
      { rel: "was-file.md", reason: "symlink" },
      { rel: "old-link.md", reason: "removed-upstream" },
    ]);
    expect(report.written).toEqual([]);
    expect(report.deleted).toEqual([]);
    expect(existsSync(join(local, "file-link.md"))).toBe(false);
    expect(readFileSync(join(local, "was-file.md"), "utf8")).toBe("body\n");
    expect(readFileSync(join(local, "old-link.md"), "utf8")).toBe("local secret\n");
  });

  test("a written file takes upstream's mode, and a mode-only upstream change is written", () => {
    const oldUp = tree({ "same.sh": "echo\n", "forked.sh": "echo\n" });
    const newUp = tree({ "same.sh": "echo\n", "forked.sh": "echo\n", "added.sh": "echo\n" });
    const local = tree({ "same.sh": "echo\n", "forked.sh": "echo port\n" });
    const scripts = ["same.sh", "forked.sh", "added.sh"];
    for (const rel of scripts) chmodSync(join(newUp, rel), 0o755);

    const report = sync({ oldDir: oldUp, newDir: newUp, localDir: local });

    expect(report.written).toEqual([
      { kind: "added", rel: "added.sh" },
      { kind: "merged", rel: "forked.sh" },
      { kind: "updated", rel: "same.sh" },
    ]);
    for (const rel of scripts) expect(statSync(join(local, rel)).mode & 0o777).toBe(0o755);
    expect(readFileSync(join(local, "forked.sh"), "utf8")).toBe("echo port\n");
  });

  test("a file upstream never touched is forked, not conflicted", () => {
    const body = "shared line\n";
    const oldUp = tree({ "s.md": body });
    const newUp = tree({ "s.md": body });
    const local = tree({ "s.md": "shared line, plus the port's own paragraph\n" });

    const report = sync({ oldDir: oldUp, newDir: newUp, localDir: local });

    expect(report.forked).toEqual([{ rel: "s.md", changed: 2 }]);
    expect(report.conflicts).toEqual([]);
    expect(report.written).toEqual([]);
    expect(readFileSync(join(local, "s.md"), "utf8")).toBe("shared line, plus the port's own paragraph\n");
  });

  test("a forked file is denylist-scanned on its local bytes", () => {
    const body = "one\n";
    const oldUp = tree({ "s.md": body });
    const newUp = tree({ "s.md": body });
    const local = tree({ "s.md": "one\nrun control-cli\n" });

    const report = sync({ oldDir: oldUp, newDir: newUp, localDir: local });

    expect(report.forked).toEqual([{ rel: "s.md", changed: 1 }]);
    expect(report.hits).toHaveLength(1);
    expect(report.hits[0]).toStartWith("s.md:2:");
  });

  test("non-overlapping port and upstream edits merge into one written file", () => {
    const base = ["l1", "l2", "l3", "l4", "l5", "l6", "l7", "l8", "l9"].join("\n") + "\n";
    const oldUp = tree({ "s.md": base });
    const newUp = tree({ "s.md": base.replace("l9", "l9 upstream rewrote the tail") });
    const local = tree({ "s.md": base.replace("l1", "l1 the port rewrote the head") });

    const report = sync({ oldDir: oldUp, newDir: newUp, localDir: local });

    expect(report.written).toEqual([{ kind: "merged", rel: "s.md" }]);
    expect(report.conflicts).toEqual([]);
    expect(report.forked).toEqual([]);
    expect(readFileSync(join(local, "s.md"), "utf8")).toBe(
      base.replace("l1", "l1 the port rewrote the head").replace("l9", "l9 upstream rewrote the tail"),
    );
  });

  test("overlapping edits are written with conflict markers and reported with a hunk count", () => {
    const base = ["l1", "l2", "l3", "l4", "l5"].join("\n") + "\n";
    const oldUp = tree({ "s.md": base });
    const newUp = tree({ "s.md": base.replace("l3", "l3 upstream") });
    const local = tree({ "s.md": base.replace("l3", "l3 the port") });
    const marked = "l1\nl2\n<<<<<<< local\nl3 the port\n=======\nl3 upstream\n>>>>>>> upstream\nl4\nl5\n";

    const report = sync({ oldDir: oldUp, newDir: newUp, localDir: local });

    expect(report.conflicts).toEqual([{ rel: "s.md", reason: "conflict", hunks: 1 }]);
    expect(report.written).toEqual([{ kind: "conflicted", rel: "s.md" }]);
    expect(readFileSync(join(local, "s.md"), "utf8")).toBe(marked);

    // Once the pin advances, old and new are both the conflicting upstream, so
    // the marked file reads as a fork. The generator's marker check, not the
    // sync, is what keeps it out of a release.
    const rerun = sync({ oldDir: newUp, newDir: newUp, localDir: local });

    expect(rerun.forked).toEqual([{ rel: "s.md", changed: 4 }]);
    expect(rerun.conflicts).toEqual([]);
    expect(readFileSync(join(local, "s.md"), "utf8")).toBe(marked);
  });

  test("a file new upstream that already exists locally conflicts against an empty base", () => {
    const oldUp = tree({});
    const newUp = tree({ "s.md": "upstream's brand new body\n" });
    const local = tree({ "s.md": "the port wrote this file first\n" });

    const report = sync({ oldDir: oldUp, newDir: newUp, localDir: local });

    expect(report.conflicts).toEqual([{ rel: "s.md", reason: "conflict", hunks: 1 }]);
    expect(report.written).toEqual([{ kind: "conflicted", rel: "s.md" }]);
    expect(readFileSync(join(local, "s.md"), "utf8")).toBe(
      "<<<<<<< local\nthe port wrote this file first\n=======\nupstream's brand new body\n>>>>>>> upstream\n",
    );
  });

  test("a mode-only port change upstream left alone is forked and keeps its mode", () => {
    const oldUp = tree({ "run.sh": "echo\n" });
    const newUp = tree({ "run.sh": "echo\n" });
    const local = tree({ "run.sh": "echo\n" });
    chmodSync(join(oldUp, "run.sh"), 0o644);
    chmodSync(join(newUp, "run.sh"), 0o644);
    chmodSync(join(local, "run.sh"), 0o755);

    const report = sync({ oldDir: oldUp, newDir: newUp, localDir: local });

    expect(report.forked).toEqual([{ rel: "run.sh", changed: 0, modeOnly: true }]);
    expect(report.written).toEqual([]);
    expect(statSync(join(local, "run.sh")).mode & 0o777).toBe(0o755);
  });

  test("a merge keeps a mode the port changed when upstream left the mode alone", () => {
    const oldUp = tree({ "run.sh": "echo\n" });
    const newUp = tree({ "run.sh": "echo upstream\n" });
    const local = tree({ "run.sh": "echo\n" });
    chmodSync(join(oldUp, "run.sh"), 0o644);
    chmodSync(join(newUp, "run.sh"), 0o644);
    chmodSync(join(local, "run.sh"), 0o755);

    const report = sync({ oldDir: oldUp, newDir: newUp, localDir: local });

    expect(report.written).toEqual([{ kind: "merged", rel: "run.sh" }]);
    expect(readFileSync(join(local, "run.sh"), "utf8")).toBe("echo upstream\n");
    expect(statSync(join(local, "run.sh")).mode & 0o777).toBe(0o755);
  });

  test("forks are reported largest first by changed lines, and a mode-only fork is marked", () => {
    const body = { "a.md": "one\n", "b.md": "one\ntwo\nthree\n", "run.sh": "echo\n" };
    const oldUp = tree(body);
    const newUp = tree(body);
    const local = tree({ "a.md": "one\nport\n", "b.md": "ONE\nTWO\nthree\n", "run.sh": "echo\n" });
    for (const dir of [oldUp, newUp]) chmodSync(join(dir, "run.sh"), 0o755);
    chmodSync(join(local, "run.sh"), 0o644);

    const report = sync({ oldDir: oldUp, newDir: newUp, localDir: local });

    expect(report.forked).toEqual([
      { rel: "b.md", changed: 4 },
      { rel: "a.md", changed: 1 },
      { rel: "run.sh", changed: 0, modeOnly: true },
    ]);
  });

  test("a local file no component carries is port-only; excluded, removed-upstream, and other components' files are not", () => {
    const oldUp = tree({ "a.md": "x\n", "gone.md": "y\n", "docs/guide.md": "z\n" });
    const newUp = tree({ "a.md": "x\n", "docs/guide.md": "z\n" });
    const local = tree({
      "a.md": "x\n",
      "gone.md": "the port edited this\n",
      "docs/port.md": "the port's own docs\n",
      "kit/k.md": "carried by another component\n",
      "tools/extra.ts": "the port wrote this\n",
    });

    const report = sync({ oldDir: oldUp, newDir: newUp, localDir: local, exclude: ["docs/"], carriedElsewhere: ["kit/k.md"] });

    expect(report.portOnly).toEqual(["tools/extra.ts"]);
  });

  test("excluded paths and port-only files are never read", () => {
    const oldDir = tree({ "docs/a.md": "old\n", "s.md": "s\n" });
    const newDir = tree({ "docs/a.md": "new\n", "s.md": "s\n" });
    const localDir = tree({ "docs/a.md": "port\n", "s.md": "s\n" });
    symlinkSync(tree({ "inner.md": "inner\n" }), join(localDir, "linked-dir"));
    symlinkSync(join(localDir, "missing.md"), join(localDir, "dangling.md"));
    const derive = (rel, text) => {
      if (rel.startsWith("docs/")) throw new Error(`derived excluded ${rel}`);
      return text;
    };

    const report = sync({ oldDir, newDir, localDir, exclude: ["docs/"], derive });

    expect(report.excluded).toBe(1);
    expect(report.unchanged).toBe(1);
    expect(report.portOnly).toEqual(["dangling.md", "linked-dir"]);
  });

  test("an upstream symlink over a local directory is reported, and the files upstream deleted under it go", () => {
    for (const dryRun of [true, false]) {
      const oldDir = tree({ "foo/x.md": "x\n", "keep.md": "k\n" });
      const newDir = tree({ "keep.md": "k\n" });
      symlinkSync(tree({ "t.md": "target\n" }), join(newDir, "foo"));
      const localDir = tree({ "foo/x.md": "x\n", "keep.md": "k\n" });

      const report = sync({ oldDir, newDir, localDir, dryRun });

      expect(report.conflicts).toEqual([{ rel: "foo", reason: "symlink" }]);
      expect(report.deleted).toEqual(["foo/x.md"]);
      expect(report.unchanged).toBe(1);
      expect(existsSync(join(localDir, "foo/x.md"))).toBe(dryRun);
    }
  });

  test("an old revision's malformed frontmatter is never derived when the port copy does not need it", () => {
    const good = "---\nname: a\ndescription: fine\n---\nbody\n";
    const bad = "---\nname: a\ndescription: [unclosed\n---\nbody\n";
    const [models, leads] = [loadModels(), loadLeadLines()];
    const derive = (rel, text) => deriveSkill(join("plugins/pstack/skills", rel), text, models, leads);
    const upstreamDeletedIt = { old: { "a/SKILL.md": good, "b/SKILL.md": bad }, new: { "a/SKILL.md": good } };
    const upstreamFixedIt = { old: { "a/SKILL.md": bad }, new: { "a/SKILL.md": good } };
    for (const { old, new: next } of [upstreamDeletedIt, upstreamFixedIt]) {
      const report = sync({ oldDir: tree(old), newDir: tree(next), localDir: tree({ "a/SKILL.md": good }), derive, dryRun: true });

      expect(report.unchanged).toBe(1);
      expect(report.written).toEqual([]);
      expect(report.deleted).toEqual([]);
    }
  });

  test("a merge git reports as conflicted without printing markers fails the run naming the file", () => {
    const bin = tree({ git: "#!/bin/sh\nexit 1\n" });
    chmodSync(join(bin, "git"), 0o755);
    const [oldDir, newDir, localDir] = [tree({ "s.md": "old\n" }), tree({ "s.md": "new\n" }), tree({ "s.md": "port\n" })];
    const script = [
      `import { syncComponent } from ${JSON.stringify(join(import.meta.dir, "../tools/sync.mjs"))};`,
      `syncComponent(${JSON.stringify({ oldDir, newDir, localDir, rules: [] })});`,
    ].join("\n");

    const result = spawnSync(process.execPath, ["-e", script], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("s.md: git merge-file reported conflicts (exit 1) but printed no markers");
    expect(readFileSync(join(localDir, "s.md"), "utf8")).toBe("port\n");
  });
});

describe("sync CLI", () => {
  const declareS = (kind) => ({
    "plugins/pstack/skills/s.md": { kind, why: "Fixture fork.", since: "0.9.48", upstream: "not-proposed" },
  });

  function cli({ oldText, newText, localText, forks = {} }) {
    const root = tree({});
    const upstream = join(root, "upstream");
    mkdirSync(join(upstream, "skills"), { recursive: true });
    const git = (...args) => execFileSync("git", ["-C", upstream, ...args], { encoding: "utf8" }).trim();
    git("init", "-b", "main");
    const commit = (text) => {
      writeFileSync(join(upstream, "skills/s.md"), text);
      git("add", ".");
      git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "update");
      return git("rev-parse", "HEAD");
    };
    const oldSha = commit(oldText);
    const newSha = commit(newText);

    const port = join(root, "port");
    for (const file of ["sync.mjs", "generate.mjs", "validate-skills.mjs", "substitutions.json"]) {
      cpSync(join(import.meta.dir, "../tools", file), join(port, "tools", file));
    }
    cpSync(join(import.meta.dir, "../plugins/pstack/models.json"), join(port, "plugins/pstack/models.json"));
    mkdirSync(join(port, "plugins/pstack/skills"));
    writeFileSync(join(port, "plugins/pstack/skills/s.md"), localText);
    const codexTools = join(port, "plugins/pstack/skills/poteto-mode/references/codex-tools.md");
    mkdirSync(join(codexTools, ".."), { recursive: true });
    writeFileSync(codexTools, "| Skill | On Codex |\n|-------|----------|\n");
    for (const { skill } of JSON.parse(readFileSync(join(port, "plugins/pstack/models.json"), "utf8")).roles) {
      mkdirSync(join(port, "plugins/pstack/skills", skill), { recursive: true });
      writeFileSync(join(port, "plugins/pstack/skills", skill, "SKILL.md"), "");
    }
    writeFileSync(
      join(port, "tools/upstream.json"),
      JSON.stringify({
        remote: upstream,
        components: { kit: { upstreamPath: "skills", localPath: "plugins/pstack/skills", sha: oldSha } },
      }),
    );
    writeFileSync(join(port, "tools/forks.json"), JSON.stringify({ kit: forks }));
    const scratch = join(root, "tmp");
    mkdirSync(scratch);
    const run = (...flags) =>
      spawnSync(process.execPath, [join(port, "tools/sync.mjs"), "kit", newSha, ...flags], {
        encoding: "utf8",
        env: { ...process.env, TMPDIR: scratch },
      });
    const pin = () => JSON.parse(readFileSync(join(port, "tools/upstream.json"), "utf8")).components.kit.sha;
    const local = () => readFileSync(join(port, "plugins/pstack/skills/s.md"), "utf8");
    return { oldSha, newSha, scratch, run, pin, local, port };
  }

  test("a denylist failure exits 1 and removes its scratch clone", () => {
    const { run, scratch } = cli({ oldText: "one\n", newText: "run control-cli\n", localText: "one\n" });

    const result = run("--dry-run");

    expect(result.stderr).toContain("FAIL: Cursor-isms");
    expect(result.status).toBe(1);
    expect(readdirSync(scratch).filter((name) => name.startsWith("pstack-"))).toEqual([]);
  });

  test("a run with a text conflict writes the markers and advances the pin", () => {
    const { run, pin, local, newSha } = cli({
      oldText: "one\n",
      newText: "two\n",
      localText: "port\n",
      forks: declareS("policy"),
    });

    const result = run();

    expect(result.status).toBe(0);
    expect(pin()).toBe(newSha);
    expect(local()).toBe("<<<<<<< local\nport\n=======\ntwo\n>>>>>>> upstream\n");
  });

  test("a denylist hit leaves the pin and the tree alone", () => {
    const { run, pin, local, oldSha } = cli({ oldText: "one\n", newText: "run control-cli\n", localText: "one\n" });

    const result = run();

    expect(result.status).toBe(1);
    expect(pin()).toBe(oldSha);
    expect(local()).toBe("one\n");
  });

  test("a dry run prints each fork's changed lines with a total, then the port-only files", () => {
    const { run } = cli({ oldText: "one\n", newText: "one\n", localText: "one\nport\n", forks: declareS("policy") });
    const models = JSON.parse(readFileSync(join(import.meta.dir, "../plugins/pstack/models.json"), "utf8"));
    const roleSkills = [...new Set(models.roles.map((r) => r.skill))];

    const result = run("--dry-run");

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "\nforked (upstream untouched): 1\n     1 policy plugins/pstack/skills/s.md\n     1 total changed lines\n",
    );
    expect(result.stderr).not.toContain("tools/forks.json");
    const portOnly = [...roleSkills.map((skill) => `${skill}/SKILL.md`), "poteto-mode/references/codex-tools.md"];
    expect(result.stdout).toContain(`\nport-only: ${portOnly.length} files\n`);
    for (const rel of portOnly) expect(result.stdout).toContain(`\n  plugins/pstack/skills/${rel}\n`);
  });

  test("a dry run prints mode in place of a count for a mode-only fork", () => {
    const { run, port } = cli({ oldText: "one\n", newText: "one\n", localText: "one\n", forks: declareS("port-feature") });
    chmodSync(join(port, "plugins/pstack/skills/s.md"), 0o755);

    const result = run("--dry-run");

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("  mode port-feature plugins/pstack/skills/s.md\n     0 total changed lines\n");
  });

  test("an undeclared fork fails the dry run and the real run naming its path, and nothing is written", () => {
    const { run, pin, local, oldSha } = cli({ oldText: "one\n", newText: "two\n", localText: "port\n" });
    const failure = "FAIL: forks with no entry under kit in tools/forks.json";

    const dryRun = run("--dry-run");
    const actual = run();

    for (const result of [dryRun, actual]) {
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`${failure}; declare each or restore upstream's form, then rerun:\n  plugins/pstack/skills/s.md\n`);
    }
    expect(pin()).toBe(oldSha);
    expect(local()).toBe("port\n");
  });

  test("a declaration whose path is no longer forked warns and passes", () => {
    const { run } = cli({ oldText: "one\n", newText: "one\n", localText: "one\n", forks: declareS("policy") });

    const result = run("--dry-run");

    expect(result.status).toBe(0);
    expect(result.stderr).toContain(
      "warning: tools/forks.json declares plugins/pstack/skills/s.md under kit, but it is no longer forked (unchanged); delete the entry\n",
    );
  });
});
