#!/usr/bin/env bun
// Stamps facts that live in one source file into every file that carries a
// copy, and validates cross-file contracts. Idempotent; run it after editing
// a source of truth. CI contract: `bun tools/generate.mjs --check` writes
// nothing and fails when a committed copy is stale, so it cannot ship.
//
// Sources of truth:
//   VERSION  -> the "version" field in the Claude Code manifests and each RUNTIMES row's manifest
//   CHANGES.md must carry a heading for the current VERSION (release completeness)
//   each skill's frontmatter (name + description) defines the shared Agent
//   Skills boundary consumed natively by Codex, Prime, opencode, and Gemini CLI
//   docs/reference.md's "Slash commands" table (one row per public skill, in editorial
//   order; the row text is the slash-menu one-liner)
//     -> its prompt stub in the prompts directory of each RUNTIMES row that has one
//   The row set must equal the public skills (every Agent Skill not marked
//   user-invocable: false); a skill without a row or a row without a skill
//   fails by name.
//   plugins/pstack/models.json (the model policy: role defaults, diverse panel,
//   available slugs, and one block per RUNTIMES row: Codex equivalents, Pi IDs)
//     -> each model-consuming skill's "## Models" and "## Reasoning effort" sections
//     -> setup-pstack's Models section and override-sheet block, and interrogate's reviewer table
//     -> the "## Model names" section of each runtime's mapping file
//        (poteto-mode/references/codex-tools.md, pi-tools.md, copilot-tools.md)
//     -> one effort agent pair per level in plugins/pstack/effort-agents/
//   the Per-skill notes table in poteto-mode/references/codex-tools.md
//     -> the Codex preamble under the first heading of each listed skill's SKILL.md,
//        and the codex-tools.md pointer in the prompt stub of every other public skill
//   the Per-skill notes table in poteto-mode/references/copilot-tools.md
//     -> the GitHub Copilot preamble under the same heading, after any Codex one
//   DRIVER_PLAYBOOKS -> the driver-skill line under each playbook's first heading
//   plugins/pstack/models.json's roles, again
//     -> the role list in setup-pstack's scripts/sheet.awk, which checks a Copilot sheet
//     -> the list of skills that dispatch on role models in hooks/session-start-copilot.md
//   plugins/pstack/{agents,effort-agents}/*.md -> the "agents" list in
//     plugins/pstack/.claude-plugin/plugin.json (a list replaces the default
//     agents/ directory, so it names every agent)
//   plugins/pstack/agents/comment-sicko.md, LICENSE, LICENSE-cursor-team-kit,
//   and NOTICE-skills.md
//     -> portable copies under poteto-mode/references/{agents,licenses}/
//   No other model name (a claude-* ID or a backticked family name) may appear
//   in skill prose; the scan below fails on strays.
//
// Also validated: each RUNTIMES row's packaging, through the row's `validate`
// (tools/runtimes.mjs), and every hooks file, the Claude Code plugin's and the
// ones each row's manifest names.

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

import { Type } from "typebox";
import { Value } from "typebox/value";

import { code, codeList, PLUGIN, SKILLS } from "./plugin.mjs";
import { RUNTIMES, roleSkills } from "./runtimes.mjs";
import { markdownFiles, pathIsInside, validateProsePaths, validateSkillsTree, walk } from "./validate-skills.mjs";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");

const EFFORT_AGENTS = `${PLUGIN}/effort-agents`;
const PROMPT_RUNTIMES = RUNTIMES.filter((runtime) => runtime.prompts);

const VERSIONED_MANIFESTS = [
  ".claude-plugin/marketplace.json",
  `${PLUGIN}/.claude-plugin/plugin.json`,
  ...RUNTIMES.map((runtime) => runtime.manifest),
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
  ...PROMPT_RUNTIMES.map((runtime) => runtime.prompts),
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
export function assertChangesHeading(changelog, version) {
  const lines = changelog.split("\n");
  const current = lines.find((line) => line.startsWith(`## ${version} `));
  if (!current) throw new Error(`CHANGES.md has no "## ${version} - <title>" heading`);
  const malformed = lines.filter((line) => /^## \d+\.\d+\.\d+/.test(line) && !/^## \d+\.\d+\.\d+ - \S/.test(line));
  if (malformed.length) {
    throw new Error(`CHANGES.md release headings read "## <version> - <title>":\n${malformed.join("\n")}`);
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
  // same-named skill shows twice. Trampolines live in a runtime's prompts
  // directory, which only that runtime reads.
  if (existsSync(join(pluginRoot, "commands"))) {
    const prompts = PROMPT_RUNTIMES.map((runtime) => runtime.prompts).join(", ");
    throw new Error(`${PLUGIN}/commands/ exists; trampolines belong in ${prompts} (CHANGES 0.9.13)`);
  }
  // #58: a plugin's agents register under the plugin namespace, so a dispatch
  // of the bare name errors at runtime with "Agent type 'x' not found".
  const agents = pluginAgentPaths(pluginRoot).map((p) => basename(p, ".md"));
  const bareDispatches = [];
  for (const file of markdownFiles(join(pluginRoot, "skills"))) {
    readFileSync(file, "utf8").split("\n").forEach((line, i) => {
      for (const name of agents) {
        if (line.includes(`subagent_type: "${name}"`)) {
          bareDispatches.push(`${relative(pluginRoot, file)}:${i + 1}: subagent_type: "${name}" (use "pstack:${name}")`);
        }
      }
    });
  }
  if (bareDispatches.length) {
    throw new Error(`plugin agents are dispatched by their namespaced name:\n${bareDispatches.join("\n")}`);
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

// Optional slash shortcut for a runtime with a prompts directory. Skills also
// link to the platform mapping so native invocation and skills-only installs
// do not depend on these stubs. A skill with the runtime's stamped preamble
// already sends the reader to the mapping, so its stub does not say it again.
export function promptStub({ name, menu }, runtime, { preamble } = {}) {
  const pointer = preamble
    ? ""
    : " Resolve Claude tool names, Claude model names, and Claude built-in skills through " +
      `\`poteto-mode/references/${runtime.mapping}\`, including its Per-skill notes.`;
  return (
    `---\nname: ${name}\ndescription: ${menu}\ndisable-model-invocation: true\n---\n\n` +
    `Invoke the \`${name}\` skill and follow it.${pointer}\n`
  );
}

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

// The lines strictly between the line `open` and the next line `close`.
export const between = (open, close) => (lines) => {
  const start = lines.indexOf(open);
  if (start === -1) return null;
  const end = lines.indexOf(close, start + 1);
  return end === -1 ? null : [start + 1, end];
};

// The one line that starts with `prefix`.
export const lineStartingWith = (prefix) => (lines) => {
  const at = lines.findIndex((l) => l.startsWith(prefix));
  return at === -1 ? null : [at, at + 1];
};

const blankPadded = (body) => ["", ...body.split("\n"), ""];

const SHEET_ROLES_OPEN = "  # Stamped from plugins/pstack/models.json; edit there and rerun tools/generate.mjs.";
const ROLE_SKILLS_LINE = "Skills that dispatch on role models:";

// awk string literals: models.json role labels and effort levels hold no quote
// or backslash, which parseModels does not check, so check here.
function sheetRoles(models) {
  const quote = (s) => {
    if (/["\\]/.test(s)) throw new Error(`models.json: "${s}" cannot go in an awk string`);
    return `"${s}"`;
  };
  return [
    ...models.roles.map((r) => `  roles[++n] = ${quote(r.role)}`),
    ...models.roles.filter((r) => r.tier === "panel").map((r) => `  panel[${quote(r.role)}] = 1`),
    ...models.efforts.map((level) => `  SHEET_EFFORT[${quote(level)}] = 1`),
  ];
}

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
    ...RUNTIMES.map((runtime) => ({
      file: runtime.tools,
      name: "Model names section",
      locate: section("Model names"),
      render: () => blankPadded(runtime.modelNames(models)),
    })),
    {
      file: skillFile("setup-pstack").replace("SKILL.md", "scripts/sheet.awk"),
      name: "role list",
      locate: between(SHEET_ROLES_OPEN, "  return n"),
      render: () => sheetRoles(models),
    },
    {
      file: skillFile("setup-pstack").replace("SKILL.md", "copilot.md"),
      name: "roles by tier",
      locate: tableRows("| Tier | Roles |", "| "),
      render: () =>
        [
          ["Default", "default"],
          ["Strongest", "strongest"],
          ["Panel", "panel"],
        ].map(([label, tier]) => `| ${label} | ${models.roles.filter((r) => r.tier === tier).map((r) => code(r.role)).join(", ")} |`),
    },
    {
      file: `${PLUGIN}/hooks/session-start-copilot.md`,
      name: "role-model skill list",
      locate: lineStartingWith(ROLE_SKILLS_LINE),
      render: () => [`${ROLE_SKILLS_LINE} ${roleSkills(models).map(code).join(", ")}.`],
    },
  ];
}

const PREAMBLE_RUNTIMES = RUNTIMES.filter((runtime) => runtime.preamble);
const DRIVER_LINE = "Resolve the driver skill through [poteto-mode's Non-negotiables](../SKILL.md#non-negotiables).";
const DRIVER_PLAYBOOKS = ["autopilot-full", "multi-phase-plan", "orchestrate", "refactoring", "shipping"];
const LEAD_LINES = [...PREAMBLE_RUNTIMES.map((runtime) => runtime.preamble), DRIVER_LINE];

// The skills with a row in a runtime mapping's Per-skill notes table, in row order.
export function noteSkills(runtime, markdown) {
  const lines = markdown.split("\n");
  const range = tableRows(runtime.notesHeader, "| ")(lines);
  if (!range) throw new Error(`${runtime.tools}: "${runtime.notesHeader}" table header not found`);
  return lines.slice(...range).map((row) => {
    const skill = row.match(/^\| `([a-z0-9-]+)` \|/)?.[1];
    if (!skill) throw new Error(`${runtime.tools}: Per-skill notes row does not start with a backticked skill: ${row}`);
    return skill;
  });
}

// The lines the generator owns under a file's first heading, in order, by
// repo-relative file: a runtime's preamble on each skill its Per-skill notes
// table has a row for, in RUNTIMES order, and the driver-skill line on the
// playbooks that drive an app. Every runtime's table must name real skills,
// whether or not it stamps a preamble.
export function loadLeadLines(root = repo) {
  const leads = new Map();
  for (const runtime of RUNTIMES) {
    for (const skill of noteSkills(runtime, readFileSync(join(root, runtime.tools), "utf8"))) {
      const file = `${SKILLS}/${skill}/SKILL.md`;
      if (!existsSync(join(root, file))) throw new Error(`${runtime.tools}: per-skill note for "${skill}", which has no SKILL.md`);
      if (runtime.preamble) leads.set(file, [...(leads.get(file) ?? []), runtime.preamble]);
    }
  }
  for (const playbook of DRIVER_PLAYBOOKS) leads.set(`${SKILLS}/poteto-mode/playbooks/${playbook}.md`, [DRIVER_LINE]);
  return leads;
}

// Put each lead line in its own paragraph under the first heading after the
// frontmatter, in order, keeping one already there. Null when there is no
// heading.
export function stampLeadLine(text, lead) {
  const lines = text.split("\n");
  const bodyStart = lines[0] === "---" ? lines.indexOf("---", 1) + 1 : 0;
  const heading = lines.findIndex((l, i) => i >= bodyStart && /^#{1,6} /.test(l));
  if (heading === -1) return null;
  let at = heading + 1;
  for (const line of [lead].flat()) {
    if (!(lines[at] === "" && lines[at + 1] === line)) lines.splice(at, 0, "", line);
    at += 2;
  }
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
  const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  for (const key of ["available", "efforts", "roles"]) if (!Array.isArray(raw[key])) fail(`"${key}" must be a list`);
  for (const key of ["tiers", ...RUNTIMES.filter((runtime) => runtime.key).map((runtime) => runtime.key)]) {
    if (!isObject(raw[key])) fail(`"${key}" must be an object`);
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
  for (const runtime of RUNTIMES) runtime.checkModels?.(raw[runtime.key], { raw, fail, unique, isObject });
  return resolveModels(raw);
}

export function loadModels(root = repo) {
  const skillsDir = join(root, SKILLS);
  return parseModels(JSON.parse(readFileSync(join(root, PLUGIN, "models.json"), "utf8")), (skill) =>
    existsSync(join(skillsDir, skill, "SKILL.md")),
  );
}

// Frontmatter keys only Cursor reads. The port drops each with any indented
// continuation lines and blank paragraphs.
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
    dropping = CURSOR_ONLY_KEYS.test(line) || (dropping && /^(?:\s|$)/.test(line));
    if (!dropping) kept.push(line.startsWith("name:") ? `name: ${name}` : line);
  }
  const head = kept.join("\n");
  if (!skill) return head + body;
  const swap = skill.startsWith("principle-") ? "\nuser-invocable: false\n" : "\n";
  return head.replace("\ndisable-model-invocation: true\n", swap) + body;
}

// The port's derivation of an upstream file, as tools/sync.mjs applies it
// before comparing with the local copy: the port's frontmatter, then the
// generator's own stamps, its lead lines first. A Models section is appended as the last H2 when
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
// base agent reads as the routing target for /poteto-mode. A description is
// written unquoted, so it must not open with a backtick: strict YAML rejects it.
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
        `---\nname: poteto-agent-${level}\ndescription: Runs \`pstack:poteto-agent\` at ${level} reasoning effort. ` +
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

// Claude Code's loader tolerates frontmatter that strict YAML rejects, so an
// agent file can load locally and still be unreadable to another parser.
export function validateAgentFrontmatter(pluginRoot) {
  const failures = pluginAgentPaths(pluginRoot).flatMap((path) => {
    try {
      const { data } = parseFrontmatter(readFileSync(join(pluginRoot, path), "utf8"));
      return data?.name && data?.description ? [] : [`${path}: frontmatter needs a name and a description`];
    } catch (err) {
      return [`${path}: ${err.message}`];
    }
  });
  if (failures.length) throw new Error(`agent frontmatter is not readable YAML:\n${failures.join("\n")}`);
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

// The hook handler shapes Claude Code documents, one schema per `type`
// (https://code.claude.com/docs/en/hooks, "Hook handler fields"), plus Codex's
// commandWindows on a command hook. A key no type lists is a fault, so a
// misspelt override cannot be dropped without notice.
const HOOK_FIELDS = {
  if: Type.Optional(Type.String()),
  timeout: Type.Optional(Type.Number()),
  statusMessage: Type.Optional(Type.String()),
  once: Type.Optional(Type.Boolean()),
};
const hookType = (type, fields) =>
  Type.Object({ type: Type.Literal(type), ...fields, ...HOOK_FIELDS }, { additionalProperties: false });
const HOOK_TYPES = {
  command: hookType("command", {
    command: Type.String(),
    commandWindows: Type.Optional(Type.String()),
    args: Type.Optional(Type.Array(Type.String())),
    async: Type.Optional(Type.Boolean()),
    asyncRewake: Type.Optional(Type.Boolean()),
    shell: Type.Optional(Type.Union([Type.Literal("bash"), Type.Literal("powershell")])),
  }),
  http: hookType("http", {
    url: Type.String(),
    headers: Type.Optional(Type.Record(Type.String(), Type.String())),
    allowedEnvVars: Type.Optional(Type.Array(Type.String())),
  }),
  mcp_tool: hookType("mcp_tool", {
    server: Type.String(),
    tool: Type.String(),
    input: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  }),
  prompt: hookType("prompt", { prompt: Type.String(), model: Type.Optional(Type.String()) }),
  agent: hookType("agent", { prompt: Type.String(), model: Type.Optional(Type.String()) }),
};
const MATCHER_GROUP = Type.Object(
  { matcher: Type.Optional(Type.String()), hooks: Type.Array(Type.Object({ type: Type.String() })) },
  { additionalProperties: false },
);
const HOOKS_FILE = Type.Object({ hooks: Type.Record(Type.String(), Type.Array(MATCHER_GROUP)) });

// typebox reports an unknown key twice, as a false schema at the key and as
// additionalProperties on its object; the second names every such key.
function shapeFaults(schema, value, subject) {
  return [...Value.Errors(schema, value)]
    .filter((error) => error.keyword !== "boolean")
    .map((error) =>
      error.keyword === "additionalProperties"
        ? `unknown key ${error.params.additionalProperties.join(", ")}`
        : `${error.instancePath.slice(1).replaceAll("/", ".") || subject} ${error.message}`,
    );
}

// A hooks file must have the documented shape, every ${<root>}/<path> a
// command hook names must exist in the plugin, and one the command executes
// directly must be executable, or the SessionStart hook fails silently for
// every user.
// The root is the variable the runtime exports with the plugin's directory.
export function validateHooks(hooksJson, { statOf, file = "hooks/hooks.json", root = "CLAUDE_PLUGIN_ROOT" }) {
  const raw = JSON.parse(hooksJson);
  const faults = shapeFaults(HOOKS_FILE, raw, "file");
  if (faults.length) throw new Error(`${file}:\n  ${faults.join("\n  ")}`);
  for (const [event, groups] of Object.entries(raw.hooks)) {
    for (const hook of groups.flatMap((group) => group.hooks)) {
      const schema = Object.hasOwn(HOOK_TYPES, hook.type) ? HOOK_TYPES[hook.type] : undefined;
      if (!schema) {
        faults.push(`${event}: hook type "${hook.type}" is not one of ${Object.keys(HOOK_TYPES).join(", ")}`);
        continue;
      }
      const shape = shapeFaults(schema, hook, "hook");
      if (shape.length) {
        faults.push(...shape.map((fault) => `${event}: ${fault}`));
        continue;
      }
      if (hook.type !== "command") continue;
      for (const command of [hook.command, hook.commandWindows].filter((value) => value !== undefined)) {
        const refs = [...command.matchAll(new RegExp(`\\$\\{${root}\\}/([^"\\s]+)`, "g"))].map((m) => m[1]);
        if (!refs.length) {
          faults.push(`${event}: command does not reference \${${root}}: ${command}`);
          continue;
        }
        const executed = command.replace(/^"/, "").startsWith(`\${${root}}/`);
        refs.forEach((rel, i) => {
          const st = statOf(rel);
          if (!st) faults.push(`${event}: ${rel} does not exist`);
          else if (i === 0 && executed && !(st.mode & 0o111)) faults.push(`${event}: ${rel} is not executable`);
        });
      }
    }
  }
  if (faults.length) throw new Error(`${file}:\n  ${faults.join("\n  ")}`);
}

// Every file the generator writes, as exact text by repo-relative path,
// computed from the sources under `root` without writing. Any other entry in
// an owned directory is an orphan. Throws when a source cannot be planned.
// Without `models`, plan loads the model policy from `root` itself.
export function plan(root, models) {
  const read = (rel) => readFileSync(join(root, rel), "utf8");
  const version = read("VERSION").trim();
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`VERSION must be MAJOR.MINOR.PATCH, got "${version}"`);
  assertChangesHeading(read("CHANGES.md"), version);
  models ??= loadModels(root);

  // A stamp edits the text planned so far for its path, so producers on one
  // path compose. A put writes a whole file, so it throws rather than replace
  // different text another producer planned.
  const files = {};
  const current = (rel) => files[rel] ?? read(rel);
  const stamp = (rel, edit) => {
    files[rel] = edit(current(rel));
  };
  const put = (rel, text) => {
    if (Object.hasOwn(files, rel) && files[rel] !== text) throw new Error(`${rel} is planned twice with different text`);
    files[rel] = text;
  };
  for (const file of VERSIONED_MANIFESTS) stamp(file, (text) => stampVersion(text, version, file));
  for (const file of new Set(regions(models).map((r) => r.file))) stamp(file, (text) => applyRegions(file, text, models));
  const leads = loadLeadLines(root);
  for (const [file, line] of leads) {
    stamp(file, (text) => {
      const stamped = stampLeadLine(text, line);
      if (stamped === null) throw new Error(`${file}: no heading to stamp its lead line under`);
      return stamped;
    });
  }
  for (const runtime of PROMPT_RUNTIMES) {
    for (const skill of slashCommands(read(COMMANDS_DOC), publicSkills(join(root, SKILLS)))) {
      const preamble = (leads.get(`${SKILLS}/${skill.name}/SKILL.md`) ?? []).includes(runtime.preamble);
      put(`${runtime.prompts}/${skill.name}.md`, promptStub(skill, runtime, { preamble }));
    }
  }
  const agents = effortAgents(models.efforts, read(`${PLUGIN}/agents/poteto-agent.md`));
  for (const agent of agents) put(`${EFFORT_AGENTS}/${agent.name}.md`, agent.text);
  stamp(`${PLUGIN}/.claude-plugin/plugin.json`, (text) =>
    stampAgentPaths(text, [
      ...pluginAgentPaths(join(root, PLUGIN)).filter((path) => path.startsWith("./agents/")),
      ...agents.map((agent) => `./effort-agents/${agent.name}.md`).sort(),
    ]),
  );
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
    put(path, read(source));
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
// they see the stale copies. Without `models`, the policy load is one of the checks.
export function problems(root, models) {
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
  const read = (rel) => readFileSync(join(root, rel), "utf8");
  const pathExists = (rel) => existsSync(join(root, rel));
  const packages = RUNTIMES.map((runtime) =>
    attempt(() => {
      const text = read(runtime.manifest);
      let manifest;
      try {
        manifest = JSON.parse(text);
      } catch (err) {
        throw new Error(`${runtime.manifest}: ${err.message}`);
      }
      if (typeof manifest !== "object" || !manifest) throw new Error(`${runtime.manifest}: not a JSON object`);
      return { runtime, manifest, text };
    }),
  ).filter(Boolean);
  models ??= attempt(() => loadModels(root));
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
          LEAD_LINES.includes(line) && !(leads.get(file) ?? []).includes(line) ? [`${file}:${i + 1}`] : [],
        );
    });
    if (strays.length) {
      throw new Error(
        "generator-owned lead lines outside their files (a runtime preamble needs a row in the Per-skill notes " +
          `table of ${PREAMBLE_RUNTIMES.map((r) => r.tools).join(" or ")}; the driver-skill line belongs to DRIVER_PLAYBOOKS):\n` +
          strays.join("\n"),
      );
    }
  });
  attempt(() => validateSkillsTree(skillsDir));
  attempt(() => validateProsePaths(skillsDir));
  for (const packaged of packages) attempt(() => packaged.runtime.validate({ ...packaged, read, pathExists }));
  attempt(() => validatePluginLayout(pluginRoot));
  attempt(() => validateAgentFrontmatter(pluginRoot));
  const hooksFiles = [
    { file: "hooks/hooks.json" },
    ...packages.flatMap(({ runtime, manifest }) =>
      (runtime.hooks?.(manifest) ?? []).map((file) => ({ file, root: runtime.pluginRootVar })),
    ),
  ];
  for (const { file, root } of hooksFiles) {
    attempt(() => validateHooks(readFileSync(join(pluginRoot, file), "utf8"), { statOf, file, root }));
  }
  return failures;
}

function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--check")) throw new Error("usage: bun tools/generate.mjs [--check]");
  const check = args.includes("--check");
  const models = loadModels(repo);
  const intended = plan(repo, models);
  const failures = [];
  let pending;
  try {
    pending = check ? changes(repo, intended) : apply(repo, intended);
  } catch (err) {
    failures.push(err.message);
  }
  failures.push(...problems(repo, models));
  if (check && pending?.length) {
    failures.push(
      "generated output is stale; run bun tools/generate.mjs:\n" +
        pending.map(({ kind, path }) => `  ${kind}: ${path}`).join("\n"),
    );
  }
  if (pending?.length === 0) console.log(`ok: ${Object.keys(intended.files).length} generated files current`);
  for (const failure of failures) console.error(`FAIL: ${failure}`);
  if (failures.length) process.exit(1);
  console.log("ok: skill links, prose paths, model slugs, runtime packaging, plugin layout, agent frontmatter, and hooks pass their checks");
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
