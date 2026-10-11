import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { findPiPackage, piDependency } from "../../tools/pi-package.mjs";

const root = join(import.meta.dir, "../..");
const piModels = JSON.parse(readFileSync(join(root, "plugins/pstack/models.json"), "utf8")).pi.models;

function installedCatalog() {
  const piDir = findPiPackage();
  if (!piDir) return null;
  const piAi = piDependency(piDir, "@earendil-works/pi-ai");
  const dir = piAi && join(piAi, "dist/providers/data");
  if (!dir || !existsSync(dir)) return null;
  return { dir, version: JSON.parse(readFileSync(join(piAi, "package.json"), "utf8")).version };
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

const catalog = installedCatalog();
// CI's pi-types job installs Pi and sets this, so a catalog that moved fails
// there instead of skipping.
const required = process.env.PSTACK_PI_REQUIRE_CATALOG === "1";

describe("models.json pi block", () => {
  test.skipIf(!catalog && !required)(`every provider table maps each family name to a model in the installed Pi catalog (pi-ai ${catalog?.version ?? "not found"})`, () => {
    if (!catalog) throw new Error("PSTACK_PI_REQUIRE_CATALOG=1, but no installed Pi catalog was found. Set PI_PACKAGE_DIR to the pi-coding-agent package.");
    const missing = Object.entries(piModels).flatMap(([provider, table]) =>
      Object.entries(table)
        .filter(([, ref]) => !catalogIds(catalog.dir, provider).has(ref.slice(provider.length + 1)))
        .map(([alias, ref]) => `${alias}: ${ref}`),
    );
    expect(missing).toEqual([]);
  });
});
