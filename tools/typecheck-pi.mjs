// Typechecks the Pi extension under strict against an installed Pi package:
// its API types, its typebox, and its @types/node, which are what the
// extension runs with inside Pi. PI_PACKAGE_DIR names the package; otherwise
// it is looked up under the global npm root. CI installs a pinned version
// there, so the check costs no devDependency and leaves bun.lock alone.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const piDir = process.env.PI_PACKAGE_DIR ?? join(execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(), "@earendil-works", "pi-coding-agent");
if (!existsSync(join(piDir, "dist", "index.d.ts"))) {
  console.error(`No Pi package at ${piDir}. Install one with npm install -g @earendil-works/pi-coding-agent, or set PI_PACKAGE_DIR.`);
  process.exit(2);
}

const config = {
  compilerOptions: {
    target: "es2022",
    module: "esnext",
    moduleResolution: "bundler",
    allowImportingTsExtensions: true,
    noEmit: true,
    strict: true,
    skipLibCheck: true,
    types: ["node"],
    typeRoots: [join(piDir, "node_modules", "@types")],
    baseUrl: piDir,
    paths: {
      "@earendil-works/pi-coding-agent": ["dist/index.d.ts"],
      "@earendil-works/pi-ai": ["node_modules/@earendil-works/pi-ai/dist/index.d.ts"],
      "@earendil-works/pi-agent-core": ["node_modules/@earendil-works/pi-agent-core/dist/index.d.ts"],
      typebox: ["node_modules/typebox/build/index.d.mts"],
      "typebox/*": ["node_modules/typebox/build/*/index.d.mts"],
    },
  },
  include: [join(repo, "plugins", "pstack", "pi", "*.ts")],
};
const dir = mkdtempSync(join(tmpdir(), "pstack-pi-typecheck-"));
try {
  writeFileSync(join(dir, "tsconfig.json"), JSON.stringify(config, null, 2));
  console.log(`typechecking plugins/pstack/pi against ${piDir}`);
  const tsc = spawnSync("bunx", ["--package", "typescript@5.9.3", "tsc", "-p", join(dir, "tsconfig.json")], { cwd: dir, stdio: "inherit" });
  process.exitCode = tsc.status ?? 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
