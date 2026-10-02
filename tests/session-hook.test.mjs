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
const copilotContext = readFileSync(join(pluginRoot, "hooks/session-start-context.json"), "utf8");
const copilotNoSheet = readFileSync(join(pluginRoot, "hooks/session-start-context-nosheet.json"), "utf8");
const marker = "@PSTACK_SAVED_MODEL_CHOICES@";
const savedChoicesLead = "These are the user's saved pstack model choices";
const codexManifest = JSON.parse(readFileSync(join(pluginRoot, ".codex-plugin/plugin.json"), "utf8"));

// Claude Code loads hooks/hooks.json by convention; Codex loads the file its manifest names.
const sessionStart = Object.fromEntries(
  Object.entries({ claude: "hooks/hooks.json", codex: codexManifest.hooks }).map(([runtime, file]) => [
    runtime,
    JSON.parse(readFileSync(join(pluginRoot, file), "utf8")).hooks.SessionStart[0],
  ]),
);

// The stamped template with the marker replaced by the sheet's role lines,
// escaped the way JSON.stringify escapes printable text.
const withChoices = (lines) => copilotContext.replace(marker, JSON.stringify(lines.join("\n")).slice(1, -1));

// GitHub Copilot reads hooks/hooks.json, sets every plugin-root variable plus
// COPILOT_PLUGIN_ROOT, and sets COPILOT_HOME only when the user relocated
// ~/.copilot.
const copilotEnv = () => ({ PLUGIN_ROOT: pluginRoot, COPILOT_PLUGIN_ROOT: pluginRoot, COPILOT_CLI: "1" });

// CODEX_HOME and CLAUDE_CONFIG_DIR are only present when the user has
// relocated that runtime's directory. PLUGIN_ROOT is a generic name any shell
// profile may export, so it must not move a Claude Code session to Codex's sheet.
const runtimes = {
  claude: { hooks: "claude", sheetDir: ".claude", env: () => ({}), out: () => mandate, noSheet: mandate },
  "claude with CLAUDE_CONFIG_DIR": {
    hooks: "claude",
    sheetDir: "claude-config",
    env: (sheetRoot) => ({ CLAUDE_CONFIG_DIR: sheetRoot }),
    out: () => mandate,
    noSheet: mandate,
  },
  "claude with PLUGIN_ROOT exported": { hooks: "claude", sheetDir: ".claude", env: () => ({ PLUGIN_ROOT: pluginRoot }), out: () => mandate, noSheet: mandate },
  codex: { hooks: "codex", sheetDir: ".codex", env: () => ({}), out: () => mandate, noSheet: mandate },
  "codex with CODEX_HOME": {
    hooks: "codex",
    sheetDir: "codex-home",
    env: (sheetRoot) => ({ CODEX_HOME: sheetRoot }),
    out: () => mandate,
    noSheet: mandate,
  },
  // With no sheet yet, Copilot also gets the setup-first line; with a sheet,
  // it gets the sheet's role lines so the session never reads the sheet.
  copilot: { hooks: "claude", sheetDir: ".copilot", env: copilotEnv, out: withChoices, noSheet: copilotNoSheet },
  "copilot with COPILOT_HOME": {
    hooks: "claude",
    sheetDir: "copilot-home",
    env: (sheetRoot) => ({ ...copilotEnv(), COPILOT_HOME: sheetRoot }),
    out: withChoices,
    noSheet: copilotNoSheet,
  },
};

function runHook(runtime, sheet, command = sessionStart[runtimes[runtime].hooks].hooks[0].command) {
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
      expect(r.err.trimEnd().split("\n")).toEqual([`session-start.sh: unknown runtime '${arg}' (expected claude or codex)`]);
    });
  }

  for (const runtime of Object.keys(runtimes)) {
    describe(runtime, () => {
      test("injects the mandate when no sheet exists", () => {
        expect(runHook(runtime, null)).toEqual({ status: 0, out: runtimes[runtime].noSheet, err: "" });
      });

      test("injects the mandate when the sheet has no session hook line", () => {
        expect(runHook(runtime, "bug-fix: configured-model\n")).toEqual({
          status: 0,
          out: runtimes[runtime].out(["bug-fix: configured-model"]),
          err: "",
        });
      });

      test("injects the mandate when the sheet says on", () => {
        expect(runHook(runtime, "bug-fix: configured-model\nsession hook: on\n")).toEqual({
          status: 0,
          out: runtimes[runtime].out(["bug-fix: configured-model"]),
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

  // Copilot parses the hook's stdout with one JSON.parse and reads
  // additionalContext; plain text is dropped.
  test("Copilot output is one JSON object carrying the mandate and the Copilot addendum", () => {
    for (const sheet of [null, "session hook: on\n"]) {
      const { out } = runHook("copilot", sheet);
      const parsed = JSON.parse(out);
      expect(Object.keys(parsed)).toEqual(["additionalContext"]);
      const close = "</EXTREMELY_IMPORTANT>";
      const body = mandate.slice(0, mandate.indexOf(close));
      expect(parsed.additionalContext.startsWith(body)).toBe(true);
      expect(parsed.additionalContext).toContain("On GitHub Copilot, load pstack skills by their bare names");
      expect(parsed.additionalContext.trimEnd().endsWith(close)).toBe(true);
      const setupFirst = "This Copilot home has no pstack model sheet yet";
      if (sheet === null) expect(parsed.additionalContext).toContain(setupFirst);
      else expect(parsed.additionalContext).not.toContain(setupFirst);
    }
  });

  const choices = (sheet) => JSON.parse(runHook("copilot", sheet).out).additionalContext;
  const injected = (sheet) => {
    const context = choices(sheet);
    const start = context.indexOf(savedChoicesLead);
    expect(start).toBeGreaterThan(-1);
    const block = context.slice(start);
    return block.slice(block.indexOf("\n\n") + 2, block.lastIndexOf("\n</EXTREMELY_IMPORTANT>"));
  };

  test("the stamped Copilot template carries exactly one saved-choices marker", () => {
    expect(copilotContext.split(marker).length).toBe(2);
    expect(copilotNoSheet).not.toContain(marker);
    expect(copilotNoSheet).not.toContain(savedChoicesLead);
    expect(runHook("copilot", "arena runners: a\n").out).not.toContain(marker);
  });

  test("Copilot escapes quotes, backslashes, tabs, and CRLF, and drops other control characters", () => {
    const sheet = [
      "# pstack models",
      "",
      'arena runners: "claude-sonnet-5", gpt-5.5\r',
      "interrogate reviewers:\tgemini-3.8-flash\\x",
      "bug-fix: kimi-k3\u0001\u001b[31m\u007f done — ok",
      "  indented: ignored",
      "prose line without a role",
      "session hook: on",
      "",
    ].join("\n");
    const out = runHook("copilot", sheet);
    expect(out.err).toBe("");
    expect(out.status).toBe(0);
    expect(injected(sheet)).toBe(
      ['arena runners: "claude-sonnet-5", gpt-5.5', "interrogate reviewers:\tgemini-3.8-flash\\x", "bug-fix: kimi-k3[31m done — ok"].join("\n"),
    );
    expect(Object.keys(JSON.parse(out.out))).toEqual(["additionalContext"]);
  });

  test("Copilot keeps a sheet with no role lines valid and says so", () => {
    expect(injected("# only a heading\nsession hook: on\n")).toBe("(no role lines: every role omits `model`)");
    expect(injected("")).toBe("(no role lines: every role omits `model`)");
  });

  test("Copilot caps the injected sheet and says it was truncated", () => {
    const line = (i) => `role ${i}: ${"m".repeat(90)}`;
    const big = Array.from({ length: 200 }, (_, i) => line(i)).join("\n");
    const text = injected(big);
    expect(Buffer.byteLength(text)).toBeLessThan(4096 + 200);
    expect(text.startsWith(`${line(0)}\n`)).toBe(true);
    expect(text).not.toContain(line(199));
    expect(text.endsWith("(truncated: the sheet has more than the plugin hook injects; view it for the rest)")).toBe(true);
    const huge = `${"# ".repeat(40000)}\nrole x: y\n`;
    expect(injected(huge)).toContain("(truncated:");
  });

  test("Copilot injects nothing for an off sheet even with role lines", () => {
    expect(runHook("copilot", 'arena runners: "a"\nsession hook: off\n')).toEqual({ status: 0, out: "", err: "" });
  });

  test("each runtime reads only its own sheet", () => {
    const home = mkdtempSync(join(tmpdir(), "pstack-hook-"));
    try {
      for (const dir of [".claude", ".codex"]) {
        mkdirSync(join(home, dir));
        writeFileSync(join(home, dir, "pstack-models.md"), "session hook: off\n");
      }
      const run = (runtime, env) =>
        spawnSync("sh", ["-c", sessionStart[runtime].hooks[0].command], {
          env: { PATH: process.env.PATH, HOME: home, CLAUDE_PLUGIN_ROOT: pluginRoot, ...env },
          encoding: "utf8",
        }).stdout;
      expect(run("claude", copilotEnv())).toBe(copilotNoSheet);
      rmSync(join(home, ".claude"), { recursive: true });
      rmSync(join(home, ".codex"), { recursive: true });
      mkdirSync(join(home, ".copilot"));
      writeFileSync(join(home, ".copilot", "pstack-models.md"), "session hook: off\n");
      expect(run("claude", {})).toBe(mandate);
      expect(run("claude", { PLUGIN_ROOT: pluginRoot })).toBe(mandate);
      expect(run("codex", {})).toBe(mandate);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
