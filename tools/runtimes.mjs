// The runtimes other than Claude Code that pstack ships to: the table the
// generator iterates, with each runtime's Model names renderer, models.json
// check, versioned manifest, packaging validator, and hooks files.

import { code, codeList, PLUGIN, SKILLS } from "./plugin.mjs";

// Every runtime other than Claude Code that reads the skills through a mapping
// file under poteto-mode/references/. A row gives the runtime the generated
// Model names section in its mapping file, and a row with a `key` its
// models.json block, checked by `checkModels`. A `skillPreambles` runtime also gets a preamble under
// the first heading of each skill its Per-skill notes table lists, and a
// runtime with a `prompts` directory a slash stub per public skill there. Pi
// has neither: its one pointer is hand-written in poteto-mode's Platform
// Adaptation section. `manifest` is the file the generator stamps VERSION
// into, `validate` checks the runtime's packaging against the tree once that
// manifest parses, and `hooks` lists the hooks files the manifest names,
// relative to the plugin root. GitHub Copilot stamps preambles but has no
// prompts directory, since its CLI and app list plugin skills as slash commands
// themselves, and no models.json block, since it ships no default models.
// Muse declares its hooks inline in its native manifest, so it has no hooks
// file either, and no prompts directory, since Muse lists each user-invocable
// skill as a slash command itself and rejects a command whose id duplicates a
// skill id. Its `stampManifest` rewrites the manifest's skill list from the tree.
export const RUNTIMES = [
  {
    name: "Codex",
    key: "codex",
    mapping: "codex-tools.md",
    modelNames: codexModelNamesSection,
    checkModels: tierExamples("codex"),
    skillPreambles: true,
    prompts: `${PLUGIN}/.codex-plugin/prompts`,
    manifest: `${PLUGIN}/.codex-plugin/plugin.json`,
    validate: ({ manifest, read, pathExists }) =>
      validateCodexMarketplace(read(".agents/plugins/marketplace.json"), { expectedName: manifest.name, pathExists }),
    hooks: (manifest) => [manifest.hooks],
  },
  {
    name: "Pi",
    key: "pi",
    mapping: "pi-tools.md",
    modelNames: piModelNamesSection,
    checkModels: checkPiModels,
    manifest: "package.json",
    validate: ({ text, pathExists }) => validatePiPackage(text, { pathExists }),
  },
  {
    name: "GitHub Copilot",
    mapping: "copilot-tools.md",
    modelNames: copilotModelNamesSection,
    skillPreambles: true,
    // Copilot reads .github/plugin/plugin.json before .claude-plugin/plugin.json,
    // so it gets its own hooks file and never runs the Claude Code hooks.
    manifest: `${PLUGIN}/.github/plugin/plugin.json`,
    validate: ({ manifest, read, pathExists }) =>
      validateCopilotManifest(manifest, { claude: JSON.parse(read(`${PLUGIN}/.claude-plugin/plugin.json`)), pathExists }),
    hooks: (manifest) => [manifest.hooks],
    pluginRootVar: "COPILOT_PLUGIN_ROOT",
  },
  {
    name: "Muse",
    key: "muse",
    mapping: "muse-tools.md",
    modelNames: museModelNamesSection,
    checkModels: tierExamples("muse"),
    skillPreambles: true,
    manifest: `${PLUGIN}/.muse-plugin/plugin.json`,
    validate: ({ manifest, read, pathExists }) =>
      validateMuseManifest(manifest, { claude: JSON.parse(read(`${PLUGIN}/.claude-plugin/plugin.json`)), pathExists }),
    stampManifest: stampMuseManifest,
  },
].map((runtime) => ({
  ...runtime,
  tools: `${SKILLS}/poteto-mode/references/${runtime.mapping}`,
  notesHeader: `| Skill | On ${runtime.name} |`,
  preamble: runtime.skillPreambles
    ? `On ${runtime.name}, read the [platform mapping](../poteto-mode/references/${runtime.mapping}), ` +
      "including its per-skill notes, before following this skill."
    : null,
}));

// Codex and Muse have no Claude aliases, so each block gives a model per tier.
// A declaration, so the RUNTIMES rows above can call it at module load.
function tierExamples(label) {
  return (block, { raw, fail, unique }) => {
    for (const tier of Object.keys(raw.tiers)) {
      if (!Object.hasOwn(block, tier)) fail(`${label} has no example for tier "${tier}"`);
    }
    for (const [tier, value] of Object.entries(block)) {
      if (!Object.hasOwn(raw.tiers, tier)) fail(`${label} names "${tier}", which is not a tier`);
      unique([value].flat(), `${label} "${tier}"`);
    }
  };
}

// The Muse manifest's skill list, rewritten from the tree the generator
// planned: one skill capability per skill directory, each pointing at its
// SKILL.md in the package. Commands stay empty: Muse surfaces each
// user-invocable skill as a slash command itself and rejects a command whose
// id duplicates a skill id.
export function stampMuseManifest(text, { skills }) {
  const manifest = JSON.parse(text);
  manifest.capabilities = {
    ...manifest.capabilities,
    skills: skills.map((name) => ({ id: name, path: `skills/${name}/SKILL.md`, enabledDefault: true })),
  };
  return JSON.stringify(manifest, null, 2) + "\n";
}

// Muse's native hook schema takes one command argv per hook, with no
// per-OS variant, and rejects a `commandWindows`-style field. One argv
// cannot spawn on every OS: Windows has no `sh` unless Git's usr\bin lands
// on the harness PATH, and Unix has no powershell.exe. The manifest
// therefore declares a pair, the shell script and the PowerShell script,
// and each stands down on the OS the other owns.
export const MUSE_HOOKS = [
  { id: "session-start", script: "hooks/session-start.sh", command: ["sh", "hooks/session-start.sh", "muse"] },
  {
    id: "session-start-windows",
    script: "hooks/session-start.ps1",
    command: ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "hooks/session-start.ps1", "muse"],
  },
];

// The Muse build is a native Muse plugin bundle: its manifest keeps the
// Claude Code plugin's name, and every capability path it lists exists in the
// package. The SessionStart hooks print the Muse context.
export function validateMuseManifest(manifest, { claude, pathExists }) {
  const at = `${PLUGIN}/.muse-plugin/plugin.json`;
  if (manifest.name !== claude.name) throw new Error(`${at}: name "${manifest.name}" != Claude Code manifest name "${claude.name}"`);
  if (manifest.schemaVersion !== 1) throw new Error(`${at}: schemaVersion "${manifest.schemaVersion}" is not 1`);
  if (manifest.compat?.source !== "native" || manifest.compat?.manifestDir !== ".muse-plugin") {
    throw new Error(`${at}: compat must be the native .muse-plugin manifest`);
  }
  const skillIds = new Set();
  const lists = [["skills", manifest.capabilities?.skills, true], ["commands", manifest.capabilities?.commands ?? [], false]];
  for (const [kind, entries, required] of lists) {
    if (!Array.isArray(entries) || (required && !entries.length)) throw new Error(`${at}: capabilities.${kind} is empty`);
    const ids = new Set();
    for (const entry of entries) {
      if (ids.has(entry.id)) throw new Error(`${at}: capabilities.${kind} repeats "${entry.id}"`);
      ids.add(entry.id);
      if (kind === "skills") skillIds.add(entry.id);
      if (kind === "commands" && skillIds.has(entry.id)) {
        throw new Error(`${at}: command "${entry.id}" duplicates a skill id; Muse rejects it`);
      }
      if (typeof entry.path !== "string" || !pathExists(`${PLUGIN}/${entry.path}`)) {
        throw new Error(`${at}: ${kind} "${entry.id}" path "${entry.path}" is not a file in the plugin`);
      }
    }
  }
  if (!manifest.capabilities.skills.some((entry) => entry.id === "poteto-mode")) {
    throw new Error(`${at}: capabilities.skills has no "poteto-mode"`);
  }
  const hooks = manifest.capabilities?.hooks ?? [];
  const sessionStart = hooks.filter((hook) => hook.event === "SessionStart");
  if (sessionStart.length !== MUSE_HOOKS.length) {
    throw new Error(`${at}: expected ${MUSE_HOOKS.length} SessionStart hooks, found ${sessionStart.length}`);
  }
  // The hook commands are hand-written, not stamped, so each must name
  // exactly its script inside the plugin.
  for (const { id, script, command: wanted } of MUSE_HOOKS) {
    const command = JSON.stringify(sessionStart.find((hook) => hook.id === id)?.command);
    if (command !== JSON.stringify(wanted) || !pathExists(`${PLUGIN}/${script}`)) {
      throw new Error(`${at}: SessionStart hook "${id}" command is ${command}, not ${JSON.stringify(wanted)}`);
    }
  }
  // The PowerShell hook reads the roles from models.json at runtime, where
  // sheet.awk has them stamped in.
  if (!pathExists(`${PLUGIN}/models.json`)) throw new Error(`${at}: hooks/session-start.ps1 reads models.json, which is not in the plugin`);
}

// The pstack Pi extension resolves each Claude alias a skill names through the
// table of the session's provider, or the fallback table on any other provider,
// so every table maps exactly the available aliases to that provider's models.
function checkPiModels(pi, { raw, fail, isObject }) {
  for (const key of Object.keys(pi)) {
    if (key !== "fallback" && key !== "models") fail(`pi names "${key}"; its keys are "fallback" and "models"`);
  }
  if (!isObject(pi.models)) fail('pi needs a "models" object');
  if (!Object.hasOwn(pi.models, pi.fallback)) fail(`pi.fallback "${pi.fallback}" is not a provider in pi.models`);
  for (const [provider, table] of Object.entries(pi.models)) {
    const at = `pi.models.${provider}`;
    if (!isObject(table)) fail(`${at} must be an object`);
    for (const alias of raw.available) {
      if (!Object.hasOwn(table, alias)) fail(`${at} has no Pi model for "${alias}"`);
    }
    for (const [alias, id] of Object.entries(table)) {
      if (!raw.available.includes(alias)) fail(`${at} names "${alias}", which is not in available`);
      if (typeof id !== "string" || !id.startsWith(`${provider}/`) || /\s/.test(id) || id === `${provider}/`) {
        fail(`${at} "${alias}" is "${id}", not a ${provider}/<id>`);
      }
    }
  }
}

// The roles on one tier, as a backticked list.
const tierRoles = (models, tier) =>
  models.roles
    .filter((r) => r.tier === tier)
    .map((r) => code(r.role))
    .join(", ");

// The Model names section of a runtime whose models.json block gives a model
// per tier. `panel` follows "A good default panel", `dispatch` is an optional
// paragraph before the closing line, and `ids` names what the sheet lists.
function tierModelNamesSection(models, { label, block, worker, panel, dispatch, ids }) {
  return (
    "Skills name Claude defaults (a single-role default for code/prose/judgment, a worker model for " +
    "feature and refactoring code, plus a diverse-model panel for diverse-model panels; each model-consuming skill lists its own in a " +
    `Models section). These slugs do not resolve on ${label}. Substitute your configured ${label} models:\n\n` +
    `- Single-model roles: your primary ${label} model (for example ${code(block.default)}).\n` +
    `- Roles that default to the Claude worker model (${tierRoles(models, "worker")}): ` +
    `your ${worker} (for example ${code(block.worker)}).\n` +
    `- Roles that default to the strongest Claude model (${tierRoles(models, "strongest")}): ` +
    `your strongest ${label} model (for example ${code(block.strongest)}).\n` +
    "- Diverse-model panels (`arena`, `architect`, `interrogate`, `how` critics, `reflect`): the adversarial " +
    `signal comes from model diversity, so use the distinct ${label} models available to you. A good default panel ` +
    panel(codeList(block.panel)) +
    "\n\n" +
    (dispatch ? `${dispatch}\n\n` : "") +
    `\`/setup-pstack\` writes the configured model list. On ${label}, set it to your ${ids}.`
  );
}

export function codexModelNamesSection(models) {
  return tierModelNamesSection(models, {
    label: "Codex",
    block: models.codex,
    worker: "fast Codex code model",
    panel: (list) =>
      `on ChatGPT is ${list}. If only one model family is reachable, vary reasoning ` +
      "effort and note in the verdict that diversity was reduced.",
    ids: "Codex model slugs",
  });
}

export function museModelNamesSection(models) {
  return tierModelNamesSection(models, {
    label: "Muse",
    block: models.muse,
    worker: "fast Muse model",
    panel: (list) =>
      `is ${list}. Muse serves one model family, so vary reasoning effort across the panel ` +
      "too and note in the verdict that diversity was reduced.",
    dispatch:
      "Pass a role's model where the dispatch takes one: a Workflow child's `model`, or the session model when " +
      "the dispatch has no model field. `subagent_spawn` takes an agent definition, not a model, so a role " +
      "dispatched that way runs on the session's model and effort; a Workflow child takes both (see Subagent policy). " +
      "`inherit-parent` or `auto` omits `model`.",
    ids: "Muse model IDs, as `muse model-profile` and the model catalog name them",
  });
}

export function piModelNamesSection(models) {
  const { fallback, models: tables } = models.pi;
  const columns = Object.keys(tables);
  const table =
    `| Alias | ${columns.map(code).join(" | ")} |\n| --- |${" --- |".repeat(columns.length)}\n` +
    models.available.map((alias) => `| ${code(alias)} | ${columns.map((p) => code(tables[p][alias])).join(" | ")} |`).join("\n");
  return (
    "Skills name models by the Claude aliases in their Models sections. On Pi, pass the alias as the `agent` " +
    "tool's `model`. The pstack extension resolves it in the column of the provider the session's current model " +
    `comes from, and in the ${code(fallback)} column for any other provider:\n\n` +
    table +
    "\n\nPi warns that Anthropic bills Claude used through Pi per token, as extra usage, even on a Claude subscription. " +
    "Pi shows that warning only in interactive mode, never for the `pi --mode rpc` children the `agent` tool runs.\n\n" +
    "A `pi models: opus=<provider/id>, sonnet=<provider/id>` line in the Pi override sheet points each alias " +
    "it names at another Pi model, whatever the session's provider. Add one when the session's provider has no " +
    `column above and Pi has no credentials for ${code(fallback)}, because each alias then resolves to an ${code(`${fallback}/*`)} ` +
    `ID and the ${code("agent")} call fails with ${code(`No API key found for ${fallback}`)}. ` +
    "The `agent` tool also takes a full " +
    "`provider/id`, passed through unchanged, and `inherit-parent`, `auto`, or no `model` runs the child on the " +
    "parent's current model. Diverse-model panels (`arena`, `architect`, `interrogate`, `how` critics, `reflect`) " +
    "stay diverse only while their aliases resolve to distinct models. If one model family is all you can reach, " +
    "vary the reasoning effort and note in the verdict that diversity was reduced.\n\n" +
    "`/setup-pstack` writes the configured model list. On Pi, keep the aliases and remap them with `pi models:`."
  );
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

// The Copilot manifest keeps the Claude Code plugin's name and points at a
// hooks file in the plugin. Copilot loads skills/ and agents/ by default.
export function validateCopilotManifest(manifest, { claude, pathExists }) {
  const at = `${PLUGIN}/.github/plugin/plugin.json`;
  if (manifest.name !== claude.name) throw new Error(`${at}: name "${manifest.name}" != Claude Code manifest name "${claude.name}"`);
  if (typeof manifest.hooks !== "string" || !pathExists(`${PLUGIN}/${manifest.hooks}`)) {
    throw new Error(`${at}: hooks "${manifest.hooks}" is not a file in the plugin`);
  }
}

const PI_PACKAGE = { skills: SKILLS, extensions: `${PLUGIN}/pi/index.ts` };

// `pi install` reads the repo-root package.json's `pi` key. A path there that
// does not exist loads nothing without failing the install, and an entry the
// key omits never loads, so both directions are checked here.
export function validatePiPackage(text, { pathExists }) {
  const manifest = JSON.parse(text);
  const fail = (message) => {
    throw new Error(`package.json: ${message}`);
  };
  if (!manifest.keywords?.includes("pi-package")) fail('keywords must include "pi-package"');
  if (Object.keys(manifest.dependencies ?? {}).length) fail("the Pi package has no runtime dependencies");
  for (const [key, required] of Object.entries(PI_PACKAGE)) {
    const listed = manifest.pi?.[key] ?? [];
    for (const path of listed) {
      if (!pathExists(path.replace(/^\.\//, ""))) fail(`pi.${key} names ${path}, which does not exist`);
    }
    if (!listed.includes(`./${required}`)) fail(`pi.${key} must list ./${required}`);
  }
}

// The skills that dispatch on role models, which on Copilot need a model sheet.
export const roleSkills = (models) => [...new Set(models.roles.map((r) => r.skill))].sort();

// Copilot ships no default slugs: the models a Copilot account can reach vary
// by plan and policy, so the user picks them in setup-pstack.
export function copilotModelNamesSection(models) {
  return (
    "Skills name Claude Code model aliases in their Models sections. Those aliases are not Copilot model IDs, " +
    "and the Copilot build ships no default model IDs: the models an account can reach depend on its plan " +
    "and policy, so the user picks them once.\n\n" +
    "- The model sheet is `${COPILOT_HOME:-~/.copilot}/pstack-models.md`. It sits outside the workspace, so reading it " +
    "asks for path access. The plugin's SessionStart hook reads it, checks it, and adds its role lines to the " +
    "session context as the user's saved pstack model choices. Take role models from that block and do not `view` the " +
    "sheet. A role line names the model for that role.\n" +
    "- Read the sheet only when that block and the hook's `sheet invalid` or no-sheet note are all missing, as in a " +
    "skills-only install with no hook. `view`, `create`, and `edit` take literal paths and expand neither `~` nor " +
    "`$COPILOT_HOME`, so print the sheet's absolute path with `bash` first (" +
    "`echo \"${COPILOT_HOME:-$HOME/.copilot}/pstack-models.md\"`" +
    ") and read and write exactly that path; do not append `.copilot` or any other segment to it. A session with its " +
    "own `COPILOT_HOME` then never touches `~/.copilot`.\n" +
    `- No sheet, or the hook reports \`sheet invalid\`: before a skill that needs a role model (${roleSkills(models).map(code).join(", ")}), stop, load ` +
    "`setup-pstack` with the `skill` tool, and finish it first. In that same session, use the values it just wrote; " +
    "later sessions get them from the hook. Do not ask again on later runs.\n" +
    "- A role line in the sheet is the user's explicit model instruction, so pass it as the `task` tool's " +
    "`model` parameter. `inherit-parent` or `auto` omits `model`.\n" +
    "- The plugin's `PreToolUse` hook enforces this for pstack agents. While the sheet is valid, it denies a `task` " +
    "call whose `agent_type` starts with `pstack:` and whose `model` is not one of the sheet's values, and its reason " +
    "lists the saved IDs. Retry with the role's saved model; never retry on another unsaved model. It leaves calls " +
    "with no `model` and other agent types alone.\n" +
    `- Roles that default to the worker model (${tierRoles(models, "worker")}): the worker model the user chose.\n` +
    `- Roles that default to the strongest model (${tierRoles(models, "strongest")}): ` +
    "the strongest model the user chose.\n" +
    "- Diverse-model panels (`arena`, `architect`, `interrogate`, `how` critics, `reflect`): the adversarial " +
    "signal comes from model diversity, so fill a panel from distinct vendors in the `task` tool's `model` " +
    "list (Claude, GPT, Gemini, Grok, and so on). pstack ships no default Copilot panel. If only one vendor is " +
    "reachable, vary reasoning effort and note in the verdict that diversity was reduced.\n\n" +
    "`setup-pstack` lists the models from the `model` enum of the `task` tool and writes only IDs it saw there. " +
    "After it writes the sheet, it runs its `check-sheet.sh` script, which applies the hook's checks.\n\n" +
    "Run `setup-pstack`, and the parent session that orchestrates a panel, on a model at least as strong as " +
    "gpt-5.4-mini or a Sonnet-class Claude model. On a Haiku-class model, setup picked models the user never " +
    "chose in about half of the smoke runs."
  );
}
