#!/usr/bin/env bun
// Stamps facts that live in one source file into every file that carries a
// copy, and validates cross-file contracts. Idempotent; run it after editing
// a source of truth. CI contract: `bun tools/generate.mjs && git diff --exit-code`,
// so a stale committed copy fails the build instead of shipping.
//
// Sources of truth:
//   VERSION  -> the "version" field in the three plugin manifests
//   CHANGES.md must carry a heading for the current VERSION (release completeness)
//   each skill's frontmatter (name + description) defines the shared Agent
//   Skills boundary consumed natively by Codex, Prime, opencode, and Gemini CLI
//   each public skill's menu-description
//     -> its Codex prompt stub in plugins/pstack/.codex-plugin/prompts/
//     -> its row in README.md's "Slash commands" table
//   plugins/pstack/models.json (the model policy: role defaults, diverse panel,
//   available slugs, Codex equivalents)
//     -> each model-consuming skill's "## Models" section
//     -> setup-pstack's override-sheet block and interrogate's reviewer table
//     -> the "## Model names" section of poteto-mode/references/codex-tools.md
//   No other claude-* slug may appear in skill prose; the scan below fails on strays.
//
// Also validated: .agents/plugins/marketplace.json points at a real plugin
// directory whose Codex manifest name matches (it carries no version; Codex
// reads the version from .codex-plugin/plugin.json).

import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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

// Validate the shared subset of the Agent Skills contract before deriving any
// runtime-specific views. Runtime-only frontmatter keys may be ignored by other
// consumers, but every skill needs a portable name and description.
export function agentSkills(skillsDir) {
  const skills = [];
  for (const entry of readdirSync(skillsDir).sort()) {
    const path = join(skillsDir, entry, "SKILL.md");
    if (!statSync(join(skillsDir, entry)).isDirectory() || !existsSync(path)) continue;
    const text = readFileSync(path, "utf8");
    const front = text.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
    const name = frontmatterValue(text, "name");
    if (name !== entry) throw new Error(`${path}: frontmatter name "${name}" != directory "${entry}"`);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64) {
      throw new Error(`${path}: frontmatter name "${name}" is not a portable Agent Skills name`);
    }
    const description = frontmatterValue(text, "description");
    if (!description) throw new Error(`${path}: skill has no description frontmatter`);
    if (description.length > 1024) {
      throw new Error(`${path}: description exceeds the portable Agent Skills limit of 1024 characters`);
    }
    skills.push({
      name,
      description,
      menu: frontmatterValue(text, "menu-description"),
      userInvocable: !front.split("\n").includes("user-invocable: false"),
    });
  }
  return skills;
}

// A public skill is any Agent Skill not marked user-invocable: false (the
// principle-* leaves). Each needs the one-liner rendered into the Codex slash
// menu and README command table.
export function publicSkills(skillsDir) {
  return agentSkills(skillsDir)
    .filter((skill) => skill.userInvocable)
    .map(({ name, menu }) => {
      if (!menu) {
        throw new Error(`${join(skillsDir, name, "SKILL.md")}: public skill has no menu-description`);
      }
      return { name, menu };
    });
}

export function promptStub({ name, menu }) {
  return `---\nname: ${name}\ndescription: ${menu}\ndisable-model-invocation: true\n---\n\nInvoke the \`${name}\` skill and follow it.\n`;
}

const code = (s) => `\`${s}\``;
const codeList = (models) => models.map(code).join(", ");

// Replace the body of a "## <title>" section (everything up to the next "## "
// heading or EOF). Throws when the heading is absent — a Models section is a
// structural anchor, not an optional nicety.
export function replaceSection(text, title, body, file) {
  const lines = text.split("\n");
  const start = lines.indexOf(`## ${title}`);
  if (start === -1) throw new Error(`${file}: no "## ${title}" section to stamp`);
  let end = start + 1;
  while (end < lines.length && !lines[end].startsWith("## ")) end++;
  lines.splice(start + 1, end - start - 1, "", ...body.split("\n"), "");
  return lines.join("\n");
}

export function modelsSection(roles) {
  const bullets = roles.map((r) => `- ${r.role}: ${codeList(r.models)}`).join("\n");
  return (
    "Role defaults, stamped from `plugins/pstack/models.json` (edit there, rerun `tools/generate.mjs`). " +
    "A matching role line in `~/.claude/pstack-models.md` overrides each at runtime; see `/setup-pstack`.\n\n" +
    bullets
  );
}

export function setupModelsSection(models) {
  const avail = models.available.map((m) => `${m.label} (${code(m.slug)})`).join(", ");
  return (
    "Stamped from `plugins/pstack/models.json` (edit there, rerun `tools/generate.mjs`).\n\n" +
    `- Available Claude models: ${avail}\n` +
    `- Default panel: ${codeList(models.panel)}\n` +
    `- Single-role default: ${code(models.singleRoleDefault)}`
  );
}

// The override sheet the setup skill writes for users. The preamble is fixed;
// the role rows come from models.json.
export function overrideSheetBlock(models) {
  const rows = models.roles.map((r) => `${r.role}: ${r.models.join(", ")}`).join("\n");
  return (
    "# pstack model configuration\n\n" +
    "Per-role model overrides for pstack skills. Each pstack SKILL.md names its defaults in a Models section; " +
    "the values here override those defaults. Delete a line to fall back to the skill default. " +
    "A value of `inherit-parent` or `auto` runs that role on the parent session's model (the `Agent` call omits `model`); " +
    "an alias entry in a panel list still counts toward that panel's fan-out.\n\n" +
    rows
  );
}

export function stampOverrideSheet(text, models, file) {
  const lines = text.split("\n");
  const step = lines.findIndex((l) => l.startsWith("### 5. Write the override sheet"));
  if (step === -1) throw new Error(`${file}: no "### 5. Write the override sheet" heading`);
  const open = lines.indexOf("```markdown", step);
  if (open === -1) throw new Error(`${file}: no \`\`\`markdown fence under step 5`);
  const close = lines.indexOf("```", open + 1);
  if (close === -1) throw new Error(`${file}: unclosed fence under step 5`);
  lines.splice(open + 1, close - open - 1, overrideSheetBlock(models));
  return lines.join("\n");
}

export function stampReviewerTable(text, models, file) {
  const lines = text.split("\n");
  const header = lines.indexOf("| Subagent | Default model |");
  if (header === -1) throw new Error(`${file}: no reviewer table header`);
  let end = header + 2;
  while (end < lines.length && lines[end].startsWith("| Reviewer ")) end++;
  const reviewers = models.roles.find((r) => r.role === "interrogate reviewers").models;
  const rows = reviewers.map((m, i) => `| Reviewer ${String.fromCharCode(65 + i)} | ${code(m)} |`);
  lines.splice(header + 2, end - header - 2, ...rows);
  return lines.join("\n");
}

export function codexModelNamesSection(models) {
  return (
    "Skills name Claude defaults (a single-role default for code/prose/judgment plus a diverse-model panel for " +
    "diverse-model panels; each model-consuming skill lists its own in a Models section). These slugs do not " +
    "resolve on Codex. Substitute your configured Codex models:\n\n" +
    `- Single-model roles: your primary Codex model (for example ${code(models.codex.singleRoleExample)}).\n` +
    "- Diverse-model panels (`arena`, `architect`, `interrogate`, `how` critics, `reflect`): the adversarial " +
    "signal comes from model diversity, so use the distinct Codex models available to you. A good default quad " +
    `on ChatGPT is ${codeList(models.codex.panelQuad)}. If only one model family is reachable, vary reasoning ` +
    "effort and note in the verdict that diversity was reduced.\n\n" +
    "`/setup-pstack` writes the configured model list. On Codex, set it to your Codex model slugs."
  );
}

// After stamping, no claude-* model slug may survive in skill prose outside
// the generator-owned regions. The scan blanks each owned line range (keeping
// line numbers stable) and reports whatever still matches.
const SLUG_RE = /claude-(?:opus|fable|sonnet|haiku)[0-9a-z.-]*/;

// [start, end) line ranges of every generator-owned region in this file.
export function ownedRanges(lines) {
  const ranges = [];
  const sectionStarts = ["## Models", "## Model names"];
  for (const heading of sectionStarts) {
    const start = lines.indexOf(heading);
    if (start === -1) continue;
    let end = start + 1;
    while (end < lines.length && !lines[end].startsWith("## ")) end++;
    ranges.push([start + 1, end]);
  }
  const step = lines.findIndex((l) => l.startsWith("### 5. Write the override sheet"));
  if (step !== -1) {
    const open = lines.indexOf("```markdown", step);
    const close = open === -1 ? -1 : lines.indexOf("```", open + 1);
    if (close !== -1) ranges.push([open + 1, close]);
  }
  const table = lines.indexOf("| Subagent | Default model |");
  if (table !== -1) {
    let end = table + 2;
    while (end < lines.length && lines[end].startsWith("| Reviewer ")) end++;
    ranges.push([table + 2, end]);
  }
  return ranges;
}

export function strayModelSlugs(path, text) {
  const lines = text.split("\n");
  const owned = ownedRanges(lines);
  const strays = [];
  lines.forEach((line, i) => {
    if (!SLUG_RE.test(line)) return;
    if (owned.some(([s, e]) => i >= s && i < e)) return;
    strays.push(`${path}:${i + 1}: ${line.trim()}`);
  });
  return strays;
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

// hooks.json names commands as "${CLAUDE_PLUGIN_ROOT}/hooks/run-hook.cmd <script>";
// both the runner and the named script must exist in the plugin and be
// executable, or the SessionStart hook fails silently for every user.
export function validateHooks(hooksJson, { statOf }) {
  const problems = [];
  for (const [event, groups] of Object.entries(JSON.parse(hooksJson).hooks ?? {})) {
    for (const group of groups) {
      for (const hook of group.hooks ?? []) {
        const m = hook.command?.match(/\$\{CLAUDE_PLUGIN_ROOT\}\/([^"\s]+)"?(?:\s+(\S+))?/);
        if (!m) {
          problems.push(`${event}: command does not reference \${CLAUDE_PLUGIN_ROOT}: ${hook.command}`);
          continue;
        }
        const targets = [m[1]];
        if (m[1].endsWith("run-hook.cmd") && m[2]) targets.push(`hooks/${m[2]}`);
        for (const t of targets) {
          const st = statOf(t);
          if (!st) problems.push(`${event}: ${t} does not exist`);
          else if (!(st.mode & 0o111)) problems.push(`${event}: ${t} is not executable`);
        }
      }
    }
  }
  if (problems.length) throw new Error(`hooks.json:\n  ${problems.join("\n  ")}`);
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

  const models = JSON.parse(readFileSync(join(repo, "plugins/pstack/models.json"), "utf8"));
  const skillsDir = join(repo, "plugins/pstack/skills");

  const bySkill = new Map();
  for (const r of models.roles) {
    if (!bySkill.has(r.skill)) bySkill.set(r.skill, []);
    bySkill.get(r.skill).push(r);
  }
  const stampFile = (path, next, label) => {
    if (readFileSync(path, "utf8") === next) return false;
    writeFileSync(path, next);
    console.log(`stamped: ${label}`);
    return true;
  };
  let modelStamps = 0;
  for (const [skill, roles] of bySkill) {
    const path = join(skillsDir, skill, "SKILL.md");
    let text = readFileSync(path, "utf8");
    if (skill === "interrogate") {
      text = stampReviewerTable(text, models, path);
    } else {
      text = replaceSection(text, "Models", modelsSection(roles), path);
    }
    if (stampFile(path, text, `skills/${skill}/SKILL.md (models)`)) modelStamps++;
  }
  {
    const path = join(skillsDir, "setup-pstack/SKILL.md");
    let text = readFileSync(path, "utf8");
    text = replaceSection(text, "Models", setupModelsSection(models), path);
    text = stampOverrideSheet(text, models, path);
    if (stampFile(path, text, "skills/setup-pstack/SKILL.md (models)")) modelStamps++;
  }
  {
    const path = join(skillsDir, "poteto-mode/references/codex-tools.md");
    const text = readFileSync(path, "utf8");
    const next = replaceSection(text, "Model names", codexModelNamesSection(models), path);
    if (stampFile(path, next, "poteto-mode/references/codex-tools.md (models)")) modelStamps++;
  }
  if (modelStamps === 0) console.log("ok: model-policy sections current");

  const strays = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === "scripts") continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith(".md")) {
        strays.push(...strayModelSlugs(full.slice(repo.length + 1), readFileSync(full, "utf8")));
      }
    }
  };
  walk(skillsDir);
  if (strays.length) {
    throw new Error(
      `claude-* model slugs outside generator-owned regions (move the fact into models.json or reference the role):\n` +
        strays.join("\n"),
    );
  }
  console.log("ok: no stray model slugs in skill prose");

  const skills = publicSkills(skillsDir);

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

  const pluginRoot = join(repo, "plugins/pstack");
  validateHooks(readFileSync(join(pluginRoot, "hooks/hooks.json"), "utf8"), {
    statOf: (rel) => (existsSync(join(pluginRoot, rel)) ? statSync(join(pluginRoot, rel)) : null),
  });
  console.log("ok: hooks.json commands point at existing, executable scripts");
}

// Guarded so importing the generator's validation and rendering functions does
// not regenerate the repo as a side effect.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (err) {
    console.error(`FAIL: ${err.message}`);
    process.exit(1);
  }
}
