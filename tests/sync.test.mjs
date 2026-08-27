import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySubstitutions, denylistHits, syncComponent } from "../tools/sync.mjs";

const RULES = JSON.parse(readFileSync(join(import.meta.dir, "../tools/substitutions.json"), "utf8"));

function tree(files) {
  const dir = mkdtempSync(join(tmpdir(), "sync-fixture-"));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return dir;
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
});

describe("denylistHits", () => {
  test("flags residual Cursor-isms with file, line, and hint", () => {
    const hits = denylistHits("skills/x/SKILL.md", "line one\nrun control-cli now\n", RULES.denylist);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain("skills/x/SKILL.md:2");
    expect(hits[0]).toContain("control-cli");
  });
});

describe("syncComponent", () => {
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
      // a matches substituted old upstream -> clean update expected
      "skills/a/SKILL.md": "Step 1: AskUserQuestion about scope.\n",
      // b carries a port-specific edit -> manual merge expected
      "skills/b/SKILL.md": "Old b body, plus a Platform note the port added.\n",
    });

    const report = syncComponent({ oldDir: oldUp, newDir: newUp, localDir: local, rules: RULES.substitutions, write: true });

    expect(report.written).toContain("updated: skills/a/SKILL.md");
    expect(report.written).toContain("added: skills/c/SKILL.md");
    expect(report.manual).toEqual(["skills/b/SKILL.md"]);
    expect(readFileSync(join(local, "skills/a/SKILL.md"), "utf8")).toBe(
      "Step 1: AskUserQuestion about scope. Step 2: verify.\n",
    );
    expect(readFileSync(join(local, "skills/c/SKILL.md"), "utf8")).toBe("Brand new skill. AskUserQuestion early.\n");
    expect(readFileSync(join(local, "skills/b/SKILL.md"), "utf8")).toBe(
      "Old b body, plus a Platform note the port added.\n",
    );
  });

  test("write: false reports without touching the tree", () => {
    const oldUp = tree({ "s.md": "one\n" });
    const newUp = tree({ "s.md": "two\n" });
    const local = tree({ "s.md": "one\n" });
    const report = syncComponent({ oldDir: oldUp, newDir: newUp, localDir: local, rules: RULES.substitutions, write: false });
    expect(report.written).toEqual(["updated: s.md"]);
    expect(readFileSync(join(local, "s.md"), "utf8")).toBe("one\n");
  });
});
