import { expect, test } from "bun:test";
import { RUNTIMES, validateKimiManifest } from "../tools/runtimes.mjs";
import { mappingCoverage } from "./mapping-coverage.mjs";

const kimi = RUNTIMES.find((runtime) => runtime.name === "Kimi Code CLI");
mappingCoverage(kimi, [
  ["subagent_type", "`subagent_type`"],
  ["run_in_background", "`run_in_background: true`"],
  ["SendMessage", "`SendMessage`"],
  ["ScheduleWakeup", "`ScheduleWakeup`"],
  ["CLAUDE.md", "`CLAUDE.md`"],
  ["AskUserQuestion", "`AskUserQuestion`"],
]);

test("Kimi manifest requires its packaged skills and prompt", () => {
  const manifest = { name: "pstack", skills: "./plugins/pstack/skills", systemPromptPath: "./plugins/pstack/hooks/kimi-instructions.md" };
  expect(() => validateKimiManifest(manifest, { pathExists: () => true })).not.toThrow();
  expect(() => validateKimiManifest({ ...manifest, skills: "./missing" }, { pathExists: () => true })).toThrow();
  expect(() => validateKimiManifest(manifest, { pathExists: () => false })).toThrow();
});
