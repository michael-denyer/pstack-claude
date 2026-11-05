// The runtimes other than Claude Code that pstack ships to: the table the
// generator iterates, with each runtime's Model names renderer, models.json
// check, versioned manifest, packaging validator, and hooks files.

import { isDeepStrictEqual } from "node:util";
import { code, codeList, PLUGIN, SKILLS } from "./plugin.mjs";

// Every runtime other than Claude Code that reads the skills through a mapping
// file under poteto-mode/references/. A row gives the runtime the generated
// Model names section in its mapping file, and a row with a `key` its
// models.json block, checked by `checkModels`. A `skillPreambles` runtime also gets a preamble under
// the first heading of each skill its Per-skill notes table lists. Pi has
// none: its one pointer is hand-written in poteto-mode's Platform
// Adaptation section. `manifest` is the file the generator stamps VERSION
// into, `validate` checks the runtime's packaging against the tree once that
// manifest parses, and `hooks` lists the hooks files the manifest names,
// relative to the plugin root. GitHub Copilot stamps preambles but has no
// models.json block, since it ships no default models.
// Muse declares its hooks inline in its native manifest, so it has no hooks
// file either. Its `stampManifest` rewrites the manifest's skill list from the tree.
// MiniMax Code reads the Claude Code build as it ships, so its row names the
// Claude Code manifest and stamps no preambles; its one pointer is in
// poteto-mode's Platform Adaptation section, as Pi's is.
// Antigravity keys its hooks by group name instead of the shared hooks schema.
export const RUNTIMES = [
  {
    name: "Codex",
    key: "codex",
    mapping: "codex-tools.md",
    modelNames: codexModelNamesSection,
    checkModels: tierExamples("codex"),
    skillPreambles: true,
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
  {
    name: "MiniMax Code",
    mapping: "minimax-tools.md",
    modelNames: minimaxModelNamesSection,
    // MiniMax Code's Claude Code reader loads this manifest with the skills,
    // agents, and hooks/hooks.json beside it, so the build has no manifest or
    // hooks file of its own.
    manifest: `${PLUGIN}/.claude-plugin/plugin.json`,
    validate: validateMiniMaxPackage,
  },
  {
    name: "OpenCode 2",
    mapping: "opencode-tools.md",
    modelNames: openCodeModelNamesSection,
    manifest: "package.json",
    validate: ({ manifest, pathExists }) => validateOpenCodePackage(manifest, { pathExists }),
  },
  {
    name: "Kimi Code CLI",
    mapping: "kimi-tools.md",
    modelNames: kimiModelNamesSection,
    manifest: "kimi.plugin.json",
    validate: ({ manifest, pathExists }) => validateKimiManifest(manifest, { pathExists }),
  },
  {
    name: "Antigravity",
    mapping: "agy-tools.md",
    modelNames: agyModelNamesSection,
    skillPreambles: true,
    manifest: `${PLUGIN}/.antigravity-plugin/plugin.json`,
    validate: ({ manifest, read, statOf, checkExecutable }) =>
      validateAgyManifest(manifest, { claude: JSON.parse(read(`${PLUGIN}/.claude-plugin/plugin.json`)), read, statOf, checkExecutable }),
  },
  {
    name: "OMP",
    mapping: "omp-tools.md",
    modelNames: ompModelNamesSection,
    manifest: `${PLUGIN}/package.json`,
    validate: ({ manifest, read, pathExists }) =>
      validateOmpPackage(manifest, { marketplace: JSON.parse(read(".claude-plugin/marketplace.json")), pathExists }),
  },
  {
    name: "Grok Build",
    mapping: "grok.md",
    modelNames: grokModelNamesSection,
    manifest: `${PLUGIN}/.grok-plugin/plugin.json`,
    validate: ({ manifest, pathExists, agentSkills }) => validateGrokPlugin(manifest, { pathExists, agentSkills }),
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
// id duplicates a skill id. The SessionStart hooks are rewritten from
// MUSE_HOOKS.
export function stampMuseManifest(text, { skills }) {
  const manifest = JSON.parse(text);
  manifest.capabilities = {
    ...manifest.capabilities,
    skills: skills.map((name) => ({ id: name, path: `skills/${name}/SKILL.md`, enabledDefault: true })),
    hooks: MUSE_HOOKS.map(({ id, command }) => ({
      id,
      event: "SessionStart",
      command,
      timeoutMs: 5000,
      statusMessage: SESSION_START_STATUS,
    })),
  };
  return JSON.stringify(manifest, null, 2) + "\n";
}

// The SessionStart hook's statusMessage. Codex titles the hook with it in
// its review list, and every runtime that reads it shows it while the hook
// runs, so users can tell the hook is pstack's.
export const SESSION_START_STATUS = "Loading pstack routing";

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
  for (const { id, script } of MUSE_HOOKS) {
    if (!pathExists(`${PLUGIN}/${script}`)) throw new Error(`${at}: SessionStart hook "${id}" runs ${script}, which is not in the plugin`);
  }
  // The PowerShell hook reads the roles from models.json at runtime, where
  // sheet.awk has them stamped in.
  if (!pathExists(`${PLUGIN}/models.json`)) throw new Error(`${at}: hooks/session-start.ps1 reads models.json, which is not in the plugin`);
}

// The manifests MiniMax Code 0.7.4 looks for in a plugin directory, in the
// order its loader tries them. It reads the plugin through the reader for the
// first one present.
export const MINIMAX_MANIFESTS = ["plugin.json", ".minimax-plugin/plugin.json", ".claude-plugin/plugin.json", ".codex-plugin/plugin.json"];

// pstack runs on MiniMax Code through its Claude Code reader, the one that
// loads the plugin agents and hooks/hooks.json. A manifest earlier in the
// order would switch MiniMax Code to another reader.
export function validateMiniMaxPackage({ pathExists }) {
  const first = MINIMAX_MANIFESTS.find((file) => pathExists(`${PLUGIN}/${file}`));
  if (first !== ".claude-plugin/plugin.json") {
    throw new Error(
      `${PLUGIN}/${first}: MiniMax Code reads this manifest instead of .claude-plugin/plugin.json, ` +
        "so it would stop loading pstack through its Claude Code reader",
    );
  }
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

const panelSkills = (models) => codeList([...new Set(models.roles.filter((r) => r.tier === "panel").map((r) => r.skill))]);

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
    `- Diverse-model panels (${panelSkills(models)}): the adversarial ` +
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
    `parent's current model. Diverse-model panels (${panelSkills(models)}) ` +
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
    `- Diverse-model panels (${panelSkills(models)}): the adversarial ` +
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

// MiniMax Code ships no default slugs either: its models come from whichever
// providers the user connected, and every one is named <provider>/<model>.
export function minimaxModelNamesSection(models) {
  return (
    "Skills name Claude Code model aliases in their Models sections. Those aliases are not MiniMax Code model keys. " +
    "MiniMax Code names a model `<provider>/<model>`, and the models a session can reach depend on the providers the " +
    "user connected: MiniMax itself, OpenAI through its Codex sign-in, or a provider added with `mcode provider add`. " +
    "So the MiniMax Code build ships no default models, and the user picks them once.\n\n" +
    "- The model sheet is `~/.minimax/pstack-models.md`. Before a skill that needs a role model " +
    `(${roleSkills(models).map(code).join(", ")}), read it. With no sheet, load \`setup-pstack\` with the \`skill\` ` +
    "tool and finish it first.\n" +
    "- A role line in the sheet is the user's explicit model instruction, so pass it as the `task` tool's `model`. " +
    "Pass the role's `@level`, or the sheet's `default effort`, as `effort`. The `task` tool fails a model other than " +
    "the parent's that offers effort levels when `effort` is missing or names a level the model does not offer, " +
    "such as `high` on MiniMax M3, which offers only `on` and `off`. When the level is not one the model offers, " +
    "ask the user which to use. `inherit-parent` or `auto` omits `model` and `effort`.\n" +
    `- Roles that default to the worker model (${tierRoles(models, "worker")}): the worker model the user chose.\n` +
    `- Roles that default to the strongest model (${tierRoles(models, "strongest")}): ` +
    "the strongest model the user chose.\n" +
    `- Diverse-model panels (${panelSkills(models)}): the adversarial ` +
    "signal comes from model diversity, so fill a panel from distinct providers. If only one model family is " +
    "reachable, vary reasoning effort and note in the verdict that diversity was reduced.\n\n" +
    "`/setup-pstack` writes the configured model list. On MiniMax Code, list the models with `mcode provider list` " +
    "or the `model` slash command and write only keys they show."
  );
}

export function validateOpenCodePackage(manifest, { pathExists }) {
  const entry = "./plugins/pstack/opencode/index.js";
  if (manifest.exports?.["./server"] !== entry) throw new Error(`package.json: exports["./server"] must be ${entry}`);
  if (!pathExists(entry.slice(2))) throw new Error(`package.json: ${entry} does not exist`);
}

export function openCodeModelNamesSection(models) {
  return (
    "Claude Code model aliases are not OpenCode model IDs. Select a configured chat model only when the user explicitly " +
    "asks for a model or variant; otherwise let the subagent inherit its model. OpenCode accepts " +
    "`providerID/modelID` or `providerID/modelID#variant` in the `subagent` tool's `model` field. " +
    "Look up the ID and variant with the `models` tool; do not guess.\n\n" +
    "- The model sheet is `${XDG_CONFIG_HOME:-~/.config}/opencode/pstack-models.md`. Add that path to the " +
    "OpenCode configuration's `instructions` array to load role choices; the plugin reads the `session hook` setting directly.\n" +
    `- For role-model skills (${roleSkills(models).map(code).join(", ")}), treat a saved user choice as an explicit ` +
    "instruction only when it identifies a configured model. The `subagent` input has no separate effort field; " +
    "use a listed `#variant` when requested. Omit `model` for `inherit-parent` or `auto`.\n" +
    "- For diverse-model panels, use different available providers only when the user requests those models. " +
    "Otherwise inherit and state that model diversity was not established.\n\n" +
    "Use the `models` command to inspect configured models before writing the sheet."
  );
}

const agyScript = "hooks/session-start.sh";
const agyCommand = `./${agyScript} agy`;
export const AGY_HOOKS = {
  "pstack-routing": { SessionStart: [{ type: "command", command: agyCommand }] },
};

export function validateAgyManifest(manifest, { claude, read, statOf, checkExecutable = true }) {
  const at = `${PLUGIN}/.antigravity-plugin/plugin.json`;
  if (manifest.name !== claude.name) throw new Error(`${at}: name "${manifest.name}" != Claude Code manifest name "${claude.name}"`);
  if (manifest.logo && !statOf(manifest.logo)?.isFile()) throw new Error(`${at}: ${manifest.logo} is not a file in the plugin`);
  const hooksFile = `${PLUGIN}/hooks.json`;
  if (!isDeepStrictEqual(JSON.parse(read(hooksFile)), AGY_HOOKS)) {
    throw new Error(`${hooksFile}: expected pstack-routing.SessionStart to run ${agyCommand}`);
  }
  const script = statOf(agyScript);
  if (!script?.isFile()) throw new Error(`${hooksFile}: ${agyScript} is not a file in the plugin`);
  if (checkExecutable && !(script.mode & 0o111)) throw new Error(`${hooksFile}: ${agyScript} is not executable`);
}

export function agyModelNamesSection(models) {
  return (
    "Skills name Claude Code model aliases in their Models sections. On Antigravity (`agy`), `invoke_subagent`'s " +
    "`Model` parameter accepts `inherit` (default, uses the parent's model), `flash_lite`, `flash`, and `pro`.\n\n" +
    "- The model sheet is `~/.gemini/config/pstack-models.md`. Before a skill that needs a role model " +
    `(${roleSkills(models).map(code).join(", ")}), read it. With no sheet, read \`setup-pstack\`'s \`SKILL.md\` ` +
    "and finish it first.\n" +
    "- Pass the role's model as `Model` on `invoke_subagent`. For `inherit-parent` or `auto`, omit `Model`.\n" +
    `- Roles that default to the worker model (${tierRoles(models, "worker")}): the worker model the user chose.\n` +
    `- Roles that default to the strongest model (${tierRoles(models, "strongest")}): the strongest model the user chose.\n` +
    `- Diverse-model panels (${panelSkills(models)}): the adversarial ` +
    "signal comes from model diversity. Use distinct available models and report when the panel shares a model family.\n\n" +
    "`/setup-pstack` writes the sheet. Antigravity accepts `flash_lite`; the Copilot sheet checker rejects underscores " +
    "in model IDs and does not apply to Antigravity."
  );
}

export function validateOmpPackage(manifest, { marketplace, pathExists }) {
  const entry = marketplace.plugins?.find((plugin) => plugin.name === "pstack");
  if (manifest.name !== "pstack" || entry?.source !== "./plugins/pstack" || entry.version !== manifest.version) {
    throw new Error("OMP package must match the pstack marketplace entry and version");
  }
  if (!isDeepStrictEqual(manifest.omp?.extensions, ["./omp/index.mjs"])) {
    throw new Error("OMP package must load ./omp/index.mjs");
  }
  for (const path of ["omp/index.mjs", "skills/poteto-mode/SKILL.md", "hooks/session-start-context.md"]) {
    if (!pathExists(`${PLUGIN}/${path}`)) throw new Error(`OMP package missing ${path}`);
  }
}

export function ompModelNamesSection() {
  return (
    "OMP uses its own model selection; without a pstack sheet, use the runtime's defaults. " +
    "The global `~/.omp/pstack-models.md` is shared across OMP profiles; `session hook: off` there disables " +
    "main-session routing while retaining the subagent mapping. Configure models only when the user asks. " +
    "List available chat models with `omp models --kind chat` and inspect the active OMP configuration with " +
    "`omp config`. Ask which available models the user wants for routine, worker and demanding roles. Configure " +
    "OMP's own `modelRoles` and `task.agentModelOverrides` through its configuration interface, preserving unrelated " +
    "settings. Use only models listed by the active installation; do not copy Claude model aliases into OMP. " +
    "If the available agent roster cannot select distinct models for a requested panel, report that limitation."
  );
}

export function validateKimiManifest(manifest, { pathExists }) {
  if (manifest.name !== "pstack") throw new Error("kimi.plugin.json: expected pstack name");
  if (manifest.skills !== "./plugins/pstack/skills" || !pathExists("plugins/pstack/skills/poteto-mode/SKILL.md")) {
    throw new Error("kimi.plugin.json: skills must point to the packaged skill tree");
  }
  if (manifest.systemPromptPath !== "./plugins/pstack/hooks/kimi-instructions.md" || !pathExists("plugins/pstack/hooks/kimi-instructions.md")) {
    throw new Error("kimi.plugin.json: systemPromptPath must point to the packaged instructions");
  }
}

export function kimiModelNamesSection(models) {
  return "Skills name Claude model aliases; do not assume they are available on Kimi. Use only models advertised by the current `Agent` tool; " +
    "if it has no `model` parameter, omit `model`. Omitting it uses the configured subagent default when present, otherwise the parent's model. " +
    "Kimi does not expose a per-call effort parameter.\n\n" +
    "Read `<KIMI_CODE_HOME>/pstack-models.md` before a skill that needs a role model (" + roleSkills(models).map(code).join(", ") + "). " +
    "KIMI_CODE_HOME defaults to `~/.kimi-code`. If the sheet is absent, omit `model`. " +
    "For diverse-model panels, use available distinct models and report if diversity is unavailable. " +
    "`setup-pstack` writes the model choices; `inherit-parent` and `auto` both omit `model`.";
}

// Grok discovers the common skills and the Grok-only routing skill through
// its native manifest. Validate both paths and the routing skill's metadata.
export function validateGrokPlugin(manifest, { pathExists, agentSkills }) {
  if (manifest.name !== "pstack" || !isDeepStrictEqual(manifest.skills, ["./skills", "./grok/skills"])) {
    throw new Error("Grok manifest must name pstack and list both skill directories");
  }
  for (const path of ["skills/poteto-mode/SKILL.md", "grok/skills/pstack-routing/SKILL.md"]) {
    if (!pathExists(`${PLUGIN}/${path}`)) throw new Error(`Grok plugin missing ${path}`);
  }
  agentSkills(`${PLUGIN}/grok/skills`);
}

export function grokModelNamesSection(models) {
  return (
    "Skills name Claude Code model aliases in their Models sections. Grok Build's available models depend on " +
    "the user's configuration; do not pass a Claude alias as a Grok model.\n\n" +
    "- The model sheet is `${GROK_HOME:-~/.grok}/pstack-models.md`. Before a skill that needs a role model " +
    `(${roleSkills(models).map(code).join(", ")}), read it. With no sheet, use the runtime default; run \`setup-pstack\` only when the user asks to configure roles.\n` +
    "- The `spawn_subagent` tool says to omit `model` unless the user explicitly requests one. It has no effort parameter; " +
    "when it cannot apply a sheet choice, report that limitation instead of claiming model diversity.\n" +
    `- Roles that default to the worker model (${tierRoles(models, "worker")}): the worker model the user chose.\n` +
    `- Roles that default to the strongest model (${tierRoles(models, "strongest")}): the strongest model the user chose.\n` +
    `- Diverse-model panels (${panelSkills(models)}) require distinct models. ` +
    "Report when the available dispatch cannot provide that diversity.\n\n" +
    "`/setup-pstack` writes the sheet. Choose only models the session exposes."
  );
}
