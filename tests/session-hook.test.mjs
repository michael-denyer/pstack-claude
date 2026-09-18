// The shipped SessionStart command, run for real with each runtime's environment:
// the mandate is injected unless that runtime's model sheet turns it off.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = fileURLToPath(new URL("../plugins/pstack/", import.meta.url));
const sessionStart = JSON.parse(readFileSync(join(pluginRoot, "hooks/hooks.json"), "utf8")).hooks.SessionStart[0];
const command = sessionStart.hooks[0].command;
const mandate = readFileSync(join(pluginRoot, "hooks/session-start-context.md"), "utf8");
const codexManifest = JSON.parse(readFileSync(join(pluginRoot, ".codex-plugin/plugin.json"), "utf8"));

// Codex sets PLUGIN_ROOT; CODEX_HOME is only present when the user has
// relocated their Codex directory.
const runtimes = {
  claude: { sheetDir: ".claude", env: () => ({}) },
  codex: { sheetDir: ".codex", env: () => ({ PLUGIN_ROOT: pluginRoot }) },
  "codex with CODEX_HOME": {
    sheetDir: "codex-home",
    env: (sheetRoot) => ({ PLUGIN_ROOT: pluginRoot, CODEX_HOME: sheetRoot }),
  },
};

function runHook(runtime, sheet) {
  const home = mkdtempSync(join(tmpdir(), "pstack-hook-"));
  const { sheetDir, env } = runtimes[runtime];
  const sheetRoot = join(home, sheetDir);
  if (sheet !== null) {
    mkdirSync(sheetRoot);
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
  // The manifest names the shared hooks file instead of relying on Codex's
  // default discovery; `resume` keeps the mandate present after a restart.
  test("declares the hook in the Codex manifest", () => {
    expect(codexManifest.hooks).toBe("./hooks/hooks.json");
    expect(sessionStart.matcher).toBe("startup|resume|clear|compact");
  });

  for (const runtime of Object.keys(runtimes)) {
    describe(runtime, () => {
      test("injects the mandate when no sheet exists", () => {
        expect(runHook(runtime, null)).toEqual({ status: 0, out: mandate, err: "" });
      });

      test("injects the mandate when the sheet has no session hook line", () => {
        expect(runHook(runtime, "bug-fix: configured-model\n")).toEqual({ status: 0, out: mandate, err: "" });
      });

      test("injects the mandate when the sheet says on", () => {
        expect(runHook(runtime, "bug-fix: configured-model\nsession hook: on\n")).toEqual({
          status: 0,
          out: mandate,
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
