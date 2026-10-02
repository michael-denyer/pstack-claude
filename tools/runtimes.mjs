// The runtimes other than Claude Code that pstack ships to: the table the
// generator iterates, each runtime's Model names renderer and models.json
// check, and the validator for the Codex marketplace manifest.

export const PLUGIN = "plugins/pstack";
export const SKILLS = `${PLUGIN}/skills`;

export const code = (s) => `\`${s}\``;
export const codeList = (models) => models.map(code).join(", ");

// Every runtime other than Claude Code that reads the skills through a mapping
// file under poteto-mode/references/. A row gives the runtime its models.json
// block (`key`, checked by `checkModels`) and the generated Model names section
// in its mapping file. A `skillPreambles` runtime also gets a preamble under
// the first heading of each skill its Per-skill notes table lists, and a
// runtime with a `prompts` directory a slash stub per public skill there.
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
