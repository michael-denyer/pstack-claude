import { cpSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const installerRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

// The tarball carries installer/plugin; a repo checkout or the tag tarball
// carries plugins/pstack beside installer/.
export function bundledPluginSource() {
  for (const dir of [join(installerRoot, "plugin"), join(installerRoot, "..", "plugins", "pstack")]) {
    if (existsSync(join(dir, ".claude-plugin", "plugin.json"))) return dir;
  }
  throw new Error("bundled pstack plugin not found next to this installer");
}

export const stableDir = ({ home, env }) =>
  join(env.XDG_DATA_HOME || join(home, ".local", "share"), "open-pstack", "pstack");

// Filter for cpSync from `root`: judge the path below root, because root itself
// sits under node_modules when the installer runs from an npm install.
export const withoutNodeModules = (root) => (src) =>
  !relative(root, src).split(sep).includes("node_modules");

// Copy to a sibling, then swap, so a rerun converges and a crash leaves the
// previous copy whole.
export function stagePlugin(source, dest) {
  mkdirSync(dirname(dest), { recursive: true });
  const fresh = `${dest}.new-${process.pid}`;
  const old = `${dest}.old-${process.pid}`;
  rmSync(fresh, { recursive: true, force: true });
  try {
    cpSync(source, fresh, { recursive: true, filter: withoutNodeModules(source) });
    if (existsSync(dest)) renameSync(dest, old);
    renameSync(fresh, dest);
  } catch (error) {
    if (!existsSync(dest) && existsSync(old)) renameSync(old, dest);
    throw error;
  } finally {
    rmSync(fresh, { recursive: true, force: true });
  }
  rmSync(old, { recursive: true, force: true });
}
