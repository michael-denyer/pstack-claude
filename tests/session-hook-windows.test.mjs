import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { MUSE_HOOKS } from "../tools/runtimes.mjs";
import { roleCases, sheetCases, writeSheet } from "./session-hook-sheets.mjs";

const pluginRoot = fileURLToPath(new URL("../plugins/pstack/", import.meta.url));
const manifest = JSON.parse(readFileSync(join(pluginRoot, ".codex-plugin/plugin.json"), "utf8"));
const handler = JSON.parse(readFileSync(join(pluginRoot, manifest.hooks), "utf8")).hooks.SessionStart[0].hooks[0];
const mandate = readFileSync(join(pluginRoot, "hooks/session-start-context.md"), "utf8");

function windowsHookEnv(fixture, profile) {
  const env = {
    SystemRoot: process.env.SystemRoot,
    PATH: join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0"),
    PATHEXT: process.env.PATHEXT,
    USERPROFILE: profile,
    HOME: join(fixture, "other home"),
    PSExecutionPolicyPreference: "Restricted",
  };
  for (const name of ["TEMP", "TMP", "LOCALAPPDATA", "APPDATA", "ProgramData", "PSModulePath"]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return env;
}

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
        writeSheet(join(dir, "pstack-models.md"), content);
      }
    }
    const contextPath = join(plugin, "hooks/session-start-context.md");
    if (context === null) rmSync(contextPath);
    else writeFileSync(contextPath, context);
    const command = handler.commandWindows.replaceAll("${CLAUDE_PLUGIN_ROOT}", plugin);
    const env = { ...windowsHookEnv(fixture, profile), CLAUDE_PLUGIN_ROOT: plugin };
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

// CI's Windows job sets this, so a platform check that misfires fails there
// instead of skipping every test.
const required = process.env.PSTACK_REQUIRE_WINDOWS_HOOK === "1";

describe.skipIf(process.platform !== "win32" && !required)("Windows Codex SessionStart hook", () => {
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

  for (const { name, sheet, off } of sheetCases) {
    test(`${off ? "injects nothing" : "injects the context"} when the sheet has ${name}`, () => {
      expect(runHook({ sheet })).toEqual({ status: 0, out: off ? "" : mandate, err: "" });
    });
  }

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

  for (const arg of ["cursor", ""]) {
    test(`fails on runtime argument ${JSON.stringify(arg)}`, () => {
      const script = join(pluginRoot, "hooks/session-start.ps1");
      const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, ...(arg ? [arg] : [])];
      const r = spawnSync("powershell.exe", args, { encoding: "utf8" });
      expect({ status: r.status, out: r.stdout, err: r.stderr.trimEnd() }).toEqual({
        status: 2,
        out: "",
        err: `session-start.ps1: unknown runtime '${arg}' (expected codex or muse)`,
      });
    });
  }
});

// Muse spawns the hook's argv itself, with no shell between, from the plugin
// root that the manifest's relative script path implies. This runner does the
// same, with only the PowerShell directory on PATH, the harness PATH shape
// that broke the sh hook on Windows.
const museCommand = MUSE_HOOKS.find((hook) => hook.id === "session-start-windows").command;
const museMandate = readFileSync(join(pluginRoot, "hooks/session-start-muse.md"), "utf8");
// The note as the hook prints it, line ending included: a Windows checkout
// may give it CRLF, which muse-context.awk keeps.
const museSheetNote = readFileSync(join(pluginRoot, "hooks/session-start-muse-sheet.md"), "utf8");

function runMuseHook({ sheet, xdg, context = museMandate, pluginRootEnv, omitUserProfile } = {}) {
  const fixture = mkdtempSync(join(tmpdir(), "pstack windows muse hook "));
  try {
    const plugin = join(fixture, "plugin with spaces");
    const profile = join(fixture, "user profile");
    const xdgRoot = join(fixture, "xdg config");
    cpSync(join(pluginRoot, "hooks"), join(plugin, "hooks"), { recursive: true });
    cpSync(join(pluginRoot, "models.json"), join(plugin, "models.json"));
    if (sheet !== undefined) {
      const dir = join(xdg ? xdgRoot : join(profile, ".config"), "muse");
      mkdirSync(dir, { recursive: true });
      writeSheet(join(dir, "pstack-models.md"), sheet);
    }
    const contextPath = join(plugin, "hooks/session-start-muse.md");
    if (context === null) rmSync(contextPath);
    else writeFileSync(contextPath, context);
    const env = { ...windowsHookEnv(fixture, profile), MUSE_PLUGIN_ROOT: pluginRootEnv ?? plugin };
    if (xdg) env.XDG_CONFIG_HOME = xdgRoot;
    if (omitUserProfile) delete env.USERPROFILE;
    const [program, ...args] = museCommand;
    const result = spawnSync(program, args, { cwd: plugin, env, encoding: "utf8" });
    if (result.error) throw result.error;
    return { status: result.status, out: result.stdout, err: result.stderr };
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

describe.skipIf(process.platform !== "win32" && !required)("Windows Muse SessionStart hook", () => {
  test("injects the Muse mandate without a sheet or sh", () => {
    expect(runMuseHook()).toEqual({ status: 0, out: museMandate, err: "" });
  });

  for (const { name, sheet, off } of sheetCases) {
    test(`${off ? "injects nothing" : "injects the mandate"} when the sheet has ${name}`, () => {
      const result = runMuseHook({ sheet });
      expect({ status: result.status, injected: result.out.startsWith(museMandate), err: result.err }).toEqual({
        status: 0,
        injected: !off,
        err: "",
      });
    });
  }

  for (const { name, sheet, roles } of roleCases) {
    test(`adds ${roles.length ? roles.join(", ") : "no role lines"} for a sheet with ${name}`, () => {
      const out = roles.length ? `${museMandate}\n${museSheetNote}${roles.join("\n")}\n` : museMandate;
      expect(runMuseHook({ sheet })).toEqual({ status: 0, out, err: "" });
    });
  }

  test("XDG_CONFIG_HOME moves the sheet, and USERPROFILE is the fallback", () => {
    expect(runMuseHook({ sheet: "session hook: off\n", xdg: true })).toEqual({ status: 0, out: "", err: "" });
    expect(runMuseHook({ sheet: "session hook: off\n" })).toEqual({ status: 0, out: "", err: "" });
  });

  test("finds the sheet without a USERPROFILE variable, as under Muse's hook environment", () => {
    expect(runMuseHook({ sheet: "session hook: off\n", xdg: true, omitUserProfile: true })).toEqual({
      status: 0,
      out: "",
      err: "",
    });
    expect(runMuseHook({ xdg: true, omitUserProfile: true })).toEqual({ status: 0, out: museMandate, err: "" });
  });

  test("injects nothing when Muse runs on Linux and interop reaches powershell.exe", () => {
    expect(runMuseHook({ pluginRootEnv: "/home/someone/.local/share/muse/plugins/cache/pstack/package" })).toEqual({
      status: 0,
      out: "",
      err: "",
    });
  });

  test("writes UTF-8 context and ends it with a newline, as the sh hook does", () => {
    const context = "Routing context: 中文 café 🚀";
    expect(runMuseHook({ context })).toEqual({ status: 0, out: `${context}\n`, err: "" });
  });

  test("fails when the mandate cannot be read", () => {
    const result = runMuseHook({ context: null });
    expect(result.status).not.toBe(0);
    expect(result.out).toBe("");
    expect(result.err).not.toBe("");
  });
});
