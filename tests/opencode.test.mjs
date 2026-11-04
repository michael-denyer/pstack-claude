import { describe, test, expect } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin from "../plugins/pstack/opencode/index.js";
import { fileURLToPath } from "node:url";
import { loadModels } from "../tools/generate.mjs";
import { openCodeModelNamesSection, roleSkills, RUNTIMES, validateOpenCodePackage } from "../tools/runtimes.mjs";
import { mappingCoverage } from "./mapping-coverage.mjs";
import { sheetCases, writeSheet } from "./session-hook-sheets.mjs";

async function setup(skills = new Map()) {
  let context;
  await plugin.setup({
    skill: {
      transform: async (apply) => apply({ get: (id) => skills.get(id), add: (skill) => skills.set(skill.id, skill) }),
      list: async () => ({ data: [...skills.values()] }),
    },
    session: {
      hook: async (_name, callback) => { context = callback; },
      get: async ({ sessionID }) => sessionID === "child" ? { parentID: "root" } : {},
    },
  });
  return { skills, context };
}

test("Git package exposes its OpenCode server", async () => {
  expect((await import("pstack/server")).default).toBe(plugin);
});

test("routes only while every registered pstack skill belongs to the plugin", async () => {
  const oldConfig = process.env.XDG_CONFIG_HOME;
  const dir = mkdtempSync(join(tmpdir(), "pstack-opencode-"));
  process.env.XDG_CONFIG_HOME = dir;
  try {
    const { skills, context } = await setup();
    const skill = skills.get("pstack-poteto-mode");
    expect(skill.content).toContain("# Poteto mode");
    expect(readFileSync(skill.path, "utf8")).toContain(skill.content);
    expect(skills.size).toBeGreaterThan(60);
    const root = { sessionID: "root", system: [] };
    await context(root);
    expect(root.system[0].text).toBe(readFileSync(new URL("../plugins/pstack/hooks/session-start-opencode.md", import.meta.url), "utf8"));
    expect(root.system[0].text).not.toMatch(/pstack:/);
    const child = { sessionID: "child", system: [] };
    await context(child);
    expect(child.system).toEqual([]);
    for (const id of ["pstack-poteto-mode", "pstack-how"]) {
      const original = skills.get(id);
      skills.set(id, { id, path: "/user/skill/SKILL.md", content: "user skill" });
      const collision = { sessionID: "root", system: [] };
      await context(collision);
      expect(collision.system).toEqual([]);
      expect(skills.get(id).content).toBe("user skill");
      expect(skills.get(id).path).toBe("/user/skill/SKILL.md");
      skills.set(id, original);
      const restored = { sessionID: "root", system: [] };
      await context(restored);
      expect(restored.system[0].text).toContain("pstack-poteto-mode");
    }
    mkdirSync(join(dir, "opencode"));
    writeFileSync(join(dir, "opencode", "pstack-models.md"), "session hook: off\r\n");
    const disabled = { sessionID: "root", system: [] };
    await context(disabled);
    expect(disabled.system).toEqual([]);
  } finally {
    if (oldConfig === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = oldConfig;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("preserves a preexisting conflicting skill and suppresses routing", async () => {
  const { skills, context } = await setup(new Map([["pstack-poteto-mode", { id: "pstack-poteto-mode", path: "/user/SKILL.md", content: "user skill" }]]));
  const root = { sessionID: "root", system: [] };
  await context(root);
  expect(skills.get("pstack-poteto-mode").content).toBe("user skill");
  expect(root.system).toEqual([]);
});

for (const { name, sheet, off } of sheetCases) {
  test(`matches the shared hook switch for ${name}`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "pstack-opencode-sheet-"));
    const oldConfig = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = dir;
    try {
      const settings = join(dir, "opencode");
      mkdirSync(settings);
      writeSheet(join(settings, "pstack-models.md"), sheet);
      const { context } = await setup();
      const event = { sessionID: "root", system: [] };
      await context(event);
      expect(event.system.length).toBe(off ? 0 : 1);
    } finally {
      if (oldConfig === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = oldConfig;
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

const root = fileURLToPath(new URL("..", import.meta.url));
const runtime = RUNTIMES.find((row) => row.name === "OpenCode 2");
const mapping = readFileSync(join(root, runtime.tools), "utf8");
const models = loadModels();

mappingCoverage(runtime, [
  ["AskUserQuestion", "`AskUserQuestion`"],
  ["subagent_type", "`subagent_type`"],
  ["run_in_background", "`run_in_background: true`"],
  ["TodoWrite", "`TodoWrite`"],
  ["TaskCreate", "`TaskCreate`"],
  ["readonly", "`readonly: true`"],
  ["the `Skill` tool", "the `Skill` tool"],
  ["the `Agent` tool", "the `Agent` tool"],
  ["plugin-dev", "`plugin-dev:skill-development`"],
  ["CLAUDE.md", "`CLAUDE.md`"],
  ["pstack:poteto-agent", "`pstack:poteto-agent`"],
  ["general-purpose", "`general-purpose`"],
  ["isolation: \"worktree\"", "`isolation: \"worktree\"`"],
  [".claude/skills", "`.claude/skills/`"],
  ["${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects", "`${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects/`"],
  ["`loop`", "`loop` skill"],
]);

describe("OpenCode package", () => {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const pathExists = (path) => existsSync(join(root, path));
  test("validates the native server entry and rejects a missing entry or file", () => {
    expect(() => validateOpenCodePackage(manifest, { pathExists })).not.toThrow();
    expect(() => validateOpenCodePackage({ ...manifest, exports: {} }, { pathExists })).toThrow("./server");
    expect(() => validateOpenCodePackage(manifest, { pathExists: () => false })).toThrow("does not exist");
  });
});

describe("OpenCode model names", () => {
  const section = openCodeModelNamesSection(models);
  test("uses user-requested configured IDs and names all role skills", () => {
    expect(section).toContain("providerID/modelID#variant");
    expect(section).toContain("only when the user explicitly");
    expect(section).not.toMatch(/`(?:opus|fable|sonnet|haiku)`/);
    for (const skill of roleSkills(models)) expect(section).toContain(`\`${skill}\``);
  });
  test("matches the generated mapping section", () => expect(mapping).toContain(section));
});
