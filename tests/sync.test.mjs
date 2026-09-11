import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySubstitutions, denylistHits, mergeFile, syncComponent } from "../tools/sync.mjs";

const RULES = JSON.parse(readFileSync(join(import.meta.dir, "../tools/substitutions.json"), "utf8"));

function tree(files) {
  const dir = mkdtempSync(join(tmpdir(), "sync-fixture-"));
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
      "Use `arena runners` from `~/.claude/pstack-models.md` when present. Rules in CLAUDE.md imports apply.",
    );
  });

  test("the driver-skill and model-default phrases rewrite as the port writes them", () => {
    const { text } = applySubstitutions(
      [
        "Capture a trace via the matching control skill.",
        "Reproduce via the control skill.",
        "Multiple `Task` calls in the Task tool.",
        "your configured bug-fix model (default `claude-fable-5-1-thinking-max`)",
        "on \"restart Cursor\"",
      ].join("\n"),
      RULES.substitutions,
    );
    expect(text).toBe(
      [
        "Capture a trace via the driver skill (`run`, or the project `verify` skill for UIs).",
        "Reproduce via the driver skill (`run`, or the project `verify` skill for UIs).",
        "Multiple `Agent` calls in the Agent tool.",
        "your configured bug-fix model (default in poteto-mode's Models section)",
        "on \"restart Claude Code\"",
      ].join("\n"),
    );
  });

  test("every rule's replacement is free of the denylist", () => {
    for (const rule of RULES.substitutions) {
      expect(denylistHits("rule", rule.replacement, RULES.denylist)).toEqual([]);
    }
  });
});

describe("denylistHits", () => {
  test("flags residual Cursor-isms with file, line, and hint", () => {
    const hits = denylistHits("skills/x/SKILL.md", "line one\nrun control-cli now\n", RULES.denylist);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain("skills/x/SKILL.md:2");
    expect(hits[0]).toContain("control-cli");
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

  test("reports the hunk count instead of throwing when the sides overlap", () => {
    const merged = mergeFile(
      Buffer.from(base.replace("l3", "ours")),
      Buffer.from(base),
      Buffer.from(base.replace("l3", "theirs")),
    );
    expect(merged).toEqual({ clean: false, hunks: 1 });
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
      "Old b body, plus a Platform note the port added.\n",
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

  test("a written file that still carries a Cursor-ism is reported as a hit", () => {
    const oldUp = tree({ "s.md": "one\n" });
    const newUp = tree({ "s.md": "one\nrun control-cli\n" });
    const local = tree({ "s.md": "one\n" });
    const report = sync({ oldDir: oldUp, newDir: newUp, localDir: local });
    expect(report.hits).toHaveLength(1);
    expect(report.hits[0]).toStartWith("s.md:2:");
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

  test("a conflicted local correction is scanned instead of invalid upstream bytes", () => {
    const oldUp = tree({ "s.md": "old\n" });
    const newUp = tree({ "s.md": "run control-cli\n" });
    const local = tree({ "s.md": "manual correction\n" });

    const report = sync({ oldDir: oldUp, newDir: newUp, localDir: local });

    expect(report.conflicts).toEqual([{ rel: "s.md", reason: "conflict", hunks: 1 }]);
    expect(report.hits).toEqual([]);
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
    const recovered = sync({
      oldDir: oldUp,
      newDir: newUp,
      localDir: local,
      rules: [{ pattern: "run control-cli", replacement: "run cli" }],
    });
    const unchanged = sync({
      oldDir: oldUp,
      newDir: newUp,
      localDir: local,
      rules: [{ pattern: "run control-cli", replacement: "run cli" }],
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
    expect(actual.forked).toEqual(["untouched.md"]);
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

  test("binary files are copied byte for byte", () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
    const oldUp = tree({});
    const newUp = tree({});
    writeFileSync(join(newUp, "logo.png"), bytes);
    const local = tree({});
    sync({ oldDir: oldUp, newDir: newUp, localDir: local });
    expect(readFileSync(join(local, "logo.png")).equals(bytes)).toBe(true);
  });

  test("a file upstream never touched is forked, not conflicted", () => {
    const body = "shared line\n";
    const oldUp = tree({ "s.md": body });
    const newUp = tree({ "s.md": body });
    const local = tree({ "s.md": "shared line, plus the port's own paragraph\n" });

    const report = sync({ oldDir: oldUp, newDir: newUp, localDir: local });

    expect(report.forked).toEqual(["s.md"]);
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

    expect(report.forked).toEqual(["s.md"]);
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

  test("overlapping edits are reported with a hunk count and leave local bytes alone", () => {
    const base = ["l1", "l2", "l3", "l4", "l5"].join("\n") + "\n";
    const oldUp = tree({ "s.md": base });
    const newUp = tree({ "s.md": base.replace("l3", "l3 upstream") });
    const localText = base.replace("l3", "l3 the port");
    const local = tree({ "s.md": localText });

    const report = sync({ oldDir: oldUp, newDir: newUp, localDir: local });

    expect(report.conflicts).toEqual([{ rel: "s.md", reason: "conflict", hunks: 1 }]);
    expect(report.written).toEqual([]);
    expect(readFileSync(join(local, "s.md"), "utf8")).toBe(localText);
  });

  test("a file new upstream that already exists locally conflicts against an empty base", () => {
    const oldUp = tree({});
    const newUp = tree({ "s.md": "upstream's brand new body\n" });
    const local = tree({ "s.md": "the port wrote this file first\n" });

    const report = sync({ oldDir: oldUp, newDir: newUp, localDir: local });

    expect(report.conflicts).toEqual([{ rel: "s.md", reason: "conflict", hunks: 1 }]);
    expect(report.written).toEqual([]);
    expect(readFileSync(join(local, "s.md"), "utf8")).toBe("the port wrote this file first\n");
  });

  test("a binary file differing three ways is reported as unmergeable", () => {
    const oldUp = tree({});
    const newUp = tree({});
    const local = tree({});
    writeFileSync(join(oldUp, "logo.png"), Buffer.from([0x89, 0x50, 0x00, 0x01]));
    writeFileSync(join(newUp, "logo.png"), Buffer.from([0x89, 0x50, 0x00, 0x02]));
    writeFileSync(join(local, "logo.png"), Buffer.from([0x89, 0x50, 0x00, 0x03]));

    const report = sync({ oldDir: oldUp, newDir: newUp, localDir: local });

    expect(report.conflicts).toEqual([{ rel: "logo.png", reason: "binary" }]);
    expect(report.written).toEqual([]);
    expect(readFileSync(join(local, "logo.png")).equals(Buffer.from([0x89, 0x50, 0x00, 0x03]))).toBe(true);
  });
});
