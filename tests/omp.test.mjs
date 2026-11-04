import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pstack from "../plugins/pstack/omp/index.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const plugin = join(root, "plugins/pstack");

describe("OMP marketplace plugin", () => {
  test("the marketplace plugin carries its extension and skill catalog", () => {
    const catalog = JSON.parse(readFileSync(join(root, ".claude-plugin/marketplace.json"), "utf8"));
    const entry = catalog.plugins.find((item) => item.name === "pstack");
    const packageRoot = join(root, entry.source);
    const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
    expect(packageRoot).toBe(plugin);
    expect(manifest.name).toBe(entry.name);
    expect(manifest.version).toBe(entry.version);
    expect(manifest.omp.extensions).toEqual(["./omp/index.mjs"]);
    expect(existsSync(join(packageRoot, manifest.omp.extensions[0]))).toBe(true);
    const skills = readdirSync(join(packageRoot, "skills"), { withFileTypes: true })
      .filter((item) => item.isDirectory() && existsSync(join(packageRoot, "skills", item.name, "SKILL.md")))
      .map((item) => item.name);
    expect(skills).toContain("poteto-mode");
    expect(skills).toContain("architect");
    expect(skills.length).toBeGreaterThan(1);
  });

  test("routes main turns and keeps subagents to the tool mapping", () => {
    const handlers = new Map();
    pstack({ on: (event, handler) => handlers.set(event, handler) });
    const before = handlers.get("before_agent_start");
    expect(before).toBeDefined();
    const event = { systemPrompt: ["existing instructions"] };
    const main = before(event, { agent: { kind: "main" } });
    expect(main.systemPrompt[0]).toBe("existing instructions");
    expect(main.systemPrompt[1]).toContain(readFileSync(join(plugin, "hooks/session-start-context.md"), "utf8"));
    expect(main.systemPrompt[1]).toContain(join(plugin, "skills/poteto-mode/references/omp-tools.md"));
    expect(main.systemPrompt[1]).toContain(join(plugin, "skills/poteto-mode/SKILL.md"));
    expect(main.systemPrompt[1]).toContain(join(plugin, "skills/<name>/SKILL.md"));
    expect(main.systemPrompt[1]).toContain("Do not resolve these names through a bare skill name");
    expect(before(main, { agent: { kind: "main" } })).toBeUndefined();
    const child = before(event, { agent: { kind: "sub" } });
    expect(child.systemPrompt[1]).toContain("OMP tool and model mappings");
    expect(child.systemPrompt[1]).not.toContain("<EXTREMELY_IMPORTANT>");
    expect(event.systemPrompt).toEqual(["existing instructions"]);
  });
});
