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
  const roots = [
    process.env.PSTACK_PI_AI_DIR && join(process.env.PSTACK_PI_AI_DIR, ".."),
    join(homedir(), ".cache/.bun/install/global/node_modules/@earendil-works"),
    join(homedir(), ".bun/install/global/node_modules/@earendil-works"),
    npmRoot() && join(npmRoot(), "@earendil-works"),
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

describe("models.json pi block", () => {
  test.skipIf(!dir)("every family name maps to a model in the installed Pi catalog", () => {
    const missing = Object.entries(piModels)
      .filter(([, ref]) => {
        const [provider, id] = ref.split("/");
        return !catalogIds(dir, provider).has(id);
      })
      .map(([alias, ref]) => `${alias}: ${ref}`);
    expect(missing).toEqual([]);
  });
});
