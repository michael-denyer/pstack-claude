import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pstack from "../plugins/pstack/omp/index.mjs";
import { RUNTIMES, validateOmpPackage } from "../tools/runtimes.mjs";
import { mappingCoverage } from "./mapping-coverage.mjs";
import { sheetCases, writeSheet } from "./session-hook-sheets.mjs";

mappingCoverage(RUNTIMES.find((r) => r.name === "OMP"), [
  ["AskUserQuestion", "`AskUserQuestion`"],
  ["subagent_type", "`subagent_type`"],
  ["run_in_background", "`run_in_background`"],
  ["TodoWrite", "`TodoWrite`"],
  ["TaskCreate", "`TaskCreate`"],
  ["readonly", "`readonly`"],
  ["the `Skill` tool", "the `Skill` tool"],
  ["the `Agent` tool", "the `Agent` tool"],
  ["plugin-dev", "`plugin-dev:skill-development`"],
  ["CLAUDE.md", "`CLAUDE.md`"],
  ["pstack:poteto-agent", "`pstack:poteto-agent`"],
  ["general-purpose", "`general-purpose`"],
  ["isolation: \"worktree\"", "`isolation: \"worktree\"`"],
  [".claude/skills", "`.claude/skills`"],
  ["${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects", "`${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects`"],
  ["`loop`", "`loop`"],
]);

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

  test("the global session-hook toggle stops main routing but keeps both mappings", () => {
    const home = mkdtempSync(join(tmpdir(), "pstack-omp-toggle-"));
    try {
      mkdirSync(join(home, ".omp"));
      const sheet = join(home, ".omp", "pstack-models.md");
      const script = `import pstack from ${JSON.stringify(new URL("../plugins/pstack/omp/index.mjs", import.meta.url).href)};
        const handlers = new Map(); pstack({on: (name, fn) => handlers.set(name, fn)});
        const event = {systemPrompt: ["existing instructions"]}; const before = handlers.get("before_agent_start");
        console.log(JSON.stringify({main: before(event, {agent: {kind: "main"}}), sub: before(event, {agent: {kind: "sub"}})}));`;
      const run = () => {
        const result = spawnSync(process.execPath, ["-e", script], { env: { ...process.env, HOME: home }, encoding: "utf8" });
        expect(result.status).toBe(0);
        return JSON.parse(result.stdout);
      };
      expect(run().main.systemPrompt[1]).toContain("<EXTREMELY_IMPORTANT>");
      for (const { sheet: contents, off } of sheetCases) {
        rmSync(sheet, { recursive: true, force: true });
        writeSheet(sheet, contents);
        const result = run();
        expect(result.main.systemPrompt[1]).toContain("OMP tool and model mappings");
        expect(result.main.systemPrompt[1].includes("<EXTREMELY_IMPORTANT>")).toBe(!off);
        expect(result.sub.systemPrompt[1]).toContain("OMP tool and model mappings");
      }
      rmSync(sheet, { recursive: true, force: true });
      writeFileSync(sheet, "session hook: on\nsession hook: off\n");
      expect(run().main.systemPrompt[1]).not.toContain("<EXTREMELY_IMPORTANT>");
      writeFileSync(sheet, "session hook: on\n");
      expect(run().main.systemPrompt[1]).toContain("<EXTREMELY_IMPORTANT>");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("OMP runtime registration", () => {
  const manifest = { name: "pstack", version: "1", omp: { extensions: ["./omp/index.mjs"] } };
  const marketplace = { plugins: [{ name: "pstack", source: "./plugins/pstack", version: "1" }] };
  const required = new Set([
    "plugins/pstack/omp/index.mjs",
    "plugins/pstack/skills/poteto-mode/SKILL.md",
    "plugins/pstack/hooks/session-start-context.md",
  ]);
  const options = { marketplace, pathExists: (path) => required.has(path) };

  test("OMP registry owns its versioned package and model mapping", () => {
    const runtime = RUNTIMES.find((r) => r.name === "OMP");
    expect(runtime.manifest).toBe("plugins/pstack/package.json");
    expect(runtime.tools).toEndWith("/omp-tools.md");
    expect(runtime.modelNames()).toContain("task.agentModelOverrides");
  });

  test("OMP validates the marketplace, extension and required files", () => {
    expect(() => validateOmpPackage(manifest, options)).not.toThrow();
    expect(() => validateOmpPackage({ ...manifest, name: "other" }, options)).toThrow("marketplace entry");
    expect(() => validateOmpPackage({ ...manifest, version: "2" }, options)).toThrow("marketplace entry");
    expect(() => validateOmpPackage({ ...manifest, omp: { extensions: [] } }, options)).toThrow("omp/index.mjs");
    for (const path of required) {
      expect(() => validateOmpPackage(manifest, { ...options, pathExists: (name) => name !== path })).toThrow("OMP package missing");
    }
  });
});
