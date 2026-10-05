import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { findPiPackage } from "../../tools/pi-package.mjs";

const root = join(import.meta.dir, "../..");
const piModels = JSON.parse(readFileSync(join(root, "plugins/pstack/models.json"), "utf8")).pi.models;

// pi-ai sits beside the package in a flat install; npm nests it under the package.
function catalogDir() {
  const piDir = findPiPackage();
  if (!piDir) return null;
  const candidates = [join(piDir, "../pi-ai/dist/providers/data"), join(piDir, "node_modules/@earendil-works/pi-ai/dist/providers/data")];
  return candidates.find((dir) => existsSync(dir)) ?? null;
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
    if (!dir) throw new Error("PSTACK_PI_REQUIRE_CATALOG=1, but no installed Pi catalog was found. Set PI_PACKAGE_DIR to the pi-coding-agent package.");
    const missing = Object.entries(piModels).flatMap(([provider, table]) =>
      Object.entries(table)
        .filter(([, ref]) => !catalogIds(dir, provider).has(ref.slice(provider.length + 1)))
        .map(([alias, ref]) => `${alias}: ${ref}`),
    );
    expect(missing).toEqual([]);
  });
});
