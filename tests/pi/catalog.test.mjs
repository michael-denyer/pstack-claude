import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { installedPi, PI_FLOOR, piDependency } from "../../tools/pi-package.mjs";

const root = join(import.meta.dir, "../..");
const piModels = JSON.parse(readFileSync(join(root, "plugins/pstack/models.json"), "utf8")).pi.models;

function installedCatalog() {
  const pi = installedPi();
  if (!pi) return null;
  const piAi = piDependency(pi.dir, "@earendil-works/pi-ai");
  const dir = piAi && join(piAi, "dist/providers/data");
  if (!dir || !existsSync(dir)) return null;
  return { dir, version: JSON.parse(readFileSync(join(piAi, "package.json"), "utf8")).version, supported: pi.supported };
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
// A Pi older than PI_FLOOR predates models that the tables name, so its catalog cannot check them.
const tooOld = catalog && !catalog.supported;
const found = `pi-ai ${catalog?.version ?? "not found"}${tooOld ? `, older than the supported Pi ${PI_FLOOR}` : ""}`;

describe("models.json pi block", () => {
  test.skipIf((!catalog || tooOld) && !required)(`every provider table maps each family name to a model in the installed Pi catalog (${found})`, () => {
    if (!catalog) throw new Error("PSTACK_PI_REQUIRE_CATALOG=1, but no installed Pi catalog was found. Set PI_PACKAGE_DIR to the pi-coding-agent package.");
    const missing = Object.entries(piModels).flatMap(([provider, table]) =>
      Object.entries(table)
        .filter(([, ref]) => !catalogIds(catalog.dir, provider).has(ref.slice(provider.length + 1)))
        .map(([alias, ref]) => `${alias}: ${ref}`),
    );
    expect(missing).toEqual([]);
  });
});
