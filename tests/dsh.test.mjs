import { expect, test } from "bun:test";
import { loadModels } from "../tools/generate.mjs";
import { dshModelNamesSection, roleSkills, RUNTIMES } from "../tools/runtimes.mjs";
import { mappingCoverage } from "./mapping-coverage.mjs";

const runtime = RUNTIMES.find((row) => row.name === "DeepSeek Harness");

mappingCoverage(runtime, [
  ["Read", "`read`"],
  ["Write", "`write`"],
  ["Edit", "`edit`"],
  ["Bash", "`bash`"],
  ["Glob", "`glob`"],
  ["Grep", "`grep`"],
  ["WebFetch", "`web_fetch`"],
  ["WebSearch", "WebSearch"],
  ["Skill", "`skill`"],
  ["AskUserQuestion", "`ask_user_question`"],
  ["Agent", "`subagent`"],
  ["SendMessage", "`send_message`"],
  ["TaskCreate", "`todo_write`"],
  ["TaskUpdate", "`todo_write`"],
  ["TodoWrite", "`todo_write`"],
  ["ScheduleWakeup", "ScheduleWakeup"],
  ["subagent_type", "`subagent_type`"],
  ["readonly", "`readonly`"],
  ["isolation", "`isolation`"],
  ["run_in_background", "`run_in_background`"],
]);

test("DSH Model names are generated from configured roles and panels", () => {
  const models = loadModels();
  expect(runtime.modelNames).toBe(dshModelNamesSection);
  const text = runtime.modelNames(models);
  for (const skill of roleSkills(models)) expect(text).toContain(`\`${skill}\``);

  const fixture = runtime.modelNames({
    roles: [
      { skill: "dsh-fixture-worker", tier: "worker" },
      { skill: "dsh-fixture-panel", tier: "panel" },
      { skill: "dsh-fixture-panel", tier: "panel" },
    ],
  });
  expect(fixture).toContain("`dsh-fixture-worker`");
  expect(fixture).toContain("Diverse-model panels (`dsh-fixture-panel`)");
  expect(fixture).not.toContain("`arena`");
  expect(fixture).not.toContain("`architect`");
});
