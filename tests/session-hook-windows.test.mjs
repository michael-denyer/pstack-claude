import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = fileURLToPath(new URL("../plugins/pstack/", import.meta.url));
const manifest = JSON.parse(readFileSync(join(pluginRoot, ".codex-plugin/plugin.json"), "utf8"));
const handler = JSON.parse(readFileSync(join(pluginRoot, manifest.hooks), "utf8")).hooks.SessionStart[0].hooks[0];
const mandate = readFileSync(join(pluginRoot, "hooks/session-start-context.md"), "utf8");

function runHook({ sheet, codexHome, homeSheet, context = mandate, host = "cmd" } = {}) {
  const fixture = mkdtempSync(join(tmpdir(), "pstack windows hook "));
  try {
    const plugin = join(fixture, "plugin with spaces");
    const profile = join(fixture, "user profile");
    const sheetRoot = codexHome ? join(fixture, "codex home") : join(profile, ".codex");
    cpSync(join(pluginRoot, "hooks"), join(plugin, "hooks"), { recursive: true });
    for (const [dir, content] of [[join(profile, ".codex"), homeSheet], [sheetRoot, sheet]]) {
      if (content !== undefined) {
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "pstack-models.md"), content);
      }
    }
    const contextPath = join(plugin, "hooks/session-start-context.md");
    if (context === null) rmSync(contextPath);
    else writeFileSync(contextPath, context);
    const command = (handler.commandWindows ?? handler.command).replaceAll("${CLAUDE_PLUGIN_ROOT}", plugin);
    const env = {
      SystemRoot: process.env.SystemRoot,
      PATH: join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0"),
      PATHEXT: process.env.PATHEXT,
      USERPROFILE: profile,
      HOME: join(fixture, "other home"),
      CLAUDE_PLUGIN_ROOT: plugin,
      PSExecutionPolicyPreference: "Restricted",
    };
    if (codexHome !== undefined) env.CODEX_HOME = codexHome ? sheetRoot : "";
    const executable = host === "cmd" ? process.env.ComSpec ?? "cmd.exe" : "powershell.exe";
    const args = host === "cmd" ? ["/d", "/s", "/c", command] : ["-NoProfile", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")];
    const result = spawnSync(executable, args, {
      env,
      encoding: "utf8",
      windowsVerbatimArguments: host === "cmd",
    });
    if (result.error) throw result.error;
    return { status: result.status, out: result.stdout, err: result.stderr };
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

describe.skipIf(process.platform !== "win32")("Windows Codex SessionStart hook", () => {
  test("injects the shared context without a sheet or Bash", () => {
    expect(runHook()).toEqual({ status: 0, out: mandate, err: "" });
    const result = runHook({ host: "powershell" });
    expect({ ...result, out: result.out.replaceAll("\r\n", "\n") }).toEqual({ status: 0, out: mandate.replaceAll("\r\n", "\n"), err: "" });
  });

  test("reads USERPROFILE when CODEX_HOME is absent or empty", () => {
    for (const codexHome of [undefined, false]) {
      expect(runHook({ codexHome, sheet: "session hook: off\n" })).toEqual({ status: 0, out: "", err: "" });
    }
  });

  test("CODEX_HOME takes precedence over USERPROFILE", () => {
    expect(runHook({ codexHome: true, sheet: "session hook: off\r\n", homeSheet: "session hook: on\n" })).toEqual({
      status: 0, out: "", err: "",
    });
    expect(runHook({ codexHome: true, sheet: "session hook: on\n", homeSheet: "session hook: off\n" })).toEqual({
      status: 0, out: mandate, err: "",
    });
  });

  test("only an exact off line disables injection", () => {
    for (const sheet of ["session hook: off", "bug-fix: model\nsession hook: off\n", "session hook: off\r\n"]) {
      expect(runHook({ sheet })).toEqual({ status: 0, out: "", err: "" });
    }
    const sheet = ["Session hook: off", "session hook: OFF", " session hook: off", "session hook: off ", "session hook: offline"].join("\n");
    expect(runHook({ sheet })).toEqual({ status: 0, out: mandate, err: "" });
  });

  test("writes UTF-8 context without an added newline", () => {
    const context = "Routing context: 中文 café 🚀";
    expect(runHook({ context })).toEqual({ status: 0, out: context, err: "" });
  });

  test("fails when the context cannot be read", () => {
    const result = runHook({ context: null });
    expect(result.status).not.toBe(0);
    expect(result.out).toBe("");
    expect(result.err).not.toBe("");
  });
});
