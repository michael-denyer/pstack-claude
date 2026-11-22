// prepack: copy the plugin and its licenses into installer/ so the tarball
// carries them. Also runs from a checkout; the copies are gitignored.
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const installer = join(dirname(fileURLToPath(import.meta.url)), "..");
const repo = join(installer, "..");

rmSync(join(installer, "plugin"), { recursive: true, force: true });
mkdirSync(join(installer, "plugin"), { recursive: true });
cpSync(join(repo, "plugins", "pstack"), join(installer, "plugin"), {
  recursive: true,
  filter: (src) =>
    !relative(join(repo, "plugins", "pstack"), src).split(sep).includes("node_modules"),
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
