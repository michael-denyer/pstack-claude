// Stub renderers are pure functions of a skill's frontmatter, and each harness
// parses its own format. A stub that renders but doesn't parse looks identical
// to a working one until the harness loads it, so the shape gets asserted here.
import { describe, expect, test } from "bun:test";

import { STUB_TARGETS, geminiStub, promptStub } from "../tools/generate.mjs";

const skill = { name: "tdd", menu: 'fix a bug: write the "failing" test first' };

describe("promptStub (Codex)", () => {
  test("names the skill in frontmatter and body", () => {
    const out = promptStub(skill);
    expect(out).toContain("name: tdd");
    expect(out).toContain("disable-model-invocation: true");
    expect(out).toContain("Invoke the `tdd` skill and follow it.");
  });
});

describe("geminiStub", () => {
  test("emits parseable TOML with both required keys", () => {
    const out = geminiStub(skill);
    expect(out).toMatch(/^description = "/m);
    expect(out).toMatch(/^prompt = "/m);
  });

  test("escapes quotes in the menu description", () => {
    const out = geminiStub(skill);
    const line = out.split("\n").find((l) => l.startsWith("description = "));
    expect(JSON.parse(line.slice("description = ".length))).toBe(skill.menu);
  });

  // The prompt body carries literal newlines. Emitting it unescaped yields a
  // TOML string that spans lines and fails to parse, so the whole file must
  // stay exactly two physical lines with a decodable value on each.
  test("escapes the multi-line prompt body", () => {
    const lines = geminiStub(skill).trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    const value = JSON.parse(lines[1].slice("prompt = ".length));
    expect(value).toContain("SKILL.md");
    expect(value).toContain("\n");
  });

  test("points at the skill file, since Gemini CLI has no skills concept", () => {
    const out = geminiStub(skill);
    expect(out).toContain("plugins/pstack/skills/tdd/SKILL.md");
    expect(out).not.toContain("Invoke the `tdd` skill");
  });
});

describe("STUB_TARGETS", () => {
  test("every target renders a distinct extension into a distinct dir", () => {
    const dirs = STUB_TARGETS.map((t) => t.dir);
    const exts = STUB_TARGETS.map((t) => t.ext);
    expect(new Set(dirs).size).toBe(dirs.length);
    expect(new Set(exts).size).toBe(exts.length);
  });

  test("no target writes into the shared skills tree", () => {
    for (const { dir } of STUB_TARGETS) {
      expect(dir.startsWith("plugins/pstack/skills/")).toBe(false);
    }
  });

  test("omits opencode, which reads skills/ natively", () => {
    expect(STUB_TARGETS.some((t) => t.dir.includes("opencode"))).toBe(false);
  });
});
