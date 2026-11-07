import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const sourceRoot = fileURLToPath(new URL("../plugins/pstack/", import.meta.url));
const manifest = JSON.parse(readFileSync(join(sourceRoot, "hooks/copilot-hooks.json"), "utf8"));
const hook = manifest.hooks.PreToolUse[0].hooks[0];
const allowed = '{"permissionDecision":"allow"}\n';
const fixture = mkdtempSync(join(tmpdir(), "pstack windows copilot pretool "));
const pluginRoot = join(fixture, "plugin with spaces");
const workspace = join(fixture, "work");
const home = join(fixture, "user profile");
const copilotHome = join(home, ".copilot");
const script = join(pluginRoot, "hooks", "pre-tool-use.ps1");
const commonScript = join(pluginRoot, "hooks", "pre-tool-use-compat.ps1");
const quiet = { status: 0, out: "", err: "" };
const models = JSON.parse(readFileSync(join(sourceRoot, "models.json"), "utf8"));

mkdirSync(workspace, { recursive: true });
mkdirSync(copilotHome, { recursive: true });
cpSync(join(sourceRoot, "hooks"), join(pluginRoot, "hooks"), { recursive: true });
cpSync(join(sourceRoot, "models.json"), join(pluginRoot, "models.json"));

const validSheet = `${models.roles.map(({ role, models: tier }) =>
  `${role}: ${tier === "panel" ? "gpt-5.5, claude-opus-5.5" : "gpt-5.5"}`).join("\n")}\ndefault effort: high\n`;
writeFileSync(join(copilotHome, "pstack-models.md"), validSheet);

afterAll(() => rmSync(fixture, { recursive: true, force: true }));

function run(input, extraEnv = {}, throughHost = false) {
  const command = (hook.powershell ?? hook.command).replaceAll("${COPILOT_PLUGIN_ROOT}", pluginRoot);
  const result = spawnSync("powershell.exe", [
    "-NoProfile", "-ExecutionPolicy", "Bypass", ...(throughHost ? ["-Command", command] : ["-File", script]),
  ], {
    cwd: workspace,
    env: {
      SystemRoot: process.env.SystemRoot,
      PATH: join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0"),
      PATHEXT: process.env.PATHEXT,
      USERPROFILE: home,
      HOME: home,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      COPILOT_HOME: copilotHome,
      COPILOT_PLUGIN_ROOT: pluginRoot,
      ...extraEnv,
    },
    input,
    encoding: "utf8",
  });
  return {
    status: result.status,
    out: result.stdout,
    err: result.stderr,
  };
}

const payload = (tool_name, tool_input, cwd = workspace) =>
  JSON.stringify({ hook_event_name: "PreToolUse", cwd, tool_name, tool_input });
const batchPayload = (toolCalls, cwd = workspace) => JSON.stringify({ cwd, toolCalls });

describe.skipIf(process.platform !== "win32")("Windows Copilot PreToolUse hook", () => {
  test("runs the shipped command through the Copilot plugin root", () => {
    const file = join(pluginRoot, "hooks", "session-start-copilot.md");
    expect(run(payload("Read", { path: file }), {}, true)).toEqual({ status: 0, out: allowed, err: "" });
  });

  test("allows plugin files with Windows paths and a plugin root containing spaces", () => {
    const file = join(pluginRoot, "hooks", "session-start-copilot.md");
    expect(run(payload("Read", { path: file }))).toEqual({ status: 0, out: allowed, err: "" });
    expect(run(payload("Read", { path: file.toUpperCase() })).out).toBe(allowed);
  });

  test("does not allow paths outside the plugin or with ambiguous segments", () => {
    const outside = join(fixture, "plugin with spaces-evil", "secret.md");
    const inputs = [
      payload("Read", { path: outside }),
      payload("Read", { path: join(pluginRoot, "..", "private.md") }),
      payload("Read", { path: "hooks/session-start-copilot.md" }),
      payload("Read", { path: pluginRoot }),
      payload("Read", { path: `${pluginRoot}x\\file.md` }),
      payload("Edit", { path: join(pluginRoot, "hooks", "session-start-copilot.md") }),
    ];
    for (const input of inputs) expect(run(input)).toEqual(quiet);
  });

  test("does not follow a junction out of the plugin", () => {
    const outside = join(fixture, "outside");
    const junction = join(pluginRoot, "linked-outside");
    mkdirSync(outside);
    symlinkSync(outside, junction, "junction");
    try {
      expect(run(payload("Read", { path: join(junction, "secret.md") }))).toEqual(quiet);
    } finally {
      rmSync(junction, { force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("keeps drive and UNC containment at path-segment boundaries", () => {
    const command = `. '${commonScript}'; @(
      (Test-WithinPath 'C:\\plugins\\pstack\\hooks\\file.md' 'C:\\plugins\\pstack' -Strict),
      (Test-WithinPath 'C:\\plugins\\pstack-evil\\file.md' 'C:\\plugins\\pstack' -Strict),
      (Test-WithinPath '\\\\server\\share\\pstack\\hooks\\file.md' '\\\\server\\share\\pstack' -Strict),
      (Test-WithinPath '\\\\server\\share\\pstack-evil\\file.md' '\\\\server\\share\\pstack' -Strict),
      (Test-WithinPath 'D:\\plugins\\pstack\\file.md' 'C:\\plugins\\pstack' -Strict)
    ) -join ','`;
    const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command], {
      encoding: "utf8",
    });
    expect({ status: result.status, out: result.stdout.trim(), err: result.stderr }).toEqual({
      status: 0,
      out: "True,False,True,False,False",
      err: "",
    });
  });

  test("denies only a pstack agent model absent from a fully valid sheet", () => {
    const agent = (model) => payload("Agent", { agent_type: "pstack:poteto-agent", model });
    const denied = run(agent("claude-haiku-4.5"));
    expect(denied.status).toBe(0);
    expect(JSON.parse(denied.out)).toMatchObject({ permissionDecision: "deny" });
    expect(denied.out).toContain("one of `gpt-5.5`, `claude-opus-5.5`");
    expect(run(agent("gpt-5.5"))).toEqual(quiet);
    expect(run(payload("Agent", { agent_type: "general-purpose", model: "claude-haiku-4.5" }))).toEqual(quiet);
    expect(run(payload("Agent", { agent_type: "pstack:poteto-agent" }))).toEqual(quiet);
  });

  test("handles batched tool calls without allowing unrecognized calls", () => {
    const file = join(pluginRoot, "hooks", "session-start-copilot.md");
    const agent = { name: "Agent", args: { agent_type: "pstack:poteto-agent", model: "off-sheet" } };
    const denied = run(batchPayload([agent]));
    expect(denied.status).toBe(0);
    expect(JSON.parse(denied.out)).toMatchObject({ permissionDecision: "deny" });
    expect(run(batchPayload([{ name: "Read", args: { path: file } }])).out).toBe(allowed);
    expect(run(batchPayload([{ name: "Read", args: { path: file } }, { name: "Unknown", args: {} }]))).toEqual(quiet);
    expect(run(batchPayload([{ name: "Unknown", args: {} }, agent])).out).toContain('"permissionDecision":"deny"');
  });

  test("keeps malformed sheets and non-ASCII model escapes out of the decision", () => {
    const sheetPath = join(copilotHome, "pstack-models.md");
    try {
      writeFileSync(sheetPath, "bug-fix: gpt-5.5\n");
      expect(run(payload("Agent", { agent_type: "pstack:poteto-agent", model: "o9" }))).toEqual(quiet);
      writeFileSync(sheetPath, validSheet);
      const escaped = '{"cwd":"' + workspace.replaceAll("\\", "\\\\") +
        '","tool_name":"Agent","tool_input":{"agent_type":"pstack:poteto-agent","model":"claude-\\u00e9"}}';
      expect(run(escaped)).toEqual(quiet);
      const metadata = payload("Read", { path: join(pluginRoot, "hooks", "session-start-copilot.md") })
        .replace('"hook_event_name":', '"metadata":"\\u00e9","hook_event_name":');
      expect(run(metadata).out).toBe(allowed);
      const duplicate = `{"cwd":"${workspace.replaceAll("\\", "\\\\")}","tool_name":"Read","tool_name":"Read","tool_input":{"path":"${pluginRoot.replaceAll("\\", "\\\\")}\\\\hooks\\\\session-start-copilot.md"}}`;
      expect(run(duplicate)).toEqual(quiet);
    } finally {
      writeFileSync(sheetPath, validSheet);
    }
  });

  test("checks valid UTF-8 and UTF-16LE BOM/CRLF sheets the same way", () => {
    const sheetPath = join(copilotHome, "pstack-models.md");
    try {
      for (const encoding of ["utf8", "utf16le"]) {
        const text = `\uFEFF${validSheet.replaceAll("\n", "\r\n")}`;
        writeFileSync(sheetPath, Buffer.from(text, encoding));
        const result = run(payload("Agent", { agent_type: "pstack:poteto-agent", model: "off-sheet" }));
        expect(result.status).toBe(0);
        expect(JSON.parse(result.out).permissionDecision).toBe("deny");
      }
    } finally {
      writeFileSync(sheetPath, validSheet);
    }
  });

  test("allows only registered vendored-script forms with workspace paths", () => {
    const logScript = join(pluginRoot, "skills", "show-me-your-work", "scripts", "log.sh");
    const runLog = (command) => payload("Bash", { command, description: "fixture" });
    expect(run(runLog(`bash '${logScript}' decisions.tsv review decision why evidence result`))).toEqual({
      status: 0,
      out: allowed,
      err: "",
    });
    expect(run(runLog(`sh '${logScript}' decisions.tsv review decision why evidence result`))).toEqual(quiet);
    expect(run(runLog(`bash '${logScript}' ../../outside.tsv review decision why evidence result`))).toEqual(quiet);
    expect(run(runLog(`bash '${logScript}' decisions.tsv review decision why evidence result; whoami`))).toEqual(quiet);
  });
});
