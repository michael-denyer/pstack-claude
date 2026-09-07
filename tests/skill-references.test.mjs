// Skills name each other in prose, not links: "the **how** skill", "the
// **laziness-protocol** principle skill", "(**principle-x**)" in poteto-mode's
// index, and "`/name`" slash forms. Nothing resolved them until now, so a
// renamed directory left dangling references no tool could see.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { agentSkills } from "../tools/generate.mjs";
import { markdownFiles } from "../tools/validate-skills.mjs";

const skillsDir = fileURLToPath(new URL("../plugins/pstack/skills", import.meta.url));
const names = new Set(agentSkills(skillsDir).map((s) => s.name));
const principles = new Set([...names].filter((n) => n.startsWith("principle-")));

// Claude Code built-ins and explanatory mentions of Cursor commands.
const BUILT_IN_SLASH = new Set(["loop", "run", "verify", "command", "goal", "name", "compact", "clear"]);

function references(text) {
  const found = [];
  for (const m of text.matchAll(/\bthe \*\*([a-z0-9-]+)\*\* skill\b/g)) found.push({ kind: "skill", name: m[1] });
  for (const m of text.matchAll(/\*\*([a-z0-9-]+)\*\* principle skill\b/g)) {
    found.push({ kind: "principle", name: m[1].startsWith("principle-") ? m[1] : `principle-${m[1]}` });
  }
  for (const m of text.matchAll(/\(\*\*(principle-[a-z0-9-]+)\*\*\)/g)) found.push({ kind: "principle", name: m[1] });
  for (const m of text.matchAll(/`\/([a-z][a-z0-9-]*)`/g)) {
    if (!BUILT_IN_SLASH.has(m[1])) found.push({ kind: "slash", name: m[1] });
  }
  return found;
}

describe("prose skill references", () => {
  test("every named skill, principle, and slash command is a skill directory", () => {
    const dangling = [];
    for (const file of markdownFiles(skillsDir)) {
      for (const ref of references(readFileSync(file, "utf8"))) {
        if (!names.has(ref.name)) dangling.push(`${relative(skillsDir, file)}: ${ref.kind} ${ref.name}`);
      }
    }
    expect(dangling).toEqual([]);
  });

  test("poteto-mode's Principles index lists exactly the principle leaves", () => {
    const index = readFileSync(join(skillsDir, "poteto-mode/SKILL.md"), "utf8");
    const listed = new Set([...index.matchAll(/\(\*\*(principle-[a-z0-9-]+)\*\*\)/g)].map((m) => m[1]));
    expect([...listed].sort()).toEqual([...principles].sort());
  });
});
