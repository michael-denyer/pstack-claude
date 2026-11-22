// prepack: copy the plugin and its licenses into installer/ so the tarball
// carries them. Also runs from a checkout; the copies are gitignored.
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { withoutNodeModules } from "../lib/bundle.mjs";

const installer = join(dirname(fileURLToPath(import.meta.url)), "..");
const repo = join(installer, "..");
const pluginSource = join(repo, "plugins", "pstack");

rmSync(join(installer, "plugin"), { recursive: true, force: true });
mkdirSync(join(installer, "plugin"), { recursive: true });
cpSync(pluginSource, join(installer, "plugin"), {
  recursive: true,
  filter: withoutNodeModules(pluginSource),
});
for (const name of [
  "LICENSE",
  "LICENSE-cursor-team-kit",
  "LICENSE-thermos",
  "NOTICE.md",
  "NOTICE-skills.md",
]) {
  cpSync(join(repo, name), join(installer, name));
}
