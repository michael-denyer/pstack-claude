// README states counts and the upstream pin in prose. Each is derivable from
// the tree, so this pins every occurrence to its source instead of trusting a
// hand edit to keep up.
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { agentSkills, publicSkills } from "../tools/generate.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const readme = readFileSync(join(repoRoot, "README.md"), "utf8");
const skillsDir = join(repoRoot, "plugins/pstack/skills");
const total = agentSkills(skillsDir).length;
const publicCount = publicSkills(skillsDir).length;
const principles = total - publicCount;
const stubs = readdirSync(join(repoRoot, "plugins/pstack/.codex-plugin/prompts")).filter((f) => f.endsWith(".md")).length;
const pins = JSON.parse(readFileSync(join(repoRoot, "tools/upstream.json"), "utf8")).components;

const numbersBefore = (phrase) => [...readme.matchAll(new RegExp(`(\\d+) (?:${phrase})`, "g"))].map((m) => Number(m[1]));

describe("README facts match the tree", () => {
  test("skill directory count", () => {
    const found = numbersBefore("skill directories|Agent Skills");
    expect(found.length).toBeGreaterThan(0);
    for (const n of found) expect(n).toBe(total);
  });

  test("public skill and stub counts", () => {
    const found = [
      ...numbersBefore("are public workflows|public workflows|public skills|slash command stubs"),
      ...[...readme.matchAll(/The (\d+) `\.codex-plugin\/prompts/g)].map((m) => Number(m[1])),
    ];
    expect(found.length).toBeGreaterThan(0);
    for (const n of found) expect(n).toBe(publicCount);
    expect(stubs).toBe(publicCount);
  });

  test("principle leaf count", () => {
    const found = numbersBefore("`principle-\\*`");
    expect(found.length).toBeGreaterThan(0);
    for (const n of found) expect(n).toBe(principles);
  });

  test("the upstream pin named in the opening paragraph is the pinned SHA", () => {
    const named = readme.match(/synced against upstream `([0-9a-f]+)`/)?.[1];
    expect(named).toBeDefined();
    expect(pins.pstack.sha.startsWith(named)).toBe(true);
  });
});
