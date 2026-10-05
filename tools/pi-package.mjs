// The installed @earendil-works/pi-coding-agent package: PI_PACKAGE_DIR when
// set, otherwise the first global install under npm's root or bun's, or null.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Where `bun add -g` puts node_modules: bun's own order is BUN_INSTALL_GLOBAL_DIR,
// then $BUN_INSTALL/install/global, then $XDG_CACHE_HOME/.bun/install/global,
// then ~/.bun/install/global. A bunfig or CLI global directory is not read.
function bunRoots() {
  const { BUN_INSTALL_GLOBAL_DIR, BUN_INSTALL, XDG_CACHE_HOME } = process.env;
  return [
    BUN_INSTALL_GLOBAL_DIR && join(BUN_INSTALL_GLOBAL_DIR, "node_modules"),
    BUN_INSTALL && join(BUN_INSTALL, "install/global/node_modules"),
    XDG_CACHE_HOME && join(XDG_CACHE_HOME, ".bun/install/global/node_modules"),
    join(homedir(), ".bun/install/global/node_modules"),
    join(homedir(), ".cache/.bun/install/global/node_modules"),
  ];
}

function npmRoot() {
  try {
    return execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

export function findPiPackage() {
  if (process.env.PI_PACKAGE_DIR) return process.env.PI_PACKAGE_DIR;
  const roots = [npmRoot(), ...bunRoots()];
  return roots.filter(Boolean).map((root) => join(root, "@earendil-works/pi-coding-agent")).find((dir) => existsSync(join(dir, "package.json"))) ?? null;
}

export function piCompilerPaths(piDir) {
  // npm nests the package's dependencies in its own node_modules; bun's global
  // directory is flat, so there they sit beside the package's scope.
  const dep = (name) => [join(piDir, "node_modules", name), join(piDir, "..", "..", name)].find(existsSync) ?? join(piDir, "node_modules", name);
  return {
    typeRoots: [dep("@types")],
    baseUrl: piDir,
    paths: {
      "@earendil-works/pi-coding-agent": ["dist/index.d.ts"],
      "@earendil-works/pi-ai": [join(dep("@earendil-works/pi-ai"), "dist/index.d.ts")],
      "@earendil-works/pi-agent-core": [join(dep("@earendil-works/pi-agent-core"), "dist/index.d.ts")],
      typebox: [join(dep("typebox"), "build/index.d.mts")],
      "typebox/*": [join(dep("typebox"), "build/*/index.d.mts")],
    },
  };
}
