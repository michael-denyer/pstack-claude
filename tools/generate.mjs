#!/usr/bin/env bun
// Stamps facts that live in one source file into every file that carries a
// copy, and validates cross-file contracts. Idempotent; run it after editing
// a source of truth. CI contract: `bun tools/generate.mjs && git diff --exit-code`,
// so a stale committed copy fails the build instead of shipping.
//
// Sources of truth:
//   VERSION  -> the "version" field in the three plugin manifests
//   CHANGES.md must carry a heading for the current VERSION (release completeness)
//   each public skill's frontmatter (name + menu-description)
//     -> its Codex prompt stub in plugins/pstack/.codex-plugin/prompts/
//     -> its row in README.md's "Slash commands" table
//
// Also validated: .agents/plugins/marketplace.json points at a real plugin
// directory whose Codex manifest name matches (it carries no version; Codex
// reads the version from .codex-plugin/plugin.json).

import { existsSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");

const VERSIONED_MANIFESTS = [
  ".claude-plugin/marketplace.json",
  "plugins/pstack/.claude-plugin/plugin.json",
  "plugins/pstack/.codex-plugin/plugin.json",
];

// Replace the manifest's single "version" value, preserving all formatting.
// Exactly one "version" field per manifest is a precondition: a second one
// (say, from a future nested object) would make the blind replace ambiguous,
// so fail loudly and force this function to grow a targeted path instead.
export function stampVersion(text, version, file) {
  const fields = text.match(/"version"\s*:\s*"[^"]*"/g) ?? [];
  if (fields.length !== 1) {
    throw new Error(`${file}: expected exactly 1 "version" field, found ${fields.length}`);
  }
  return text.replace(/("version"\s*:\s*)"[^"]*"/, `$1"${version}"`);
}

export function assertChangesHeading(changes, version) {
  const found = changes
    .split("\n")
    .some((line) => line === `## ${version}` || line.startsWith(`## ${version} `));
  if (!found) {
    throw new Error(
      `CHANGES.md has no "## ${version}" heading. Every version needs a CHANGES entry; ` +
        `a bump without one (or an entry without a bump) ships a release nobody can read about.`,
    );
  }
}

export function validateCodexMarketplace(text, { expectedName, pathExists }) {
  const manifest = JSON.parse(text);
  const plugins = manifest.plugins ?? [];
  if (plugins.length !== 1) {
    throw new Error(`.agents/plugins/marketplace.json: expected 1 plugin entry, found ${plugins.length}`);
  }
  const [plugin] = plugins;
  if (plugin.name !== expectedName) {
    throw new Error(
      `.agents/plugins/marketplace.json: plugin name "${plugin.name}" != Codex manifest name "${expectedName}"`,
    );
  }
  const path = plugin.source?.path;
  if (!path || !pathExists(path)) {
    throw new Error(`.agents/plugins/marketplace.json: source.path "${path}" does not resolve to a directory`);
  }
}

// Single-line frontmatter lookup; returns undefined when the key is absent.
export function frontmatterValue(text, key) {
  const block = text.match(/^---\n([\s\S]*?)\n---/);
  if (!block) return undefined;
  const line = block[1].split("\n").find((l) => l.startsWith(`${key}: `));
  return line?.slice(key.length + 2);
}

// A public skill is any skills/<name>/SKILL.md not marked user-invocable: false
// (the principle-* leaves). Each must carry menu-description, the one-liner the
// Codex slash menu and the README command table both render.
export function publicSkills(skillsDir) {
  const skills = [];
  for (const entry of readdirSync(skillsDir).sort()) {
    const path = join(skillsDir, entry, "SKILL.md");
    if (!statSync(join(skillsDir, entry)).isDirectory() || !existsSync(path)) continue;
    const text = readFileSync(path, "utf8");
    const front = text.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
    if (front.split("\n").includes("user-invocable: false")) continue;
    const name = frontmatterValue(text, "name");
    if (name !== entry) throw new Error(`${path}: frontmatter name "${name}" != directory "${entry}"`);
    const menu = frontmatterValue(text, "menu-description");
    if (!menu) throw new Error(`${path}: public skill has no menu-description frontmatter`);
    skills.push({ name, menu });
  }
  return skills;
}

export function promptStub({ name, menu }) {
  return `---\nname: ${name}\ndescription: ${menu}\ndisable-model-invocation: true\n---\n\nInvoke the \`${name}\` skill and follow it.\n`;
}

// Editorial ordering of the README "Slash commands" table. Set-checked against
// the public skills on every run: adding or retiring a skill without updating
// this list fails here by name.
const README_COMMAND_ORDER = [
  "poteto-mode", "how", "why", "architect", "arena", "interrogate",
  "automate-me", "reflect", "tdd", "typescript-best-practices", "teach",
  "swarm", "technical-writing", "bro", "figure-it-out", "show-me-your-work",
  "blast-radius", "recall", "setup-pstack", "unslop", "no-comments",
  "create-verification-skill", "maintain-verification-skill", "deslop",
  "babysit", "thermo-nuclear-code-quality-review", "make-pr-easy-to-review",
  "fix-ci", "fix-merge-conflicts", "get-pr-comments", "what-did-i-get-done",
];

export function renderReadmeTable(readme, skills) {
  const byName = new Map(skills.map((s) => [s.name, s]));
  const missing = README_COMMAND_ORDER.filter((n) => !byName.has(n));
  const extra = skills.filter((s) => !README_COMMAND_ORDER.includes(s.name)).map((s) => s.name);
  if (missing.length || extra.length) {
    throw new Error(
      `README_COMMAND_ORDER in tools/generate.mjs is out of sync with the public skills` +
        (missing.length ? `; listed but not a skill: ${missing.join(", ")}` : "") +
        (extra.length ? `; skill without a row: ${extra.join(", ")}` : ""),
    );
  }
  const lines = readme.split("\n");
  const header = lines.indexOf("| command | use it when |");
  if (header === -1) throw new Error('README.md: "| command | use it when |" table header not found');
  let end = header + 1;
  while (end < lines.length && lines[end].startsWith("|")) end++;
  const rows = README_COMMAND_ORDER.map((n) => `| \`/${n}\` | ${byName.get(n).menu} |`);
  lines.splice(header, end - header, "| command | use it when |", "| --- | --- |", ...rows);
  return lines.join("\n");
}

function main() {
  const version = readFileSync(join(repo, "VERSION"), "utf8").trim();
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`VERSION must be MAJOR.MINOR.PATCH, got "${version}"`);
  }

  assertChangesHeading(readFileSync(join(repo, "CHANGES.md"), "utf8"), version);
  console.log(`ok: CHANGES.md has a heading for ${version}`);

  for (const file of VERSIONED_MANIFESTS) {
    const path = join(repo, file);
    const text = readFileSync(path, "utf8");
    const stamped = stampVersion(text, version, file);
    if (stamped === text) {
      console.log(`ok: ${file} @ ${version}`);
    } else {
      writeFileSync(path, stamped);
      console.log(`stamped: ${file} -> ${version}`);
    }
  }

  const skills = publicSkills(join(repo, "plugins/pstack/skills"));

  const promptsDir = join(repo, "plugins/pstack/.codex-plugin/prompts");
  let promptsChanged = 0;
  for (const skill of skills) {
    const path = join(promptsDir, `${skill.name}.md`);
    const next = promptStub(skill);
    if (existsSync(path) && readFileSync(path, "utf8") === next) continue;
    writeFileSync(path, next);
    promptsChanged++;
    console.log(`stamped: .codex-plugin/prompts/${skill.name}.md`);
  }
  const expected = new Set(skills.map((s) => `${s.name}.md`));
  for (const file of readdirSync(promptsDir)) {
    if (!file.endsWith(".md") || expected.has(file)) continue;
    unlinkSync(join(promptsDir, file));
    console.log(`removed orphan: .codex-plugin/prompts/${file}`);
  }
  if (promptsChanged === 0) console.log(`ok: ${skills.length} Codex prompts current`);

  const readmePath = join(repo, "README.md");
  const readme = readFileSync(readmePath, "utf8");
  const nextReadme = renderReadmeTable(readme, skills);
  if (nextReadme === readme) {
    console.log("ok: README slash-command table current");
  } else {
    writeFileSync(readmePath, nextReadme);
    console.log("stamped: README.md slash-command table");
  }

  const codexName = JSON.parse(
    readFileSync(join(repo, "plugins/pstack/.codex-plugin/plugin.json"), "utf8"),
  ).name;
  validateCodexMarketplace(readFileSync(join(repo, ".agents/plugins/marketplace.json"), "utf8"), {
    expectedName: codexName,
    pathExists: (p) => existsSync(join(repo, p)),
  });
  console.log("ok: .agents/plugins/marketplace.json names the plugin and points at a real path");
}

try {
  main();
} catch (err) {
  console.error(`FAIL: ${err.message}`);
  process.exit(1);
}
