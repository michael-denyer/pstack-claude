// The note a tool result carries when its file matches a skill's `paths:` globs.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { pluginRoot, useWorld } from "./harness.mjs";

const setup = useWorld();

const result = (toolName, path, extra = {}) => ({
  toolName,
  toolCallId: "t",
  input: { path },
  content: [{ type: "text", text: "file body" }],
  isError: false,
  details: undefined,
  ...extra,
});

describe("paths: auto-load note", () => {
  test("the first matching file gets a one-line note naming the skill, once per session", async () => {
    const { pi, ctx } = setup();
    const [skip] = await pi.emit("tool_result", result("read", "notes.md"), ctx);
    expect(skip).toBeUndefined();
    const [failed] = await pi.emit("tool_result", result("read", "src/a.ts", { isError: true }), ctx);
    expect(failed).toBeUndefined();

    const [first] = await pi.emit("tool_result", result("edit", join(ctx.cwd, "src/deep/b.tsx")), ctx);
    expect(first.content[0]).toEqual({ type: "text", text: "file body" });
    const note = first.content[1].text;
    expect(note).toContain("src/deep/b.tsx");
    expect(note).toContain("typescript-best-practices");
    expect(note).toContain(join(pluginRoot, "skills/typescript-best-practices/SKILL.md"));
    expect(note.split("\n")).toHaveLength(1);

    const [again] = await pi.emit("tool_result", result("write", "src/c.ts"), ctx);
    expect(again).toBeUndefined();
  });

  test("a file at the repository root matches **/*.ts too", async () => {
    const { pi, ctx } = setup();
    const [r] = await pi.emit("tool_result", result("read", "index.ts"), ctx);
    expect(r.content[1].text).toContain("typescript-best-practices");
  });

  test("non-file tools never get the note", async () => {
    const { pi, ctx } = setup();
    const [r] = await pi.emit("tool_result", result("bash", "src/a.ts"), ctx);
    expect(r).toBeUndefined();
  });
});
