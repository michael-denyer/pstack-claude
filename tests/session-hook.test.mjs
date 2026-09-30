// Each runtime's shipped SessionStart command, run for real: the mandate is
// injected unless that runtime's model sheet turns it off.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { agentSkills } from "../tools/generate.mjs";

const pluginRoot = fileURLToPath(new URL("../plugins/pstack/", import.meta.url));
const mandate = readFileSync(join(pluginRoot, "hooks/session-start-context.md"), "utf8");
const piMandate = mandate.replace(/`pstack:/g, "`");
const codexManifest = JSON.parse(readFileSync(join(pluginRoot, ".codex-plugin/plugin.json"), "utf8"));

// Claude Code loads hooks/hooks.json by convention; Codex loads the file its manifest names.
const sessionStart = Object.fromEntries(
  Object.entries({ claude: "hooks/hooks.json", codex: codexManifest.hooks }).map(([runtime, file]) => [
    runtime,
    JSON.parse(readFileSync(join(pluginRoot, file), "utf8")).hooks.SessionStart[0],
  ]),
);

// CODEX_HOME and CLAUDE_CONFIG_DIR are only present when the user has
// relocated that runtime's directory. PLUGIN_ROOT is a generic name any shell
// profile may export, so it must not move a Claude Code session to Codex's sheet.
const piCommand = `"\${CLAUDE_PLUGIN_ROOT}/hooks/session-start.sh" pi`;

const runtimes = {
  claude: { hooks: "claude", sheetDir: ".claude", env: () => ({}) },
  "claude with CLAUDE_CONFIG_DIR": {
    hooks: "claude",
    sheetDir: "claude-config",
    env: (sheetRoot) => ({ CLAUDE_CONFIG_DIR: sheetRoot }),
  },
  "claude with PLUGIN_ROOT exported": { hooks: "claude", sheetDir: ".claude", env: () => ({ PLUGIN_ROOT: pluginRoot }) },
  codex: { hooks: "codex", sheetDir: ".codex", env: () => ({}) },
  "codex with CODEX_HOME": {
    hooks: "codex",
    sheetDir: "codex-home",
    env: (sheetRoot) => ({ CODEX_HOME: sheetRoot }),
  },
  pi: { hooks: null, sheetDir: ".pi/agent", env: () => ({}), command: piCommand },
  "pi with PI_CODING_AGENT_DIR": {
    hooks: null,
    sheetDir: "pi-agent",
    env: (sheetRoot) => ({ PI_CODING_AGENT_DIR: sheetRoot }),
    command: piCommand,
  },
};

function runHook(runtime, sheet, command = runtimes[runtime].command ?? sessionStart[runtimes[runtime].hooks].hooks[0].command) {
  const home = mkdtempSync(join(tmpdir(), "pstack-hook-"));
  const { sheetDir, env } = runtimes[runtime];
  const sheetRoot = join(home, sheetDir);
  if (sheet !== null) {
    mkdirSync(sheetRoot, { recursive: true });
    writeFileSync(join(sheetRoot, "pstack-models.md"), sheet);
  }
  try {
    const r = spawnSync("sh", ["-c", command], {
      env: { PATH: process.env.PATH, HOME: home, CLAUDE_PLUGIN_ROOT: pluginRoot, ...env(sheetRoot) },
      encoding: "utf8",
    });
    return { status: r.status, out: r.stdout, err: r.stderr };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

describe("SessionStart hook", () => {
  // The manifest names Codex's own hooks file instead of relying on Codex's
  // default discovery; `resume` keeps the mandate present after a restart.
  test("declares the hook in the Codex manifest", () => {
    expect(codexManifest.hooks).toBe("./hooks/codex-hooks.json");
    expect(sessionStart.claude.matcher).toBe("startup|resume|clear|compact");
    expect(sessionStart.codex.matcher).toBe("startup|resume|clear|compact");
  });

  test("names only skills that exist", () => {
    const named = [...mandate.matchAll(/(?:pstack:|`\/)([a-z0-9-]+)/g)].map((m) => m[1]);
    const skills = new Set(agentSkills(join(pluginRoot, "skills")).map(({ name }) => name));
    expect(named).toContain("poteto-mode");
    expect(named.filter((name) => !skills.has(name))).toEqual([]);
  });

  for (const arg of ["cursor", ""]) {
    test(`fails on runtime argument ${JSON.stringify(arg)}`, () => {
      const r = runHook("claude", null, `"\${CLAUDE_PLUGIN_ROOT}/hooks/session-start.sh" ${arg}`);
      expect(r.status).not.toBe(0);
      expect(r.out).toBe("");
      expect(r.err.trimEnd().split("\n")).toEqual([`session-start.sh: unknown runtime '${arg}' (expected claude, codex, or pi)`]);
    });
  }

  for (const runtime of Object.keys(runtimes)) {
    const expected = runtime.startsWith("pi") ? piMandate : mandate;
    describe(runtime, () => {
      test("injects the mandate when no sheet exists", () => {
        expect(runHook(runtime, null)).toEqual({ status: 0, out: expected, err: "" });
      });

      test("injects the mandate when the sheet has no session hook line", () => {
        expect(runHook(runtime, "bug-fix: configured-model\n")).toEqual({ status: 0, out: expected, err: "" });
      });

      test("injects the mandate when the sheet says on", () => {
        expect(runHook(runtime, "bug-fix: configured-model\nsession hook: on\n")).toEqual({
          status: 0,
          out: expected,
          err: "",
        });
      });

      test("injects nothing when the sheet says off", () => {
        expect(runHook(runtime, "bug-fix: configured-model\nsession hook: off\n")).toEqual({
          status: 0,
          out: "",
          err: "",
        });
      });
    });
  }
});
