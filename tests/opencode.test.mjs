import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin from "../plugins/pstack/index.js";

test("Git package exposes the bundled OpenCode server", () => {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  expect(manifest.exports["./server"]).toBe("./plugins/pstack/index.js");
  expect(manifest.exports["./*"]).toBe("./*");
  expect(readFileSync(new URL(`../${manifest.exports["./server"]}`, import.meta.url), "utf8")).toContain('id: "pstack"');
});

test("routes only while every registered pstack skill belongs to the plugin", async () => {
  const skills = new Map();
  let context;
  const oldConfig = process.env.XDG_CONFIG_HOME;
  const dir = mkdtempSync(join(tmpdir(), "pstack-opencode-"));
  process.env.XDG_CONFIG_HOME = dir;
  try {
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
    const skill = skills.get("pstack-poteto-mode");
    expect(skill.content).toContain("# Poteto mode");
    expect(readFileSync(skill.path, "utf8")).toContain(skill.content);
    expect(skills.size).toBeGreaterThan(60);
    const root = { sessionID: "root", system: [] };
    await context(root);
    expect(root.system[0].text).toContain("pstack-poteto-mode");
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
  const skills = new Map([["pstack-poteto-mode", { id: "pstack-poteto-mode", path: "/user/SKILL.md", content: "user skill" }]]);
  let context;
  await plugin.setup({
    skill: {
      transform: async (apply) => apply({ get: (id) => skills.get(id), add: (skill) => skills.set(skill.id, skill) }),
      list: async () => ({ data: [...skills.values()] }),
    },
    session: { hook: async (_name, callback) => { context = callback; }, get: async () => ({}) },
  });
  const root = { sessionID: "root", system: [] };
  await context(root);
  expect(skills.get("pstack-poteto-mode").content).toBe("user skill");
  expect(root.system).toEqual([]);
});
