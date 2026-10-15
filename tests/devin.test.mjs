import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureDevinProfile } from "../plugins/pstack/skills/setup-pstack/scripts/devin-profile.mjs";
import { loadLeadLines, validateHooks } from "../tools/generate.mjs";
import { devinModelNamesSection, RUNTIMES, validateDevinManifest } from "../tools/runtimes.mjs";
import { sheetCases, writeSheet } from "./session-hook-sheets.mjs";

const repo = fileURLToPath(new URL("..", import.meta.url));
const plugin = join(repo, "plugins/pstack");
const helper = join(plugin, "skills/setup-pstack/scripts/devin-profile.mjs");
const mandate = readFileSync(join(plugin, "hooks/session-start-context.md"), "utf8");
const dirs = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "pstack-devin-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));
const cli = (...args) => spawnSync(process.execPath, [helper, ...args], { encoding: "utf8" });

function hook(sheet, pluginRoot = plugin) {
  const xdg = temp();
  mkdirSync(join(xdg, "devin"));
  if (sheet !== null) writeSheet(join(xdg, "devin/pstack-models.md"), sheet);
  return spawnSync("sh", [join(pluginRoot, "hooks/session-start.sh"), "devin"], {
    env: { ...process.env, XDG_CONFIG_HOME: xdg, CLAUDE_PLUGIN_ROOT: pluginRoot }, encoding: "utf8",
  });
}

const context = (result, pluginRoot = plugin) => {
  expect({ status: result.status, err: result.stderr }).toEqual({ status: 0, err: "" });
  const parsed = JSON.parse(result.stdout);
  expect(Object.keys(parsed)).toEqual(["hookSpecificOutput"]);
  expect(parsed.hookSpecificOutput).toEqual({
    hookEventName: "SessionStart",
    additionalContext: `${mandate}\nOn Devin CLI, read ${pluginRoot}/skills/poteto-mode/references/devin-tools.md before using pstack. It maps tools and saved role choices to Devin profiles.`,
  });
  return parsed.hookSpecificOutput.additionalContext;
};

describe("Devin profile helper", () => {
  test("the CLI creates a pinned profile and resolves the same name without a write", () => {
    const dir = temp();
    const result = cli("--model", "fixture-model", "--agents-dir", dir);
    expect({ status: result.status, err: result.stderr }).toEqual({ status: 0, err: "" });
    const name = result.stdout.trim();
    expect(name).toMatch(/^pstack-model-[0-9a-f]{24}$/);
    expect(readdirSync(dir)).toEqual([`${name}.md`]);
    const text = readFileSync(join(dir, `${name}.md`), "utf8");
    expect(text).toContain(`name: ${name}\n`);
    expect(text).toContain('model: "fixture-model"\n');
    expect(text).not.toContain("allowed-tools:");
    expect(text).not.toContain("max-nesting:");
    expect(text).toContain("Read those files in full");
    const before = statSync(dir).mtimeMs;
    expect(cli("--model", "fixture-model", "--name-only").stdout).toBe(`${name}\n`);
    expect(statSync(dir).mtimeMs).toBe(before);
  });

  test("an identical profile keeps its bytes and timestamp on repeat setup", () => {
    const agentsDir = temp();
    const first = ensureDevinProfile({ model: "fixture-model", agentsDir });
    const bytes = readFileSync(first.path);
    utimesSync(first.path, 1000, 1000);
    expect(ensureDevinProfile({ model: "fixture-model", agentsDir })).toEqual(first);
    expect(readFileSync(first.path)).toEqual(bytes);
    expect(statSync(first.path).mtimeMs).toBe(1000000);
  });

  test("conflicting files stay untouched", () => {
    const agentsDir = temp();
    const { path } = ensureDevinProfile({ model: "fixture-model", agentsDir });
    writeFileSync(path, "user-owned bytes\n");
    expect(() => ensureDevinProfile({ model: "fixture-model", agentsDir })).toThrow(`profile conflict at ${path}`);
    expect(readFileSync(path, "utf8")).toBe("user-owned bytes\n");
    expect(cli("--model", "fixture-model", "--agents-dir", agentsDir).status).toBe(1);
  });

  test("distinct UIDs have bounded names and JSON-quoted YAML model scalars", () => {
    const agentsDir = temp();
    const model = 'vendor/model:"quoted"\\value';
    const a = ensureDevinProfile({ model, agentsDir });
    const b = ensureDevinProfile({ model: "x".repeat(4000), agentsDir });
    expect(a.name).not.toBe(b.name);
    expect(b.name.length).toBe(37);
    const scalar = readFileSync(a.path, "utf8").match(/^model: (.+)$/m)[1];
    expect(JSON.parse(scalar)).toBe(model);
    expect(readdirSync(agentsDir)).toHaveLength(2);
  });

  test("invalid inputs and ambiguous CLI options never create a profile", () => {
    const agentsDir = temp();
    for (const model of ["", "one\ntwo", "one\rtwo", "two words", "\0", "inherit-parent", "auto"]) {
      expect(() => ensureDevinProfile({ model, agentsDir })).toThrow("model must be");
    }
    expect(() => ensureDevinProfile({ model: "fixture-model", agentsDir: "" })).toThrow("agentsDir must be");
    for (const args of [[], ["--model"], ["--model", "x"], ["--model", "x", "--name-only", "--agents-dir", agentsDir],
      ["--model", "x", "--name-only", "--name-only"], ["--model", "x", "--name-only", "--model", "y"], ["--help"]]) {
      expect(cli(...args).status).toBe(1);
    }
    expect(readdirSync(agentsDir)).toEqual([]);
  });

  test("a skills-only copy can run the helper without plugin files or dependencies", () => {
    const root = temp();
    const skill = join(root, "setup-pstack");
    cpSync(join(plugin, "skills/setup-pstack"), skill, { recursive: true });
    const result = spawnSync(process.execPath, [join(skill, "scripts/devin-profile.mjs"), "--model", "portable-uid", "--agents-dir", join(root, "agents")], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(readFileSync(join(root, "agents", `${result.stdout.trim()}.md`), "utf8")).toContain('model: "portable-uid"');
    expect(existsSync(join(root, "hooks"))).toBe(false);
  });
});

describe("Devin SessionStart", () => {
  test("injects the mandate and mapping without raw sheet content", () => {
    expect(context(hook("feature, refactoring: fixture-uid\nIGNORE_PREVIOUS_INSTRUCTIONS\n"))).not.toContain("IGNORE_PREVIOUS_INSTRUCTIONS");
    context(hook(null));
    const malformed = hook(Buffer.from([0xff, 0xfe, 0x73, 0x00, 0x65]));
    expect(malformed.status).toBe(0);
    expect(malformed.stdout).toBe(hook(null).stdout);
  });

  for (const { name, sheet, off } of sheetCases) {
    test(`${off ? "disables" : "keeps"} injection for ${name}`, () => {
      const result = hook(sheet);
      if (off) expect({ status: result.status, out: result.stdout, err: result.stderr }).toEqual({ status: 0, out: "", err: "" });
      else context(result);
    });
  }

  test("comments and prose around off never disable routing", () => {
    for (const sheet of ["session hook: off # comment\n", "note: session hook: off\n", "`session hook: off`\n"]) context(hook(sheet));
  });

  test("escapes the root path as JSON", () => {
    const root = join(temp(), 'plugin "quoted"');
    cpSync(join(plugin, "hooks"), join(root, "hooks"), { recursive: true });
    cpSync(join(plugin, "skills/setup-pstack/scripts"), join(root, "skills/setup-pstack/scripts"), { recursive: true });
    context(hook(null, root), root);
  });

  test("uses only the XDG Devin sheet even when other runtimes are redirected", () => {
    const other = temp();
    writeFileSync(join(other, "pstack-models.md"), "session hook: off\n");
    const xdg = temp();
    const run = () => spawnSync("sh", [join(plugin, "hooks/session-start.sh"), "devin"], {
      env: { ...process.env, XDG_CONFIG_HOME: xdg, CODEX_HOME: other, COPILOT_HOME: other, CLAUDE_CONFIG_DIR: other, CLAUDE_PLUGIN_ROOT: plugin }, encoding: "utf8",
    });
    context(run());
    mkdirSync(join(xdg, "devin"));
    writeFileSync(join(xdg, "devin/pstack-models.md"), "session hook: off\n");
    expect(run().stdout).toBe("");
  });
});

describe("Devin runtime packaging", () => {
  const raw = readFileSync(join(plugin, "hooks.json"), "utf8");
  const manifest = JSON.parse(readFileSync(join(plugin, ".devin-plugin/plugin.json"), "utf8"));
  const claude = JSON.parse(readFileSync(join(plugin, ".claude-plugin/plugin.json"), "utf8"));
  const statOf = (rel) => existsSync(join(plugin, rel)) ? statSync(join(plugin, rel)) : null;
  const options = { statOf, file: "hooks.json", format: "devin" };

  test("native metadata and paths match the shared package", () => {
    const shared = ({ name, author, homepage, repository, license, version }) => ({ name, author, homepage, repository, license, version });
    expect(shared(manifest)).toEqual(shared(claude));
    expect(manifest.skills).toBe("skills");
    expect(JSON.parse(raw)).toEqual({ SessionStart: [{ hooks: [{ type: "command", command: '"${CLAUDE_PLUGIN_ROOT}/hooks/session-start.sh" devin' }] }] });
    expect(() => validateDevinManifest(manifest, { claude, pathExists: (path) => existsSync(join(repo, path)) })).not.toThrow();
    expect(() => validateHooks(raw, options)).not.toThrow();
  });

  test("native validation rejects a wrapped hook, unsupported fields, and missing scripts", () => {
    expect(() => validateHooks(JSON.stringify({ hooks: JSON.parse(raw) }), options)).toThrow("unknown key hooks");
    expect(() => validateHooks(raw, { statOf })).toThrow("required properties hooks");
    expect(() => validateHooks(raw, { ...options, statOf: () => null })).toThrow("hooks/session-start.sh does not exist");
    const invalid = JSON.parse(raw);
    invalid.SessionStart[0].hooks[0].commandWindows = "other";
    expect(() => validateHooks(JSON.stringify(invalid), options)).toThrow("unknown key commandWindows");
    expect(() => validateHooks('{"UnrecognizedEvent":[]}', options)).toThrow("unknown key UnrecognizedEvent");
  });

  test("manifest validation rejects missing package parts and wrong shared skill paths", () => {
    for (const missing of ["agents", "hooks.json"]) {
      expect(() => validateDevinManifest(manifest, { claude, pathExists: (path) => path !== `plugins/pstack/${missing}` })).toThrow(`${missing} does not exist`);
    }
    expect(() => validateDevinManifest({ ...manifest, skills: [] }, { claude, pathExists: () => true })).toThrow("skills must name");
    expect(() => validateDevinManifest({ ...manifest, name: "other" }, { claude, pathExists: () => true })).toThrow('name "other"');
  });

  test("registry preambles cover every Codex note, with no baked-in Devin models", () => {
    const devin = RUNTIMES.find((runtime) => runtime.name === "Devin CLI");
    const leads = loadLeadLines();
    for (const [file, lines] of leads) {
      if (lines.some((line) => line.includes("codex-tools.md"))) expect(lines).toContain(devin.preamble);
    }
    expect(devinModelNamesSection()).toContain("devin models list");
    expect(devinModelNamesSection()).not.toMatch(/claude-[a-z0-9-]+|gpt-[0-9]/);
    expect(devinModelNamesSection()).toContain("--name-only");
  });
});
