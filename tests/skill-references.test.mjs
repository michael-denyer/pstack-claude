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

// Runtime built-ins, the Pi extension's /pstack-agents, and explanatory mentions of Cursor commands.
const BUILT_IN_SLASH = new Set(["pstack-agents", "loop", "run", "verify", "command", "goal", "name", "compact", "clear", "hooks", "fleet", "add-dir", "resume"]);

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

  // An index entry names its leaf as "(**principle-x**)", or the leaf is the
  // entry's title in kebab case, hyphens kept and other punctuation dropped.
  test("poteto-mode's Principles index lists exactly the principle leaves", () => {
    const index = readFileSync(join(skillsDir, "poteto-mode/SKILL.md"), "utf8");
    const start = index.indexOf("\n## Principles\n");
    const section = index.slice(start, index.indexOf("\n## ", start + 1));
    const listed = new Set();
    for (const m of section.matchAll(/^- \*\*(.+?)\.?\*\*(?: \(\*\*(principle-[a-z0-9-]+)\*\*\))?/gm)) {
      const title = m[1].toLowerCase().replace(/[^a-z0-9 -]/g, "").replace(/ +/g, "-");
      listed.add(m[2] ?? `principle-${title}`);
    }
    expect([...listed].sort()).toEqual([...principles].sort());
  });
});
