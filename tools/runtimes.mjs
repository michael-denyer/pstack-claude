// The runtimes other than Claude Code that pstack ships to: the table the
// generator iterates, each runtime's Model names renderer and models.json
// check, and the validators for the Codex and Pi package manifests.

export const PLUGIN = "plugins/pstack";
export const SKILLS = `${PLUGIN}/skills`;

export const code = (s) => `\`${s}\``;
export const codeList = (models) => models.map(code).join(", ");

// Every runtime other than Claude Code that reads the skills through a mapping
// file under poteto-mode/references/. A row gives the runtime its models.json
// block (`key`, checked by `checkModels`) and the generated Model names section
// in its mapping file. A `skillPreambles` runtime also gets a preamble under
// the first heading of each skill its Per-skill notes table lists, and a
// runtime with a `prompts` directory a slash stub per public skill there. Pi
// has neither: its one pointer is hand-written in poteto-mode's Platform
// Adaptation section. GitHub Copilot stamps preambles but has no prompts
// directory: its CLI and app list plugin skills as slash commands themselves.
export const RUNTIMES = [
  {
    name: "Codex",
    key: "codex",
    mapping: "codex-tools.md",
    modelNames: codexModelNamesSection,
    checkModels: checkCodexModels,
    skillPreambles: true,
    prompts: `${PLUGIN}/.codex-plugin/prompts`,
  },
  { name: "Pi", key: "pi", mapping: "pi-tools.md", modelNames: piModelNamesSection, checkModels: checkPiModels },
  {
    name: "GitHub Copilot",
    key: "copilot",
    mapping: "copilot-tools.md",
    modelNames: copilotModelNamesSection,
    checkModels: checkCopilotModels,
    skillPreambles: true,
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

// Codex has no Claude aliases, so its block gives an example model per tier.
function checkCodexModels(codex, { raw, fail, unique }) {
  for (const tier of Object.keys(raw.tiers)) {
    if (!Object.hasOwn(codex, tier)) fail(`codex has no example for tier "${tier}"`);
  }
  for (const [tier, value] of Object.entries(codex)) {
    if (!Object.hasOwn(raw.tiers, tier)) fail(`codex names "${tier}", which is not a tier`);
    unique([value].flat(), `codex "${tier}"`);
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

// Copilot's block mirrors the tier keys like Codex's, but every value may be
// empty: the models a Copilot account reaches vary by plan and policy, so the
// build ships no IDs and the user picks them in setup-pstack.
function checkCopilotModels(copilot, { raw, fail }) {
  for (const tier of Object.keys(raw.tiers)) {
    if (!Object.hasOwn(copilot, tier)) fail(`copilot has no entry for tier "${tier}"`);
  }
  for (const [tier, value] of Object.entries(copilot)) {
    if (!Object.hasOwn(raw.tiers, tier)) fail(`copilot names "${tier}", which is not a tier`);
    if (Array.isArray(raw.tiers[tier])) {
      if (!Array.isArray(value) || value.some((m) => typeof m !== "string" || !m) || new Set(value).size !== value.length) {
        fail(`copilot "${tier}" must be a list of distinct model IDs (empty allowed)`);
      }
    } else if (value !== null && (typeof value !== "string" || !value)) {
      fail(`copilot "${tier}" must be a model ID or null`);
    }
  }
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
    "it names at another Pi model, whatever the session's provider. The `agent` tool also takes a full " +
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

// Copilot ships no default slugs: the models a Copilot account can reach vary
// by plan and policy, so the user picks them in setup-pstack.
export function copilotModelNamesSection(models) {
  const strongest = models.roles.filter((r) => r.tier === "strongest");
  const skills = [...new Set(models.roles.map((r) => r.skill))];
  const panel = models.copilot.panel.length
    ? `A good default panel is ${codeList(models.copilot.panel)}.`
    : "pstack ships no default Copilot panel.";
  return (
    "Skills name Claude Code model aliases in their Models sections. Those aliases are not Copilot model IDs, " +
    "and the Copilot build ships no default model IDs: the models an account can reach depend on its plan " +
    "and policy, so the user picks them once.\n\n" +
    "- The model sheet is `${COPILOT_HOME:-~/.copilot}/pstack-models.md`. It sits outside the workspace, so reading it " +
    "asks for path access. When it exists, the plugin's SessionStart hook reads it and adds its role lines to the " +
    "session context as the user's saved pstack model choices. Take role models from that block and do not `view` the " +
    "sheet. A role line names the model for that role.\n" +
    "- Read the sheet only when that block is missing, as in a skills-only install with no hook. `view`, `create`, and " +
    "`edit` take literal paths and expand neither `~` nor `$COPILOT_HOME`, so print the " +
    "sheet's absolute path with `bash` first (" + "`echo \"${COPILOT_HOME:-$HOME/.copilot}/pstack-models.md\"`" + ") and read " +
    "and write exactly that path; do not append `.copilot` or any other segment to it. A session with its own " +
    "`COPILOT_HOME` then never touches `~/.copilot`.\n" +
    `- No sheet: before a skill that needs a role model (${skills.map(code).join(", ")}), stop, load ` +
    "`setup-pstack` with the `skill` tool, and finish it first. In that same session, use the values it just wrote; later sessions get them from the " +
    "hook. Do not ask again on later runs.\n" +
    "- A role line in the sheet is the user's explicit model instruction, so pass it as the `task` tool's " +
    "`model` parameter. A role with no line, or `inherit-parent`/`auto`, omits `model`.\n" +
    "- The plugin's `PreToolUse` hook enforces this for pstack agents. It denies a `task` call whose `agent_type` " +
    "starts with `pstack:` and whose `model` is not one of the sheet's values, and its reason lists the saved IDs. " +
    "Retry with the role's saved model; never retry on another unsaved model. It leaves calls with no `model` and " +
    "other agent types alone.\n" +
    `- Roles that default to the strongest model (${strongest.map((r) => code(r.role)).join(", ")}): ` +
    "the strongest model the user chose.\n" +
    "- Diverse-model panels (`arena`, `architect`, `interrogate`, `how` critics, `reflect`): the adversarial " +
    "signal comes from model diversity, so fill a panel from distinct vendors in the `task` tool's `model` " +
    `list (Claude, GPT, Gemini, Grok, and so on). ${panel} If only one vendor is reachable, vary reasoning ` +
    "effort and note in the verdict that diversity was reduced.\n\n" +
    "`setup-pstack` lists the models from the `model` enum of the `task` tool and writes only IDs it saw there.\n\n" +
    "Run `setup-pstack`, and the parent session that orchestrates a panel, on a model at least as strong as " +
    "gpt-5.4-mini or a Sonnet-class Claude model. On a Haiku-class model, setup picked models the user never " +
    "chose in about half of the smoke runs."
  );
}
