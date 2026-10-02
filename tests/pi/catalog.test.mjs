import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "../..");
const piModels = JSON.parse(readFileSync(join(root, "plugins/pstack/models.json"), "utf8")).pi.models;

function npmRoot() {
  try {
    return execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function catalogDir() {
  const npm = npmRoot();
  const roots = [
    process.env.PSTACK_PI_AI_DIR && join(process.env.PSTACK_PI_AI_DIR, ".."),
    join(homedir(), ".cache/.bun/install/global/node_modules/@earendil-works"),
    join(homedir(), ".bun/install/global/node_modules/@earendil-works"),
    npm && join(npm, "@earendil-works"),
    // npm nests a global package's dependencies under the package.
    npm && join(npm, "@earendil-works/pi-coding-agent/node_modules/@earendil-works"),
  ].filter(Boolean);
  for (const r of roots) {
    const dir = join(r, "pi-ai/dist/providers/data");
    if (existsSync(dir)) return dir;
  }
  return null;
}

function catalogIds(dir, provider) {
  const file = join(dir, `${provider}.json`);
  if (!existsSync(file)) return new Set();
  const ids = new Set();
  for (const models of Object.values(JSON.parse(readFileSync(file, "utf8")))) {
    for (const m of Object.values(models)) if (m.provider === provider) ids.add(m.id);
  }
  return ids;
}

const dir = catalogDir();
// CI's pi-types job installs Pi and sets this, so a catalog that moved fails
// there instead of skipping.
const required = process.env.PSTACK_PI_REQUIRE_CATALOG === "1";

describe("models.json pi block", () => {
  test.skipIf(!dir && !required)("every provider table maps each family name to a model in the installed Pi catalog", () => {
    if (!dir) throw new Error("PSTACK_PI_REQUIRE_CATALOG=1, but no installed Pi catalog was found. Set PSTACK_PI_AI_DIR to the pi-ai package.");
    const missing = Object.entries(piModels).flatMap(([provider, table]) =>
      Object.entries(table)
        .filter(([, ref]) => !catalogIds(dir, provider).has(ref.slice(provider.length + 1)))
        .map(([alias, ref]) => `${alias}: ${ref}`),
    );
    expect(missing).toEqual([]);
  });
});
