// The compiler options the Pi typecheck derives from where Pi is installed.
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { piCompilerPaths } from "../tools/pi-package.mjs";

const DEP_FILES = [
  "@types/node/index.d.ts",
  "@earendil-works/pi-ai/dist/index.d.ts",
  "@earendil-works/pi-agent-core/dist/index.d.ts",
  "typebox/build/index.d.mts",
  "typebox/build/value/index.d.mts",
];

test.each([
  ["npm's nested layout", (piDir) => join(piDir, "node_modules")],
  ["bun's flat global layout", (piDir) => join(piDir, "..", "..")],
])("every file the typecheck names exists under %s", (_, depRoot) => {
  const root = mkdtempSync(join(tmpdir(), "pstack-pi-package-"));
  try {
    const piDir = join(root, "node_modules", "@earendil-works", "pi-coding-agent");
    for (const file of [join(piDir, "dist/index.d.ts"), ...DEP_FILES.map((dep) => join(depRoot(piDir), dep))]) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, "");
    }

    const { typeRoots, baseUrl, paths } = piCompilerPaths(piDir);

    expect(typeRoots.map((dir) => existsSync(join(dir, "node", "index.d.ts")))).toEqual([true]);
    const named = Object.values(paths).flat().map((target) => resolve(baseUrl, target.replace("*", "value")));
    expect(named.filter((file) => !existsSync(file))).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const PI = join("@earendil-works", "pi-coding-agent");
const PI_PACKAGE_MODULE = resolve(import.meta.dir, "../tools/pi-package.mjs");

// Bun's child processes ignore edits to process.env, so run findPiPackage in a fresh bun with HOME, npm, and the
// bun variables pointed into a temp dir. Only the fake tree can match.
function findPiUnder(root, env, globalDir) {
  const piDir = join(globalDir, PI);
  mkdirSync(piDir, { recursive: true });
  writeFileSync(join(piDir, "package.json"), "{}");
  const childEnv = { ...process.env, HOME: join(root, "home"), npm_config_prefix: join(root, "npm"), ...env };
  for (const key of ["PI_PACKAGE_DIR", "BUN_INSTALL", "BUN_INSTALL_GLOBAL_DIR", "XDG_CACHE_HOME"]) if (!(key in env)) delete childEnv[key];
  const run = spawnSync(process.execPath, ["-e", `import(${JSON.stringify(PI_PACKAGE_MODULE)}).then((m) => console.log(m.findPiPackage()))`], { env: childEnv, encoding: "utf8" });
  return { found: run.stdout.trim(), piDir };
}

test.each([
  ["BUN_INSTALL", (root) => ({ BUN_INSTALL: join(root, "bun") }), (root) => join(root, "bun", "install", "global", "node_modules")],
  ["BUN_INSTALL_GLOBAL_DIR", (root) => ({ BUN_INSTALL_GLOBAL_DIR: join(root, "gd") }), (root) => join(root, "gd", "node_modules")],
  ["XDG_CACHE_HOME", (root) => ({ XDG_CACHE_HOME: join(root, "xdg") }), (root) => join(root, "xdg", ".bun", "install", "global", "node_modules")],
])("findPiPackage finds a Pi that bun add -g put under %s", (_, env, globalDir) => {
  const root = mkdtempSync(join(tmpdir(), "pstack-pi-package-"));
  try {
    const { found, piDir } = findPiUnder(root, env(root), globalDir(root));
    expect(found).toBe(piDir);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("findPiPackage still finds a Pi under HOME's default bun directory", () => {
  const root = mkdtempSync(join(tmpdir(), "pstack-pi-package-"));
  try {
    const { found, piDir } = findPiUnder(root, {}, join(root, "home", ".bun", "install", "global", "node_modules"));
    expect(found).toBe(piDir);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
