import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentSkills } from "../tools/generate.mjs";
import { RUNTIMES, validateGrokPlugin } from "../tools/runtimes.mjs";
import { mappingCoverage } from "./mapping-coverage.mjs";

mappingCoverage(RUNTIMES.find((runtime) => runtime.name === "Grok Build"), [
  ["AskUserQuestion", "`AskUserQuestion`"],
  ["TaskCreate", "`TaskCreate`"],
  ["TaskUpdate", "`TaskUpdate`"],
  ["TodoWrite", "`TodoWrite`"],
  ["ScheduleWakeup", "`ScheduleWakeup`"],
  ["SendMessage", "`SendMessage`"],
  ["TaskOutput", "`TaskOutput`"],
  ["TaskStop", "`TaskStop`"],
  ["WebSearch", "`WebSearch`"],
  ["WebFetch", "`WebFetch`"],
  ["the `Skill` tool", "`Skill`"],
  ["the `Agent` tool", "`Agent`"],
  ["pstack:poteto-agent", "`pstack:poteto-agent`"],
  ["general-purpose", "`general-purpose`"],
]);

const root = mkdtempSync(join(tmpdir(), "pstack-grok-"));
const plugin = "plugins/pstack";
const file = (path, contents = "") => {
  const full = join(root, plugin, path);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, contents);
};
const manifest = { name: "pstack", skills: ["./skills", "./grok/skills"] };
const options = {
  pathExists: (path) => existsSync(join(root, path)),
  agentSkills: (path) => agentSkills(join(root, path)),
};
afterAll(() => rmSync(root, { recursive: true, force: true }));

test("Grok packaging requires both skill trees and valid routing frontmatter", () => {
  file("skills/poteto-mode/SKILL.md");
  file("grok/skills/pstack-routing/SKILL.md", "---\nname: pstack-routing\ndescription: Route tasks\n---\n");
  expect(() => validateGrokPlugin(manifest, options)).not.toThrow();
  expect(() => validateGrokPlugin({ ...manifest, skills: ["./grok/skills"] }, options)).toThrow("both skill directories");
  file("grok/skills/pstack-routing/SKILL.md", "---\nname: wrong\ndescription: Route tasks\n---\n");
  expect(() => validateGrokPlugin(manifest, options)).toThrow("frontmatter name");
  file("grok/skills/pstack-routing/SKILL.md", "---\nname: pstack-routing\n---\n");
  expect(() => validateGrokPlugin(manifest, options)).toThrow("no description");
  rmSync(join(root, plugin, "grok/skills/pstack-routing/SKILL.md"));
  expect(() => validateGrokPlugin(manifest, options)).toThrow("pstack-routing/SKILL.md");
});
