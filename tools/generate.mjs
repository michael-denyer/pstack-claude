#!/usr/bin/env bun
// Stamps facts that live in one source file into every file that carries a
// copy, and validates cross-file contracts. Idempotent; run it after editing
// a source of truth. CI contract: `bun tools/generate.mjs --check` writes
// nothing and fails when a committed copy is stale, so it cannot ship.
//
// Sources of truth:
//   VERSION  -> the "version" field in the three plugin manifests
//   CHANGES.md must carry a heading for the current VERSION (release completeness)
//   each skill's frontmatter (name + description) defines the shared Agent
//   Skills boundary consumed natively by Codex, Prime, opencode, and Gemini CLI
//   docs/reference.md's "Slash commands" table (one row per public skill, in editorial
//   order; the row text is the Codex slash-menu one-liner)
//     -> its Codex prompt stub in plugins/pstack/.codex-plugin/prompts/
//   The row set must equal the public skills (every Agent Skill not marked
//   user-invocable: false); a skill without a row or a row without a skill
//   fails by name.
//   plugins/pstack/models.json (the model policy: role defaults, diverse panel,
//   available slugs, Codex equivalents)
//     -> each model-consuming skill's "## Models" section
//     -> setup-pstack's override-sheet block and interrogate's reviewer table
//     -> the "## Model names" section of poteto-mode/references/codex-tools.md
//     -> one effort agent pair per level in plugins/pstack/effort-agents/
//   plugins/pstack/{agents,effort-agents}/*.md -> the "agents" list in
//     plugins/pstack/.claude-plugin/plugin.json (a list replaces the default
//     agents/ directory, so it names every agent)
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
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { markdownFiles, pathIsInside, validateProsePaths, validateSkillsTree, walk } from "./validate-skills.mjs";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");

const PLUGIN = "plugins/pstack";
const SKILLS = `${PLUGIN}/skills`;
const PROMPTS = `${PLUGIN}/.codex-plugin/prompts`;
const EFFORT_AGENTS = `${PLUGIN}/effort-agents`;

const VERSIONED_MANIFESTS = [
  ".claude-plugin/marketplace.json",
  "plugins/pstack/.claude-plugin/plugin.json",
  "plugins/pstack/.codex-plugin/plugin.json",
];

export const PORTABLE_ASSETS = [
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

// The generator removes every entry of these directories that no planned path
// runs through, so no hand-written file may live in one.
export const OWNED_DIRS = [
  PROMPTS,
  EFFORT_AGENTS,
  `${SKILLS}/poteto-mode/references/agents`,
  `${SKILLS}/poteto-mode/references/licenses`,
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

// Every release heading reads "## <version> - <title>"; the current version
// must have one. A bump without an entry (or an entry without a bump) ships a
// release nobody can read about.
export function assertChangesHeading(changes, version) {
  const lines = changes.split("\n");
  const current = lines.find((line) => line.startsWith(`## ${version} `));
  if (!current) throw new Error(`CHANGES.md has no "## ${version} - <title>" heading`);
  const malformed = lines.filter((line) => /^## \d+\.\d+\.\d+/.test(line) && !/^## \d+\.\d+\.\d+ - \S/.test(line));
  if (malformed.length) {
    throw new Error(`CHANGES.md release headings read "## <version> - <title>":\n${malformed.join("\n")}`);
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

// Split a Markdown file into its YAML frontmatter and the text after it.
// `data` is null when the file does not open with a frontmatter block.
export function parseFrontmatter(text) {
  const block = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!block) return { data: null, body: text };
  return { data: Bun.YAML.parse(block[1]) ?? {}, body: text.slice(block[0].length) };
}

// Validate the shared subset of the Agent Skills contract before deriving any
// runtime-specific views. Runtime-only frontmatter keys may be ignored by other
// consumers, but every skill needs a portable name and description.
export function agentSkills(skillsDir) {
  const skills = [];
  for (const entry of readdirSync(skillsDir).sort()) {
    const path = join(skillsDir, entry, "SKILL.md");
    if (!statSync(join(skillsDir, entry)).isDirectory() || !existsSync(path)) continue;
    const front = parseFrontmatter(readFileSync(path, "utf8")).data ?? {};
    const name = front.name;
    if (name !== entry) throw new Error(`${path}: frontmatter name "${name}" != directory "${entry}"`);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64) {
      throw new Error(`${path}: frontmatter name "${name}" is not a portable Agent Skills name`);
    }
    const description = front.description;
    if (typeof description !== "string" || !description) {
      throw new Error(`${path}: skill has no description frontmatter`);
    }
    if (description.length > 1024) {
      throw new Error(`${path}: description exceeds the portable Agent Skills limit of 1024 characters`);
    }
    // CHANGES 0.9.8: on a skill the flag makes the Skill tool refuse the
    // invocation outright, which breaks the SessionStart mandate. Upstream
    // ships it on every skill; the sync derivation strips it.
    if (front["disable-model-invocation"] === true) {
      throw new Error(`${path}: disable-model-invocation: true breaks model-initiated entry (CHANGES 0.9.8)`);
    }
    const userInvocable = front["user-invocable"] !== false;
    // CHANGES 0.9.9: principle leaves are read by path from poteto-mode and
    // stay out of the slash menu.
    if (name.startsWith("principle-") && userInvocable) {
      throw new Error(`${path}: principle leaves carry user-invocable: false (CHANGES 0.9.9)`);
    }
    skills.push({ name, description, userInvocable });
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
  const agents = pluginAgentPaths(pluginRoot).map((p) => basename(p, ".md"));
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
  // tools/sync.mjs writes an unresolved three-way merge with git's markers and
  // still advances the pin, so this check is what keeps it out of a release.
  const markers = [];
  for (const file of walk(pluginRoot)) {
    if (!lstatSync(file).isFile()) continue;
    const raw = readFileSync(file);
    if (raw.includes(0)) continue;
    raw.toString("utf8").split("\n").forEach((line, i) => {
      if (/^(<{7}|={7}|>{7})( |$)/.test(line)) markers.push(`${relative(pluginRoot, file)}:${i + 1}: ${line}`);
    });
  }
  if (markers.length) {
    throw new Error(`unresolved sync conflict markers; resolve each hunk by hand:\n${markers.join("\n")}`);
  }
}

// A public skill is any Agent Skill not marked user-invocable: false (the
// principle-* leaves). Each has a row in the reference slash-command table.
export function publicSkills(skillsDir) {
  return agentSkills(skillsDir)
    .filter((skill) => skill.userInvocable)
    .map(({ name }) => name);
}

const COMMANDS_DOC = "docs/reference.md";
const COMMAND_TABLE_HEADER = "| command | use it when |";
// promptStub writes the menu text unquoted into YAML frontmatter, where ": " or
// a trailing ":" starts a mapping, " #" starts a comment, and a leading
// indicator character is a parse error or a different node.
const UNSAFE_PLAIN_YAML = /:\s|:$|\s#|^(?:[,[\]{}#&*!|>'"%@`]|[-?:](?:\s|$))/;

// The reference table is the source of the Codex slash-menu one-liners and their
// order. Returns [{ name, menu }] in row order; throws when the row set and the
// public skills disagree, naming each side's leftovers.
export function slashCommands(markdown, skillNames) {
  const lines = markdown.split("\n");
  const range = tableRows(COMMAND_TABLE_HEADER, "|")(lines);
  if (!range) throw new Error(`${COMMANDS_DOC}: "${COMMAND_TABLE_HEADER}" table header not found`);
  const rows = lines.slice(range[0], range[1]).map((line, i) => {
    const m = line.match(/^\| `\/([^`]+)` \| (.+) \|$/);
    if (!m) throw new Error(`${COMMANDS_DOC}: slash-command row ${i + 1} is not "| \`/name\` | text |": ${line}`);
    if (UNSAFE_PLAIN_YAML.test(m[2])) {
      throw new Error(
        `${COMMANDS_DOC}: slash-command row ${i + 1} text is not a plain YAML value ` +
          `(no ": ", " #", trailing ":", or leading indicator): ${line}`,
      );
    }
    return { name: m[1], menu: m[2] };
  });
  const rowNames = new Set(rows.map((r) => r.name));
  const skills = new Set(skillNames);
  const extraRows = [...rowNames].filter((n) => !skills.has(n));
  const missingRows = [...skills].filter((n) => !rowNames.has(n));
  if (extraRows.length || missingRows.length) {
    throw new Error(
      `${COMMANDS_DOC} slash-command table is out of sync with the public skills` +
        (extraRows.length ? `; row without a skill: ${extraRows.join(", ")}` : "") +
        (missingRows.length ? `; skill without a row: ${missingRows.join(", ")}` : ""),
    );
  }
  if (rows.length !== rowNames.size) throw new Error(`${COMMANDS_DOC} slash-command table repeats a command`);
  return rows;
}

// Optional Codex slash shortcut. Skills also link to the platform mapping so
// native invocation and skills-only installs do not depend on these stubs.
export function promptStub({ name, menu }) {
  return (
    `---\nname: ${name}\ndescription: ${menu}\ndisable-model-invocation: true\n---\n\n` +
    `Invoke the \`${name}\` skill and follow it. Resolve Claude tool names, Claude model names, and ` +
    "Claude built-in skills through `poteto-mode/references/codex-tools.md`, including its Per-skill notes.\n"
  );
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

// The inside of the first ```<lang> fence after the `### N. <title>` step
// heading. The ordinal is not part of the anchor, so inserting a step above it
// does not move the region.
export const fenceUnder = (title, lang) => (lines) => {
  const heading = "### " + title;
  const step = lines.findIndex((l) => l.replace(/^### \d+\. /, "### ") === heading);
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

function requiredRole(models, label) {
  const role = models.roles.find((r) => r.role === label);
  if (!role) throw new Error(`models.json: no "${label}" role, which a stamped region renders from`);
  return role;
}

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
  const reviewers = requiredRole(models, "interrogate reviewers").models;
  return [
    ...[...rolesBySkill]
      .filter(([skill]) => skill !== "interrogate")
      .map(([skill, roles]) => ({
        file: skillFile(skill),
        name: "Models section",
        locate: section("Models"),
        appendHeading: "## Models",
        render: () => blankPadded(modelsSection(roles)),
      })),
    {
      file: skillFile("interrogate"),
      name: "reviewer table",
      locate: tableRows("| Subagent | Default model |", "| Reviewer "),
      render: () => reviewers.map((m, i) => `| Reviewer ${String.fromCharCode(65 + i)} | ${code(m)} |`),
    },
    ...[...rolesBySkill].map(([skill]) => ({
      file: skillFile(skill),
      name: "Reasoning effort section",
      locate: section("Reasoning effort"),
      appendHeading: "## Reasoning effort",
      render: () => blankPadded(effortSection(models.efforts, models.defaultEffort)),
    })),
    {
      file: skillFile("setup-pstack"),
      name: "Models section",
      locate: section("Models"),
      render: () => blankPadded(setupModelsSection(models)),
    },
    {
      file: skillFile("setup-pstack"),
      name: "override sheet",
      locate: fenceUnder("Write the override sheet", "markdown"),
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

const CODEX_TOOLS = `${SKILLS}/poteto-mode/references/codex-tools.md`;
const CODEX_NOTES_HEADER = "| Skill | On Codex |";
const CODEX_PREAMBLE =
  "On Codex, read the [platform mapping](../poteto-mode/references/codex-tools.md), including its per-skill notes, before following this skill.";
const DRIVER_LINE = "Resolve the driver skill through [poteto-mode's Non-negotiables](../SKILL.md#non-negotiables).";
const DRIVER_PLAYBOOKS = ["autopilot-full", "multi-phase-plan", "orchestrate", "refactoring", "shipping"];

// The skills with a row in the Codex mapping's Per-skill notes table, in row order.
export function codexNoteSkills(markdown) {
  const lines = markdown.split("\n");
  const range = tableRows(CODEX_NOTES_HEADER, "| ")(lines);
  if (!range) throw new Error(`${CODEX_TOOLS}: "${CODEX_NOTES_HEADER}" table header not found`);
  return lines.slice(...range).map((row) => {
    const skill = row.match(/^\| `([a-z0-9-]+)` \|/)?.[1];
    if (!skill) throw new Error(`${CODEX_TOOLS}: Per-skill notes row does not start with a backticked skill: ${row}`);
    return skill;
  });
}

// The line the generator owns under a file's first heading, by repo-relative
// file: the Codex preamble on each skill the Per-skill notes table has a row
// for, and the driver-skill line on the playbooks that drive an app.
export function loadLeadLines(root = repo) {
  const leads = new Map();
  for (const skill of codexNoteSkills(readFileSync(join(root, CODEX_TOOLS), "utf8"))) {
    const file = `${SKILLS}/${skill}/SKILL.md`;
    if (!existsSync(join(root, file))) throw new Error(`${CODEX_TOOLS}: per-skill note for "${skill}", which has no SKILL.md`);
    leads.set(file, CODEX_PREAMBLE);
  }
  for (const playbook of DRIVER_PLAYBOOKS) leads.set(`${SKILLS}/poteto-mode/playbooks/${playbook}.md`, DRIVER_LINE);
  return leads;
}

// Put `line` in its own paragraph right under the first heading after the
// frontmatter, replacing it if already there. Null when there is no heading.
export function stampLeadLine(text, line) {
  const lines = text.split("\n");
  const bodyStart = lines[0] === "---" ? lines.indexOf("---", 1) + 1 : 0;
  const heading = lines.findIndex((l, i) => i >= bodyStart && /^#{1,6} /.test(l));
  if (heading === -1) return null;
  const present = lines[heading + 1] === "" && lines[heading + 2] === line;
  lines.splice(heading + 1, present ? 2 : 0, "", line);
  return lines.join("\n");
}

// Stamp every region the generator owns in `file` (repo-relative). A missing
// anchor throws: a stamped region is a structural contract with the file, not
// an optional nicety. With strict: false a missing anchor is left alone.
export function applyRegions(file, text, models, { strict = true } = {}) {
  const lines = text.split("\n");
  for (const region of regions(models).filter((r) => r.file === file)) {
    const range = region.locate(lines);
    if (!range) {
      if (strict) throw new Error(`${file}: no anchor for the ${region.name} to stamp`);
      continue;
    }
    lines.splice(range[0], range[1] - range[0], ...region.render());
  }
  return lines.join("\n");
}

// A role's "models" names a tier (default, strongest, panel) or lists slugs.
// A tier resolves to its models and stays on the role as `tier`, so moving a
// tier is one edit and the Codex mapping can follow the same keys.
export function resolveModels(models) {
  return {
    ...models,
    roles: models.roles.map((r) =>
      typeof r.models === "string" ? { ...r, tier: r.models, models: [models.tiers[r.models]].flat() } : r,
    ),
  };
}

const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"];

// Check models.json's shape and resolve its tiers, throwing with the offending
// role, tier, or slug named. `skillExists(skill)` reports whether a role's
// skill directory carries a SKILL.md.
export function parseModels(raw, skillExists) {
  const fail = (message) => {
    throw new Error(`models.json: ${message}`);
  };
  const unique = (list, owner) => {
    const seen = new Set();
    for (const item of list) {
      if (seen.has(item)) fail(`${owner} lists "${item}" twice`);
      seen.add(item);
    }
  };
  for (const key of ["available", "efforts", "roles"]) if (!Array.isArray(raw[key])) fail(`"${key}" must be a list`);
  for (const key of ["tiers", "codex"]) {
    if (!raw[key] || typeof raw[key] !== "object") fail(`"${key}" must be an object`);
  }
  const available = new Set(raw.available);
  unique(raw.available, "available");
  const tierLists = new Map();
  for (const [tier, value] of Object.entries(raw.tiers)) {
    const slugs = [value].flat();
    unique(slugs, `tier "${tier}"`);
    for (const slug of slugs) {
      if (!available.has(slug)) fail(`tier "${tier}" names "${slug}", which is not in available`);
    }
    tierLists.set(slugs.join(), tier);
  }
  const labels = new Set();
  for (const role of raw.roles) {
    if (labels.has(role.role)) fail(`role "${role.role}" appears twice`);
    labels.add(role.role);
    if (!skillExists(role.skill)) fail(`role "${role.role}" names skill "${role.skill}", which has no SKILL.md`);
    if (typeof role.models === "string") {
      if (!Object.hasOwn(raw.tiers, role.models)) {
        fail(`role "${role.role}" names tier "${role.models}", which tiers does not define`);
      }
      continue;
    }
    if (!Array.isArray(role.models) || role.models.length === 0) {
      fail(`role "${role.role}" needs a tier name or a non-empty list of models`);
    }
    for (const slug of role.models) {
      if (!available.has(slug)) fail(`role "${role.role}" names "${slug}", which is not in available`);
    }
    const tier = tierLists.get(role.models.join());
    if (tier) fail(`role "${role.role}" lists tier "${tier}" literally; name the tier`);
  }
  unique(raw.efforts, "efforts");
  for (const level of raw.efforts) {
    if (!EFFORT_LEVELS.includes(level)) fail(`effort "${level}" is not one of ${EFFORT_LEVELS.join(", ")}`);
  }
  if (!raw.efforts.includes(raw.defaultEffort) && raw.defaultEffort !== "session") {
    fail(`defaultEffort "${raw.defaultEffort}" is not an effort level or "session"`);
  }
  for (const tier of Object.keys(raw.tiers)) {
    if (!Object.hasOwn(raw.codex, tier)) fail(`codex has no example for tier "${tier}"`);
  }
  for (const [tier, value] of Object.entries(raw.codex)) {
    if (!Object.hasOwn(raw.tiers, tier)) fail(`codex names "${tier}", which is not a tier`);
    unique([value].flat(), `codex "${tier}"`);
  }
  return resolveModels(raw);
}

export function loadModels(root = repo) {
  const skillsDir = join(root, SKILLS);
  return parseModels(JSON.parse(readFileSync(join(root, PLUGIN, "models.json"), "utf8")), (skill) =>
    existsSync(join(skillsDir, skill, "SKILL.md")),
  );
}

// Frontmatter keys only Cursor reads. The port drops each with any indented
// continuation lines.
const CURSOR_ONLY_KEYS = /^(?:mode|icon|color|reminder|is_background):/;

// The port's frontmatter for an upstream skill or plugin agent: `name` is the
// skill's directory or the agent's file name, which is how Claude Code
// registers it; Cursor-only keys go. Upstream ships
// disable-model-invocation: true on every skill; the port drops it on public
// skills and swaps it for user-invocable: false on principle leaves (CHANGES
// 0.9.8, 0.9.9).
function portFrontmatter(file, text) {
  const skill = file.match(/^plugins\/pstack\/skills\/([^/]+)\/SKILL\.md$/)?.[1];
  const name = skill ?? file.match(/^plugins\/pstack\/agents\/([^/]+)\.md$/)?.[1];
  if (!name) return text;
  const { body } = parseFrontmatter(text);
  const kept = [];
  let dropping = false;
  for (const line of text.slice(0, text.length - body.length).split("\n")) {
    dropping = CURSOR_ONLY_KEYS.test(line) || (dropping && /^\s/.test(line));
    if (!dropping) kept.push(line.startsWith("name:") ? `name: ${name}` : line);
  }
  const head = kept.join("\n");
  if (!skill) return head + body;
  const swap = skill.startsWith("principle-") ? "\nuser-invocable: false\n" : "\n";
  return head.replace("\ndisable-model-invocation: true\n", swap) + body;
}

// The port's derivation of an upstream file, as tools/sync.mjs applies it
// before comparing with the local copy: the port's frontmatter, then the
// generator's own stamps, its lead line first. A Models section is appended as the last H2 when
// upstream has none, which is where every hand-added one already sits. A
// region whose anchor upstream lacks is left unstamped, so the file surfaces
// as forked or conflicted instead of aborting the sync.
export function deriveSkill(file, text, models, leads) {
  const front = portFrontmatter(file, text);
  const line = leads.get(file);
  const out = (line && stampLeadLine(front, line)) || front;
  const lines = out.split("\n");
  for (const region of regions(models).filter((r) => r.file === file && r.appendHeading)) {
    if (region.locate(lines)) continue;
    if (lines.at(-1) !== "") lines.push("");
    lines.push(region.appendHeading, "");
  }
  return applyRegions(file, lines.join("\n"), models, { strict: false });
}

export function modelsSection(roles) {
  const bullets = roles.map((r) => `- ${r.role}: ${codeList(r.models)}`).join("\n");
  return (
    "Role defaults, stamped from `plugins/pstack/models.json` (edit there, rerun `tools/generate.mjs`). " +
    "A matching role line in the `pstack-models.md` override sheet overrides each at runtime; `/setup-pstack` writes it and lists its path per runtime.\n\n" +
    bullets
  );
}

// An override value may name a reasoning effort after its slug. Claude Code has
// no per-call effort parameter, but a subagent definition's `effort` frontmatter
// overrides the session's effort, so each level ships as an agent the role is
// dispatched through, with the model still passed on the call.
export function effortSection(levels, defaultEffort) {
  return (
    "A role value in the override sheet may name a reasoning effort after its model, as in `opus @xhigh`. " +
    "Levels on Claude Code: " + codeList(levels) + ". Which ones apply depends on the model. " +
    "A value without `@` takes the sheet's `default effort` line, a level or `session`, " +
    `and ${code(defaultEffort)} when the sheet has no such line. \`session\` sets no effort, so the dispatch ` +
    "is the usual one. Strip the suffix before reading the model: `inherit-parent` or `auto` still omits `model` " +
    "at every level, and a model name is passed as `model`. " +
    "On Claude Code, a level picks the effort agent from the `subagent_type` you would otherwise use. " +
    "`pstack:poteto-agent` becomes `subagent_type: \"pstack:poteto-agent-<level>\"`. " +
    "`general-purpose`, or no `subagent_type`, becomes `subagent_type: \"pstack:effort-<level>\"`. " +
    "The effort agents set only `effort`, so the model you pass still decides the model. " +
    "On Codex, pass the level as `spawn_agent`'s `reasoning_effort` and keep the usual instructions."
  );
}

// The effort agents: one general-purpose worker and one poteto-agent per level.
// The poteto variants carry poteto-agent's body. Their descriptions name
// pstack:poteto-agent instead of copying its routing contract, so only the
// base agent reads as the routing target for /poteto-mode.
export function effortAgents(levels, potetoAgent) {
  const { body } = parseFrontmatter(potetoAgent);
  return levels.flatMap((level) => [
    {
      name: `effort-${level}`,
      text:
        `---\nname: effort-${level}\ndescription: pstack subagent with the full tool set that runs at ${level} reasoning effort. ` +
        `Its system prompt is this file, not the built-in \`general-purpose\` prompt. Dispatched in place of ` +
        `\`general-purpose\` when a pstack role's override names \`@${level}\`. The caller passes the model.\n` +
        `effort: ${level}\n---\n\n# pstack subagent (${level} effort)\n\n` +
        "Do the task in your prompt. You have the full tool set. " +
        "The effort level changes how long you reason, not the task.\n",
    },
    {
      name: `poteto-agent-${level}`,
      text:
        `---\nname: poteto-agent-${level}\ndescription: \`pstack:poteto-agent\` at ${level} reasoning effort. ` +
        `Dispatched in place of \`pstack:poteto-agent\` when a pstack role's override names \`@${level}\`. The caller passes the model.\n` +
        `effort: ${level}\n---\n` + body,
    },
  ]);
}

const AGENT_DIRS = ["agents", "effort-agents"];

// Every agent file the plugin ships, as plugin.json's "agents" list names them.
export function pluginAgentPaths(pluginRoot) {
  return AGENT_DIRS.flatMap((dir) =>
    existsSync(join(pluginRoot, dir))
      ? readdirSync(join(pluginRoot, dir))
          .filter((f) => f.endsWith(".md"))
          .sort()
          .map((f) => `./${dir}/${f}`)
      : [],
  );
}

export function stampAgentPaths(manifestText, paths) {
  return JSON.stringify({ ...JSON.parse(manifestText), agents: paths }, null, 2) + "\n";
}

export function setupModelsSection(models) {
  return (
    "Stamped from `plugins/pstack/models.json` (edit there, rerun `tools/generate.mjs`).\n\n" +
    `- Available Claude models: ${codeList(models.available)}\n` +
    `- Default panel: ${codeList(models.tiers.panel)}\n` +
    `- Reasoning effort levels: ${codeList(models.efforts)}\n` +
    `- Default reasoning effort: ${code(models.defaultEffort)}\n` +
    `- Single-role default: ${code(models.tiers.default)}`
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
    "an alias entry in a panel list still counts toward that panel's fan-out. " +
    "A model may carry a reasoning effort, as in `opus @xhigh` (levels: " + models.efforts.join(", ") + "); " +
    "the role then runs through the pstack effort agent of that level, each entry of a panel list on its own. " +
    "`default effort` sets the level for a value without one; `session` keeps the parent session's effort. " +
    "`session hook: off` stops the Claude Code or Codex SessionStart hook from injecting the poteto-mode mandate; " +
    "any other value, or no line, leaves it on.\n\n" +
    rows +
    `\n\ndefault effort: ${models.defaultEffort}\nsession hook: on`
  );
}

export function codexModelNamesSection(models) {
  const strongest = models.roles.filter((r) => r.tier === "strongest");
  return (
    "Skills name Claude defaults (a single-role default for code/prose/judgment plus a diverse-model panel for " +
    "diverse-model panels; each model-consuming skill lists its own in a Models section). These slugs do not " +
    "resolve on Codex. Substitute your configured Codex models:\n\n" +
    `- Single-model roles: your primary Codex model (for example ${code(models.codex.default)}).\n` +
    `- Roles that default to the strongest Claude model (${strongest.map((r) => code(r.role)).join(", ")}): ` +
    `your strongest Codex model (for example ${code(models.codex.strongest)}).\n` +
    "- Diverse-model panels (`arena`, `architect`, `interrogate`, `how` critics, `reflect`): the adversarial " +
    "signal comes from model diversity, so use the distinct Codex models available to you. A good default panel " +
    `on ChatGPT is ${codeList(models.codex.panel)}. If only one model family is reachable, vary reasoning ` +
    "effort and note in the verdict that diversity was reduced.\n\n" +
    "`/setup-pstack` writes the configured model list. On Codex, set it to your Codex model slugs."
  );
}

// After stamping, skill prose outside the regions the generator owns may name
// no model: a full claude-* ID is rejected by the Agent tool, and a backticked
// family name hard-codes a default that belongs in models.json.
export function strayModelSlugs(file, text, models) {
  const families = models.available.join("|");
  const SLUG_RE = new RegExp(`claude-(?:${families})[0-9a-z.-]*|\`(?:${families})\``);
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

// Every ${CLAUDE_PLUGIN_ROOT}/<path> a hook command names must exist in the
// plugin, and one the command executes directly must be executable, or the
// SessionStart hook fails silently for every user.
export function validateHooks(hooksJson, { statOf, file = "hooks/hooks.json" }) {
  const problems = [];
  for (const [event, groups] of Object.entries(JSON.parse(hooksJson).hooks ?? {})) {
    for (const group of groups) {
      for (const hook of group.hooks ?? []) {
        const refs = [...hook.command.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([^"\s]+)/g)].map((m) => m[1]);
        if (!refs.length) {
          problems.push(`${event}: command does not reference \${CLAUDE_PLUGIN_ROOT}: ${hook.command}`);
          continue;
        }
        const executed = hook.command.replace(/^"/, "").startsWith("${CLAUDE_PLUGIN_ROOT}/");
        refs.forEach((rel, i) => {
          const st = statOf(rel);
          if (!st) problems.push(`${event}: ${rel} does not exist`);
          else if (i === 0 && executed && !(st.mode & 0o111)) problems.push(`${event}: ${rel} is not executable`);
        });
      }
    }
  }
  if (problems.length) throw new Error(`${file}:\n  ${problems.join("\n  ")}`);
}

// Every file the generator writes, as exact text by repo-relative path,
// computed from the sources under `root` without writing. Any other entry in
// an owned directory is an orphan. Throws when a source cannot be planned.
export function plan(root) {
  const read = (rel) => readFileSync(join(root, rel), "utf8");
  const version = read("VERSION").trim();
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`VERSION must be MAJOR.MINOR.PATCH, got "${version}"`);
  assertChangesHeading(read("CHANGES.md"), version);
  const models = loadModels(root);

  const files = {};
  for (const file of VERSIONED_MANIFESTS) files[file] = stampVersion(read(file), version, file);
  for (const file of new Set(regions(models).map((r) => r.file))) files[file] = applyRegions(file, read(file), models);
  for (const [file, line] of loadLeadLines(root)) {
    const stamped = stampLeadLine(files[file] ?? read(file), line);
    if (stamped === null) throw new Error(`${file}: no heading to stamp its lead line under`);
    files[file] = stamped;
  }
  for (const skill of slashCommands(read(COMMANDS_DOC), publicSkills(join(root, SKILLS)))) {
    files[`${PROMPTS}/${skill.name}.md`] = promptStub(skill);
  }
  const agents = effortAgents(models.efforts, read(`${PLUGIN}/agents/poteto-agent.md`));
  for (const agent of agents) files[`${EFFORT_AGENTS}/${agent.name}.md`] = agent.text;
  const manifest = `${PLUGIN}/.claude-plugin/plugin.json`;
  files[manifest] = stampAgentPaths(files[manifest], [
    ...pluginAgentPaths(join(root, PLUGIN)).filter((path) => path.startsWith("./agents/")),
    ...agents.map((agent) => `./effort-agents/${agent.name}.md`).sort(),
  ]);
  for (const dir of OWNED_DIRS) {
    const outer = OWNED_DIRS.find((other) => dir.startsWith(`${other}/`));
    if (outer) throw new Error(`generator-owned directory ${dir} is nested inside ${outer}`);
  }
  const realRoot = realpathSync(root);
  for (const { source, target } of PORTABLE_ASSETS) {
    const path = `${SKILLS}/${target}`;
    if (!OWNED_DIRS.includes(dirname(path))) {
      throw new Error(`${path} is not directly inside a generator-owned directory (${OWNED_DIRS.join(", ")})`);
    }
    if (!pathIsInside(realRoot, realpathSync(join(root, source)))) {
      throw new Error(`${source} resolves outside the repository through a symlink`);
    }
    files[path] = read(source);
  }
  return { files, ownedDirs: OWNED_DIRS };
}

function lstatNoSymlinks(root, path) {
  let at = root;
  let st = null;
  for (const part of path.split("/")) {
    at = join(at, part);
    st = lstatSync(at, { throwIfNoEntry: false });
    if (!st) return null;
    if (st.isSymbolicLink()) throw new Error(`${relative(root, at)} is a symlink; the generator never writes through one`);
  }
  return st;
}

export function changes(root, intended) {
  const pending = [];
  for (const [path, text] of Object.entries(intended.files)) {
    const st = lstatNoSymlinks(root, path);
    if (st && !st.isFile()) throw new Error(`${path} is not a regular file; the generator never overwrites one`);
    if (!st || readFileSync(join(root, path), "utf8") !== text) pending.push({ kind: "write", path });
  }
  const planned = Object.keys(intended.files);
  for (const dir of intended.ownedDirs) {
    if (!lstatNoSymlinks(root, dir)) continue;
    for (const entry of readdirSync(join(root, dir)).sort()) {
      const path = `${dir}/${entry}`;
      if (!planned.some((p) => p === path || p.startsWith(`${path}/`))) pending.push({ kind: "remove", path });
    }
  }
  return pending;
}

export function apply(root, intended, { log = console.log } = {}) {
  const pending = changes(root, intended);
  for (const { kind, path } of pending) {
    const full = join(root, path);
    if (kind === "remove") {
      rmSync(full, { recursive: true, force: true });
    } else {
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, intended.files[path]);
    }
    log(`${kind}: ${path}`);
  }
  return pending;
}

// Every cross-file contract the tree under `root` breaks, one message per
// failing check. The checks read the tree, not the plan, so on a stale tree
// they see the stale copies.
export function problems(root) {
  const failures = [];
  const attempt = (check) => {
    try {
      return check();
    } catch (err) {
      failures.push(err.message);
    }
  };
  const pluginRoot = join(root, PLUGIN);
  const skillsDir = join(root, SKILLS);
  const codexManifestFile = `${PLUGIN}/.codex-plugin/plugin.json`;
  const codexManifest = attempt(() => {
    const text = readFileSync(join(root, codexManifestFile), "utf8");
    let manifest;
    try {
      manifest = JSON.parse(text);
    } catch (err) {
      throw new Error(`${codexManifestFile}: ${err.message}`);
    }
    if (typeof manifest !== "object" || !manifest) throw new Error(`${codexManifestFile}: not a JSON object`);
    return manifest;
  });
  const models = attempt(() => loadModels(root));
  const statOf = (rel) => (existsSync(join(pluginRoot, rel)) ? statSync(join(pluginRoot, rel)) : null);
  if (models) {
    attempt(() => {
      const strays = markdownFiles(skillsDir).flatMap((full) =>
        strayModelSlugs(relative(root, full), readFileSync(full, "utf8"), models),
      );
      if (strays.length) {
        throw new Error(
          `model names outside generator-owned regions (reference the role and its Models section instead):\n` +
            strays.join("\n"),
        );
      }
    });
  }
  attempt(() => {
    const leads = loadLeadLines(root);
    const strays = markdownFiles(skillsDir).flatMap((full) => {
      const file = relative(root, full);
      return readFileSync(full, "utf8")
        .split("\n")
        .flatMap((line, i) =>
          [CODEX_PREAMBLE, DRIVER_LINE].includes(line) && leads.get(file) !== line ? [`${file}:${i + 1}`] : [],
        );
    });
    if (strays.length) {
      throw new Error(
        "generator-owned lead lines outside their files (a Codex preamble needs a row in the Per-skill notes " +
          `table of ${CODEX_TOOLS}; the driver-skill line belongs to DRIVER_PLAYBOOKS):\n${strays.join("\n")}`,
      );
    }
  });
  attempt(() => validateSkillsTree(skillsDir));
  attempt(() => validateProsePaths(skillsDir));
  if (codexManifest) {
    attempt(() =>
      validateCodexMarketplace(readFileSync(join(root, ".agents/plugins/marketplace.json"), "utf8"), {
        expectedName: codexManifest.name,
        pathExists: (p) => existsSync(join(root, p)),
      }),
    );
  }
  attempt(() => validatePluginLayout(pluginRoot));
  for (const file of ["hooks/hooks.json", ...(codexManifest ? [codexManifest.hooks] : [])]) {
    attempt(() => validateHooks(readFileSync(join(pluginRoot, file), "utf8"), { statOf, file }));
  }
  return failures;
}

function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--check")) throw new Error("usage: bun tools/generate.mjs [--check]");
  const check = args.includes("--check");
  const intended = plan(repo);
  const failures = [];
  let pending;
  try {
    pending = check ? changes(repo, intended) : apply(repo, intended);
  } catch (err) {
    failures.push(err.message);
  }
  failures.push(...problems(repo));
  if (check && pending?.length) {
    failures.push(
      "generated output is stale; run bun tools/generate.mjs:\n" +
        pending.map(({ kind, path }) => `  ${kind}: ${path}`).join("\n"),
    );
  }
  if (pending?.length === 0) console.log(`ok: ${Object.keys(intended.files).length} generated files current`);
  for (const failure of failures) console.error(`FAIL: ${failure}`);
  if (failures.length) process.exit(1);
  console.log("ok: skill links, prose paths, model slugs, marketplace, plugin layout, and hooks pass their checks");
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
