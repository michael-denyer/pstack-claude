// The installed @earendil-works/pi-coding-agent package: PI_PACKAGE_DIR when
// set, otherwise the first global install under npm's root or bun's, or null.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function npmRoot() {
  try {
    return execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

export function findPiPackage() {
  if (process.env.PI_PACKAGE_DIR) return process.env.PI_PACKAGE_DIR;
  const roots = [npmRoot(), join(homedir(), ".bun/install/global/node_modules"), join(homedir(), ".cache/.bun/install/global/node_modules")];
  return roots.filter(Boolean).map((root) => join(root, "@earendil-works/pi-coding-agent")).find((dir) => existsSync(join(dir, "package.json"))) ?? null;
}
