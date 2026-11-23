#!/usr/bin/env bun
// Validate the agent skill files: the canonical copies live in
// `.agents/skills/<name>/SKILL.md`, and `.claude/skills/<name>` is a relative
// symlink to each of them (C8.2, C8.3).
//
// Fails when:
//   - a SKILL.md has no `name` or `description` frontmatter,
//   - a skill names a `just` recipe that the justfile does not define,
//   - the two skill directories differ,
//   - a `.claude/skills` entry is not a symlink (a Windows clone without
//     `core.symlinks=true` turns links into text files),
//   - a symlink is broken or points somewhere other than the canonical copy.

import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { join, relative } from "node:path";

const root = process.cwd();
const canonicalDir = join(root, ".agents", "skills");
const linkDir = join(root, ".claude", "skills");
const errors: string[] = [];

function entries(path: string): string[] {
  if (!existsSync(path)) return [];
  return readdirSync(path)
    .filter((name) => !name.startsWith("."))
    .sort();
}

function readFrontmatter(file: string): string | undefined {
  const text = readFileSync(file, "utf8");
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  return match?.[1];
}

function field(frontmatter: string, key: string): string | undefined {
  const match = new RegExp(`^${key}:\\s*(.+)$`, "m").exec(frontmatter);
  const value = match?.[1]?.trim();
  if (!value) return undefined;
  return value.replace(/^["']|["']$/g, "");
}

function recipes(): Set<string> {
  const file = join(root, "justfile");
  if (!existsSync(file)) return new Set();
  const names = new Set<string>();
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    if (
      !line ||
      /^\s/.test(line) ||
      line.startsWith("#") ||
      line.startsWith("set ")
    ) {
      continue;
    }
    const match = /^@?([A-Za-z0-9_-]+)(?:\s[^:]*)?:/.exec(line);
    if (match) names.add(match[1]);
  }
  return names;
}

const canonical = entries(canonicalDir);
const linked = entries(linkDir);
const known = recipes();

for (const name of canonical) {
  const skillFile = join(canonicalDir, name, "SKILL.md");
  if (!existsSync(skillFile)) {
    errors.push(`.agents/skills/${name}: missing SKILL.md`);
    continue;
  }
  const frontmatter = readFrontmatter(skillFile);
  if (!frontmatter) {
    errors.push(`.agents/skills/${name}/SKILL.md: missing --- frontmatter`);
    continue;
  }
  if (!field(frontmatter, "name")) {
    errors.push(`.agents/skills/${name}/SKILL.md: frontmatter has no name`);
  }
  if (!field(frontmatter, "description")) {
    errors.push(
      `.agents/skills/${name}/SKILL.md: frontmatter has no description`,
    );
  }
  const body = readFileSync(skillFile, "utf8");
  for (const match of body.matchAll(/`just ([a-z0-9][a-z0-9-]*)`/g)) {
    if (!known.has(match[1])) {
      errors.push(
        `.agents/skills/${name}/SKILL.md: names unknown recipe "just ${match[1]}"`,
      );
    }
  }
}

for (const name of linked) {
  if (!canonical.includes(name)) {
    errors.push(`.claude/skills/${name}: no matching .agents/skills/${name}`);
    continue;
  }
  const link = join(linkDir, name);
  const stat = lstatSync(link);
  if (!stat.isSymbolicLink()) {
    errors.push(
      `.claude/skills/${name}: not a symlink (Windows clone needs core.symlinks=true)`,
    );
    continue;
  }
  if (!existsSync(link)) {
    errors.push(`.claude/skills/${name}: broken symlink`);
    continue;
  }
  const expected = realpathSync(join(canonicalDir, name));
  if (realpathSync(link) !== expected) {
    errors.push(
      `.claude/skills/${name}: points at ${relative(linkDir, realpathSync(link))}`,
    );
  }
}

for (const name of canonical) {
  if (!linked.includes(name)) {
    errors.push(
      `.agents/skills/${name}: missing symlink .claude/skills/${name}`,
    );
  }
}

if (errors.length > 0) {
  for (const error of errors) console.error(error);
  process.exit(1);
}

console.log(
  `agent files OK: ${canonical.length} skill(s)${canonical.length ? ` (${canonical.join(", ")})` : ""}`,
);
