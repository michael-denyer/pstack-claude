import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateGrokPlugin } from "../tools/generate.mjs";

const root = mkdtempSync(join(tmpdir(), "pstack-grok-"));
const file = (path, contents = "") => {
  const full = join(root, path);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, contents);
};
const manifest = (skills) => file(".grok-plugin/plugin.json", JSON.stringify({ name: "pstack", skills }));
afterEach(() => rmSync(root, { recursive: true, force: true }));

test("Grok packaging rejects losing either the existing skills or the routing skill", () => {
  file("skills/poteto-mode/SKILL.md");
  file("grok/skills/pstack-routing/SKILL.md");
  manifest(["./skills", "./grok/skills"]);
  expect(() => validateGrokPlugin(root)).not.toThrow();
  manifest(["./grok/skills"]);
  expect(() => validateGrokPlugin(root)).toThrow("both skill directories");
  manifest(["./skills", "./grok/skills"]);
  rmSync(join(root, "grok/skills/pstack-routing/SKILL.md"));
  expect(() => validateGrokPlugin(root)).toThrow("pstack-routing/SKILL.md");
});
