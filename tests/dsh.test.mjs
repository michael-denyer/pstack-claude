// Skills-only DSH contracts. These check the documented mapping and shared
// files; they do not pretend a mocked context is a running DSH Host.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadModels, noteSkills, parseFrontmatter } from "../tools/generate.mjs";
import { dshModelNamesSection, roleSkills, RUNTIMES } from "../tools/runtimes.mjs";
import { mappingCoverage } from "./mapping-coverage.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const runtime = RUNTIMES.find((row) => row.name === "DeepSeek Harness");
const mapping = readFileSync(join(root, runtime.tools), "utf8");
const setup = readFileSync(join(root, "plugins/pstack/skills/setup-pstack/references/runtimes.md"), "utf8");
const models = loadModels();

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

describe("DSH skills-only runtime", () => {
  test("generates its mapping without a native manifest, model defaults or skill preambles", () => {
    expect(runtime.mapping).toBe("dsh-tools.md");
    expect(runtime.modelNames).toBe(dshModelNamesSection);
    expect(runtime.tools).toBe("plugins/pstack/skills/poteto-mode/references/dsh-tools.md");
    for (const field of ["key", "manifest", "validate", "checkModels", "stampManifest", "hooks", "skillPreambles"]) {
      expect(runtime[field]).toBeUndefined();
    }
    expect(runtime.preamble).toBeNull();
    expect(mapping).toContain("skills-only");
    expect(mapping).toMatch(/does not install a native|no native|not a native/i);
  });

  test("each DSH per-skill note is a single skill name accepted by the generator", () => {
    const names = noteSkills(runtime, mapping);
    expect(names).toContain("poteto-mode");
    expect(names).toContain("setup-pstack");
    for (const name of names) {
      expect(name).toMatch(/^[a-z0-9-]+$/);
      const { data } = parseFrontmatter(readFileSync(join(root, "plugins/pstack/skills", name, "SKILL.md"), "utf8"));
      expect(data.name).toBe(name);
    }
    expect(() => noteSkills(runtime, "| Skill | On DeepSeek Harness |\n| --- | --- |\n| `how`, `why` | grouped |\n")).toThrow("does not start with a backticked skill");
  });

  test("model policy uses the live catalog and dispatch defaults rather than Claude aliases", () => {
    const text = dshModelNamesSection(models);
    expect(text).toContain("`list_subagent_models`");
    expect(text).toContain("provider/model pair");
    expect(text).toContain("live delegation schema");
    expect(text).toMatch(/omit all selectors.*defaults/);
    expect(text).not.toMatch(/`(?:opus|fable|sonnet|haiku)`/);
    expect(text).toContain("not DSH model IDs or built-in agent types");
    expect(text).toContain("no automatic per-role sheet reader");
    for (const skill of roleSkills(models)) expect(text).toContain(`\`${skill}\``);
  });

  test("renderer derives both role skills and diverse panels from its input", () => {
    const text = dshModelNamesSection({
      roles: [
        { skill: "dsh-fixture-worker", tier: "worker" },
        { skill: "dsh-fixture-panel", tier: "panel" },
        { skill: "dsh-fixture-panel", tier: "panel" },
      ],
    });
    expect(text).toContain("`dsh-fixture-worker`");
    expect(text).toContain("Diverse-model panels (`dsh-fixture-panel`)");
    expect(text).not.toContain("`arena`");
    expect(text).not.toContain("`architect`");
    expect(text).toMatch(/report when.*unavailable/);
  });

  test("shared bundle flags keep principles model-invocable without forcing them into the user menu", () => {
    for (const name of ["poteto-mode", "principle-prove-it-works", "principle-boundary-discipline"]) {
      const { data } = parseFrontmatter(readFileSync(join(root, "plugins/pstack/skills", name, "SKILL.md"), "utf8"));
      expect(data.name).toBe(name);
      expect(typeof data.description).toBe("string");
      expect(data["disable-model-invocation"]).toBeUndefined();
      if (name.startsWith("principle-")) expect(data["user-invocable"]).toBe(false);
    }
    expect(mapping).toContain("one level deep");
    expect(mapping).toContain("customSkillDirs");
    expect(mapping).toContain("resource base");
    expect(mapping).toMatch(/Link each skill directory|link each skill/i);
  });

  test("delegation describes unsupported fields and permission/depth limits without inventing a replacement runtime", () => {
    expect(mapping).toContain("`subagent_fork`");
    expect(mapping).toContain("`interrupt_agent`");
    expect(mapping).toMatch(/do not (?:pass|take).*subagent_type.*readonly.*isolation/i);
    expect(mapping).toMatch(/prompt is not a filesystem sandbox|prompt.*not.*sandbox/i);
    expect(mapping).toMatch(/delegation.depth limit/i);
    expect(mapping).toMatch(/do not start a CLI|do not.*evade|never.*evade/i);
    expect(mapping).toMatch(/required independent review.*unverified|independent review.*blocked/i);
  });

  test("persistent schedules require the user's request instead of a playbook's autonomous wakeup", () => {
    expect(mapping).toContain("`schedule_create`");
    expect(mapping).toMatch(/only for an explicit user request|only.*explicit.*user.*request/i);
    expect(mapping).toMatch(/never silently.*persistent schedule|do not.*autonomous.*schedule/i);
    expect(mapping).toContain("ScheduleWakeup");
  });

  test("DSH history and verification do not fall back to another app's personal session data or a mock GUI", () => {
    expect(mapping).toMatch(/Do not read Claude Code.*Pi.*session|Do not.*Pi.*Claude.*session/i);
    expect(mapping).toMatch(/workspace and session scope|scoped history/);
    expect(mapping).toMatch(/historical transcript audit did not run|history.*unavailable|historical.*unverified/i);
    expect(mapping).toMatch(/mock page|mock.*GUI|mock.*Host/i);
    expect(mapping).toMatch(/unverified visual|visual.*unverified/i);
  });

  test("setup has a DSH-specific branch instead of writing the Claude or Pi sheet", () => {
    const branch = setup.split("## DeepSeek Harness\n")[1]?.split(/\n## /)[0];
    expect(branch).toBeDefined();
    expect(setup).toContain("## Codex\n");
    expect(branch).not.toContain("<codex-home>");
    expect(branch).not.toContain("your Codex models");
    expect(branch).not.toContain("the user trusts plugin hooks");
    expect(branch).toMatch(/steps 1.*8|steps 1 through 8|steps 1–8/i);
    expect(branch).toContain("list_subagent_models");
    expect(branch).toMatch(/no.*sheet|do not write.*sheet|does not.*sheet/i);
    expect(branch).toMatch(/no.*hook|does not.*hook|no automatic routing/i);
    expect(branch).toMatch(/default|inherit/i);
    expect(branch).toMatch(/user.*request|explicit/i);
  });
});
