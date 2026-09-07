#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

// The one directory walker for every tool in tools/. `node_modules` under
// poteto-mode/scripts is gitignored but present on any machine that ran the
// vendored tooling's install, and its READMEs are not ours to validate.
export const SKIPPED_DIRS = new Set([".git", "node_modules"]);

// Sorted, so reports and scans read the same on every filesystem.
export function walk(dir) {
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  return entries.flatMap((entry) => {
    if (SKIPPED_DIRS.has(entry.name)) return [];
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

export function markdownFiles(dir) {
  return walk(dir).filter((path) => path.endsWith(".md"));
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

// A backticked path in prose is not a markdown link, so validateSkillsTree
// never sees it; that is how codex-tools.md came to tell the reader to open
// agents/comment-sicko.md, a file a skills-only install lacks. The defect is
// a filesystem fact: the token names something that exists in the plugin
// (beside the skills tree, or reachable through ../) but not inside the
// tree. Tokens that resolve to nothing are placeholders, slash commands, or
// maintainer notes and are left alone.
function prosePathProblems(text, file, root) {
  const pluginRoot = dirname(root);
  const problems = [];
  for (const match of text.matchAll(/`([^`\n]+)`/g)) {
    const token = match[1];
    if (!token.includes("/") || /\s/.test(token) || isAbsolute(token)) continue;
    const candidates = [resolve(dirname(file), token), resolve(pluginRoot, token)];
    const outside = candidates.find((path) => existsSync(path) && !pathIsInside(root, path));
    if (outside) {
      problems.push(`${relative(root, file)} -> ${token} (${relative(pluginRoot, outside)} is not installed with the skills tree)`);
    }
  }
  return problems;
}

export function validateProsePaths(skillsDir) {
  const root = resolve(skillsDir);
  const problems = [];
  for (const file of markdownFiles(root)) {
    problems.push(...prosePathProblems(readFileSync(file, "utf8"), file, root));
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
