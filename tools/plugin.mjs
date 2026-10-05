// Where the plugin lives in the repo, and the Markdown code spans the generator
// and the runtime table render identifiers with.

export const PLUGIN = "plugins/pstack";
export const SKILLS = `${PLUGIN}/skills`;

export const code = (s) => `\`${s}\``;
export const codeList = (models) => models.map(code).join(", ");
