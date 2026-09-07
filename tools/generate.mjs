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
//   plugins/pstack/agents/{poteto-agent,comment-sicko}.md, LICENSE,
//   LICENSE-cursor-team-kit, and NOTICE-skills.md
//     -> portable copies under poteto-mode/references/{agents,licenses}/
//   No other claude-* slug may appear in skill prose; the scan below fails on strays.
//
// Also validated: .agents/plugins/marketplace.json points at a real plugin
// directory whose Codex manifest name matches (it carries no version; Codex
// reads the version from .codex-plugin/plugin.json).

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { markdownFiles, pathIsInside, validateProsePaths, validateSkillsTree } from "./validate-skills.mjs";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");

const VERSIONED_MANIFESTS = [
  ".claude-plugin/marketplace.json",
  "plugins/pstack/.claude-plugin/plugin.json",
  "plugins/pstack/.codex-plugin/plugin.json",
];

export const PORTABLE_ASSETS = [
  {
    source: "plugins/pstack/agents/poteto-agent.md",
    target: "poteto-mode/references/agents/poteto-agent.md",
  },
  {
    source: "plugins/pstack/agents/comment-sicko.md",
    target: "poteto-mode/references/agents/comment-sicko.md",
  },
  { source: "LICENSE", target: "poteto-mode/references/licenses/LICENSE" },
  {
    source: "LICENSE-cursor-team-kit",
    target: "poteto-mode/references/licenses/LICENSE-cursor-team-kit",
  },
  { source: "NOTICE-skills.md", target: "poteto-mode/references/licenses/NOTICE.md" },
];

const PORTABLE_OUTPUT_DIRS = [
  "poteto-mode/references/agents",
  "poteto-mode/references/licenses",
];

function resolveWithin(root, path) {
  const base = resolve(root);
  const resolved = resolve(base, path);
  if (!pathIsInside(base, resolved)) {
    throw new Error(`${path} resolves outside ${base}`);
  }
  return resolved;
}

export function syncPortableAssets(repoRoot, skillsRoot, { log = console.log } = {}) {
  mkdirSync(skillsRoot, { recursive: true });
  const realRepoRoot = realpathSync(repoRoot);
  const realSkillsRoot = realpathSync(skillsRoot);
  const expectedByDir = new Map(
    PORTABLE_OUTPUT_DIRS.map((dir) => [resolveWithin(skillsRoot, dir), new Set()]),
  );
  for (const dir of expectedByDir.keys()) {
    mkdirSync(dir, { recursive: true });
    if (!pathIsInside(realSkillsRoot, realpathSync(dir))) {
      throw new Error(`${relative(skillsRoot, dir)} resolves outside the skills tree through a symlink`);
    }
  }

  const prepared = PORTABLE_ASSETS.map((asset) => {
    const source = resolveWithin(repoRoot, asset.source);
    const target = resolveWithin(skillsRoot, asset.target);
    const targetDir = dirname(target);
    if (!pathIsInside(realRepoRoot, realpathSync(source))) {
      throw new Error(`${asset.source} resolves outside the repository through a symlink`);
    }
    const expected = expectedByDir.get(targetDir);
    if (!expected) throw new Error(`${asset.target} has no declared generated output directory`);
    expected.add(basename(target));
    if (existsSync(target) && lstatSync(target).isSymbolicLink()) {
      throw new Error(`${asset.target} is a symlink; refusing to overwrite it`);
    }
    return { label: asset.target, target, next: readFileSync(source, "utf8") };
  });

  let stamped = 0;
  let removed = 0;
  for (const { label, target, next } of prepared) {
    if (existsSync(target) && readFileSync(target, "utf8") === next) continue;
    writeFileSync(target, next);
    stamped += 1;
    log(`stamped: ${label}`);
  }

  for (const [dir, expected] of expectedByDir) {
    for (const entry of readdirSync(dir)) {
      if (expected.has(entry)) continue;
      rmSync(join(dir, entry), { recursive: true, force: true });
      removed += 1;
      log(`removed orphan: ${relative(skillsRoot, join(dir, entry))}`);
    }
  }

  return { stamped, removed, total: PORTABLE_ASSETS.length };
}

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
    const flags = front.split("\n");
    // CHANGES 0.9.8: on a skill the flag makes the Skill tool refuse the
    // invocation outright, which breaks the SessionStart mandate. Upstream
    // ships it on every skill; the sync derivation strips it.
    if (flags.includes("disable-model-invocation: true")) {
      throw new Error(`${path}: disable-model-invocation: true breaks model-initiated entry (CHANGES 0.9.8)`);
    }
    const userInvocable = !flags.includes("user-invocable: false");
    // CHANGES 0.9.9: principle leaves are read by path from poteto-mode and
    // stay out of the slash menu.
    if (name.startsWith("principle-") && userInvocable) {
      throw new Error(`${path}: principle leaves carry user-invocable: false (CHANGES 0.9.9)`);
    }
    skills.push({ name, description, menu: frontmatterValue(text, "menu-description"), userInvocable });
  }
  return skills;
}

// Layout invariants that live outside any one skill.
export function validatePluginLayout(pluginRoot) {
  // CHANGES 0.9.13 (#22): Claude Code lists a plugin's commands and its
  // user-invocable skills in the slash menu, so a command trampoline beside a
  // same-named skill shows twice. The Codex trampolines live in
  // .codex-plugin/prompts/, which only Codex reads.
  if (existsSync(join(pluginRoot, "commands"))) {
    throw new Error("plugins/pstack/commands/ exists; trampolines belong in .codex-plugin/prompts/ (CHANGES 0.9.13)");
  }
  // #58: a plugin's agents register under the plugin namespace, so a dispatch
  // of the bare name errors at runtime with "Agent type 'x' not found".
  const agentsDir = join(pluginRoot, "agents");
  const agents = existsSync(agentsDir)
    ? readdirSync(agentsDir).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3))
    : [];
  const problems = [];
  for (const file of markdownFiles(join(pluginRoot, "skills"))) {
    readFileSync(file, "utf8").split("\n").forEach((line, i) => {
      for (const name of agents) {
        if (line.includes(`subagent_type: "${name}"`)) {
          problems.push(`${relative(pluginRoot, file)}:${i + 1}: subagent_type: "${name}" (use "pstack:${name}")`);
        }
      }
    });
  }
  if (problems.length) {
    throw new Error(`plugin agents are dispatched by their namespaced name:\n${problems.join("\n")}`);
  }
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

// Locators find a generator-owned span of a file and return its [start, end)
// line range, or null when the anchor is absent. The same locator serves the
// stamp (splice the rendered lines in) and the stray-slug scan (skip the
// lines it owns), so the two can never disagree about where a region is.

// The body of a "## <title>" section: everything up to the next "## " heading or EOF.
export const section = (title) => (lines) => {
  const start = lines.indexOf(`## ${title}`);
  if (start === -1) return null;
  let end = start + 1;
  while (end < lines.length && !lines[end].startsWith("## ")) end++;
  return [start + 1, end];
};

// The inside of the first ```<lang> fence after a heading line.
export const fenceUnder = (heading, lang) => (lines) => {
  const step = lines.findIndex((l) => l.startsWith(heading));
  if (step === -1) return null;
  const open = lines.indexOf("```" + lang, step);
  if (open === -1) return null;
  const close = lines.indexOf("```", open + 1);
  return close === -1 ? null : [open + 1, close];
};

// The rows under a markdown table header (header line, separator, then every
// consecutive line starting with rowPrefix).
export const tableRows = (header, rowPrefix) => (lines) => {
  const start = lines.indexOf(header);
  if (start === -1) return null;
  let end = start + 2;
  while (end < lines.length && lines[end].startsWith(rowPrefix)) end++;
  return [start + 2, end];
};

const blankPadded = (body) => ["", ...body.split("\n"), ""];

// Every generator-owned region: the file it lives in (repo-relative), how to
// find it, and what it renders from the model policy. Adding a stamped region
// means adding a row here; the stray-slug scan exempts exactly these spans.
export function regions(models) {
  const skillFile = (skill) => `plugins/pstack/skills/${skill}/SKILL.md`;
  const rolesBySkill = new Map();
  for (const r of models.roles) {
    if (!rolesBySkill.has(r.skill)) rolesBySkill.set(r.skill, []);
    rolesBySkill.get(r.skill).push(r);
  }
  const reviewers = models.roles.find((r) => r.role === "interrogate reviewers").models;
  return [
    ...[...rolesBySkill]
      .filter(([skill]) => skill !== "interrogate")
      .map(([skill, roles]) => ({
        file: skillFile(skill),
        name: "Models section",
        locate: section("Models"),
        render: () => blankPadded(modelsSection(roles)),
      })),
    {
      file: skillFile("interrogate"),
      name: "reviewer table",
      locate: tableRows("| Subagent | Default model |", "| Reviewer "),
      render: () => reviewers.map((m, i) => `| Reviewer ${String.fromCharCode(65 + i)} | ${code(m)} |`),
    },
    {
      file: skillFile("setup-pstack"),
      name: "Models section",
      locate: section("Models"),
      render: () => blankPadded(setupModelsSection(models)),
    },
    {
      file: skillFile("setup-pstack"),
      name: "override sheet",
      locate: fenceUnder("### 5. Write the override sheet", "markdown"),
      render: () => [overrideSheetBlock(models)],
    },
    {
      file: "plugins/pstack/skills/poteto-mode/references/codex-tools.md",
      name: "Model names section",
      locate: section("Model names"),
      render: () => blankPadded(codexModelNamesSection(models)),
    },
  ];
}

// Stamp every region the generator owns in `file` (repo-relative). A missing
// anchor throws: a stamped region is a structural contract with the file, not
// an optional nicety.
export function applyRegions(file, text, models) {
  const lines = text.split("\n");
  for (const region of regions(models).filter((r) => r.file === file)) {
    const range = region.locate(lines);
    if (!range) throw new Error(`${file}: no anchor for the ${region.name} to stamp`);
    lines.splice(range[0], range[1] - range[0], ...region.render());
  }
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

export function codexModelNamesSection(models) {
  const strongest = models.roles.filter(
    (r) => r.models.length === 1 && r.models[0] !== models.singleRoleDefault,
  );
  return (
    "Skills name Claude defaults (a single-role default for code/prose/judgment plus a diverse-model panel for " +
    "diverse-model panels; each model-consuming skill lists its own in a Models section). These slugs do not " +
    "resolve on Codex. Substitute your configured Codex models:\n\n" +
    `- Single-model roles: your primary Codex model (for example ${code(models.codex.singleRoleExample)}).\n` +
    `- Roles that default to the strongest Claude model (${strongest.map((r) => code(r.role)).join(", ")}): ` +
    `your strongest Codex model (for example ${code(models.codex.strongestRoleExample)}).\n` +
    "- Diverse-model panels (`arena`, `architect`, `interrogate`, `how` critics, `reflect`): the adversarial " +
    "signal comes from model diversity, so use the distinct Codex models available to you. A good default quad " +
    `on ChatGPT is ${codeList(models.codex.panelQuad)}. If only one model family is reachable, vary reasoning ` +
    "effort and note in the verdict that diversity was reduced.\n\n" +
    "`/setup-pstack` writes the configured model list. On Codex, set it to your Codex model slugs."
  );
}

// After stamping, no claude-* model slug may survive in skill prose outside
// the regions the generator owns in that file.
const SLUG_RE = /claude-(?:opus|fable|sonnet|haiku)[0-9a-z.-]*/;

export function strayModelSlugs(file, text, models) {
  const lines = text.split("\n");
  const owned = regions(models)
    .filter((r) => r.file === file)
    .map((r) => r.locate(lines))
    .filter(Boolean);
  const strays = [];
  lines.forEach((line, i) => {
    if (!SLUG_RE.test(line)) return;
    if (owned.some(([s, e]) => i >= s && i < e)) return;
    strays.push(`${file}:${i + 1}: ${line.trim()}`);
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

// Write `next` to `path` only when it differs; returns whether it wrote.
function stampFile(path, next, label) {
  if (existsSync(path) && readFileSync(path, "utf8") === next) return false;
  writeFileSync(path, next);
  console.log(`stamped: ${label}`);
  return true;
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
    if (!stampFile(path, stampVersion(readFileSync(path, "utf8"), version, file), `${file} -> ${version}`)) {
      console.log(`ok: ${file} @ ${version}`);
    }
  }

  const models = JSON.parse(readFileSync(join(repo, "plugins/pstack/models.json"), "utf8"));
  const skillsDir = join(repo, "plugins/pstack/skills");

  let modelStamps = 0;
  for (const file of new Set(regions(models).map((r) => r.file))) {
    const path = join(repo, file);
    if (stampFile(path, applyRegions(file, readFileSync(path, "utf8"), models), `${file} (models)`)) modelStamps++;
  }
  if (modelStamps === 0) console.log("ok: model-policy sections current");

  const strays = markdownFiles(skillsDir).flatMap((full) =>
    strayModelSlugs(full.slice(repo.length + 1), readFileSync(full, "utf8"), models),
  );
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
    if (stampFile(join(promptsDir, `${skill.name}.md`), promptStub(skill), `.codex-plugin/prompts/${skill.name}.md`)) {
      promptsChanged++;
    }
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
  if (!stampFile(readmePath, renderReadmeTable(readme, skills), "README.md slash-command table")) {
    console.log("ok: README slash-command table current");
  }

  const portable = syncPortableAssets(repo, skillsDir);
  if (portable.stamped === 0 && portable.removed === 0) {
    console.log(`ok: ${portable.total} portable assets current`);
  }
  validateSkillsTree(skillsDir);
  console.log("ok: local markdown links stay inside the skills tree");
  validateProsePaths(skillsDir);
  console.log("ok: no skill prose points at a path outside the skills tree");

  const codexName = JSON.parse(
    readFileSync(join(repo, "plugins/pstack/.codex-plugin/plugin.json"), "utf8"),
  ).name;
  validateCodexMarketplace(readFileSync(join(repo, ".agents/plugins/marketplace.json"), "utf8"), {
    expectedName: codexName,
    pathExists: (p) => existsSync(join(repo, p)),
  });
  console.log("ok: .agents/plugins/marketplace.json names the plugin and points at a real path");

  const pluginRoot = join(repo, "plugins/pstack");
  validatePluginLayout(pluginRoot);
  console.log("ok: no commands/ directory; plugin agents dispatched by namespaced name");
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
