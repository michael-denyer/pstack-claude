// The compiler options the Pi typecheck derives from where Pi is installed.
import { expect, test } from "bun:test";
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
