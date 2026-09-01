#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

function markdownFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return markdownFiles(path);
    return entry.name.endsWith(".md") ? [path] : [];
  });
}

function markdownTargets(text) {
  const targets = [];
  for (const [, raw] of text.matchAll(/\]\(([^)\n]*)\)/g)) targets.push(destination(raw));
  for (const [, raw] of text.matchAll(/^\s{0,3}\[(?!\^)[^\]\n]+\]:\s*(.+)$/gm)) {
    targets.push(destination(raw));
  }
  return targets.filter(Boolean);
}

function destination(raw) {
  const value = raw.trim();
  if (value.startsWith("<")) {
    const close = value.indexOf(">");
    return close === -1 ? value : value.slice(1, close);
  }

  let out = "";
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (/\s/.test(char)) break;
    if (char === "\\" && i + 1 < value.length) {
      out += value[i + 1];
      i += 1;
    } else {
      out += char;
    }
  }
  return out;
}

export function pathIsInside(root, path) {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

// Plugin directories that sit beside skills/ and never reach a skills-only
// install. A markdown link to one is caught by validateSkillsTree; a backticked
// path in prose is not, which is how codex-tools.md came to tell the reader to
// open agents/comment-sicko.md.
const UNREACHABLE_PREFIXES = ["agents/", "hooks/", "commands/", ".codex-plugin/", ".claude-plugin/"];

// Only an instruction to open the path is a defect. Skills legitimately mention
// these directories to explain what a runtime ships.
const READ_VERBS = /\b(reads?|opens?|loads?|see|consult|follow|inspect)\b/i;

export function prosePathProblems(file, text, label) {
  const problems = [];
  for (const line of text.split("\n")) {
    for (const [, path] of line.matchAll(/`([^`\n]+)`/g)) {
      const escapes = path.startsWith("../../");
      const unreachable = UNREACHABLE_PREFIXES.some((prefix) => path.startsWith(prefix));
      if (!escapes && !unreachable) continue;
      if (!READ_VERBS.test(line)) continue;
      problems.push(`${label} -> ${path} (not installed with the skills tree)`);
    }
  }
  return problems;
}

export function validateProsePaths(skillsDir) {
  const root = resolve(skillsDir);
  const problems = [];
  for (const file of markdownFiles(root)) {
    problems.push(
      ...prosePathProblems(file, readFileSync(file, "utf8"), relative(root, file)),
    );
  }
  if (problems.length) {
    throw new Error(`prose names paths outside the skills tree:\n${problems.join("\n")}`);
  }
}

export function validateSkillsTree(skillsDir) {
  const root = resolve(skillsDir);
  const realRoot = realpathSync(root);
  const problems = [];
  for (const file of markdownFiles(root)) {
    for (const target of markdownTargets(readFileSync(file, "utf8"))) {
      if (target.startsWith("#") || target.startsWith("//")) continue;
      const scheme = target.match(/^([a-z][a-z0-9+.-]*):/i)?.[1]?.toLowerCase();
      if (scheme && scheme !== "file") continue;

      const encodedPath = target.split(/[?#]/, 1)[0];
      if (!encodedPath) continue;
      let path;
      try {
        path = decodeURIComponent(encodedPath);
      } catch {
        problems.push(`${relative(root, file)} -> ${target} (invalid URI encoding)`);
        continue;
      }

      const resolved = resolve(dirname(file), path);
      if (scheme === "file" || isAbsolute(path) || !pathIsInside(root, resolved)) {
        problems.push(`${relative(root, file)} -> ${target} (escapes skills tree)`);
      } else if (!existsSync(resolved)) {
        problems.push(`${relative(root, file)} -> ${target} (missing)`);
      } else if (!pathIsInside(realRoot, realpathSync(resolved))) {
        problems.push(`${relative(root, file)} -> ${target} (escapes skills tree through symlink)`);
      }
    }
  }
  if (problems.length) throw new Error(`invalid local markdown links:\n${problems.join("\n")}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const skillsDir = process.argv[2];
  if (!skillsDir) {
    console.error("usage: node tools/validate-skills.mjs <skills-directory>");
    process.exit(2);
  }
  try {
    validateSkillsTree(resolve(skillsDir));
    console.log(`ok: local markdown links stay inside ${skillsDir}`);
    validateProsePaths(resolve(skillsDir));
    console.log(`ok: no prose in ${skillsDir} points at a path outside it`);
  } catch (error) {
    console.error(`FAIL: ${error.message}`);
    process.exit(1);
  }
}
