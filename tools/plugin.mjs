// Where the plugin lives in the repo, the Markdown code spans the generator
// and the runtime table render identifiers with, and the shared entry-point
// guard.

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const PLUGIN = "plugins/pstack";
export const SKILLS = `${PLUGIN}/skills`;

export const code = (s) => `\`${s}\``;
export const codeList = (models) => models.map(code).join(", ");

// node resolves a symlink in import.meta.url and leaves it in argv[1], so
// compare real paths.
export function isMain(metaUrl) {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}
