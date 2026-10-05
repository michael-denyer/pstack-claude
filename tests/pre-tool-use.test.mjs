// The shipped GitHub Copilot PreToolUse command, run for real. It approves
// `view` of the plugin's own files and strict vendored-script runs, denies
// pstack agents on models a valid sheet does not name, and stays silent for
// everything else.
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = fileURLToPath(new URL("../plugins/pstack/", import.meta.url));
const preToolUse = JSON.parse(readFileSync(join(pluginRoot, "hooks/copilot-hooks.json"), "utf8")).hooks.PreToolUse;
const command = preToolUse[0].hooks[0].command;
const allow = '{"permissionDecision":"allow"}\n';
const playbook = join(pluginRoot, "skills/poteto-mode/playbooks/bug-fix.md");

// Copilot sends Claude-format input to PascalCase hooks (observed on Copilot
// CLI 1.0.89): tool_name is the Claude name, so `view` arrives as `Read`.
const claudeInput = (tool, path) =>
  JSON.stringify({ hook_event_name: "PreToolUse", cwd: "/work", tool_name: tool, tool_input: { path } });

function run(input, env = { COPILOT_PLUGIN_ROOT: pluginRoot }) {
  const r = spawnSync("sh", ["-c", command], {
    input,
    env: { PATH: process.env.PATH, ...env },
    encoding: "utf8",
  });
  return { status: r.status, out: r.stdout, err: r.stderr };
}

describe("PreToolUse hook", () => {
  test("matches only the tools it decides", () => {
    expect(preToolUse).toHaveLength(1);
    expect(preToolUse[0].matcher).toBe("view|task|bash");
  });

  test("approves view inside the plugin root", () => {
    expect(run(claudeInput("Read", playbook))).toEqual({ status: 0, out: allow, err: "" });
    expect(run(JSON.stringify({ toolName: "view", toolArgs: { path: playbook } }))).toEqual({ status: 0, out: allow, err: "" });
  });

  test("keeps literal dotted keys separate from nested hook arguments", () => {
    for (const [name, args] of [["tool_name", "tool_input"], ["toolName", "toolArgs"]]) {
      const payload = { [name]: "Read", [args]: { path: "/outside/private.txt" }, [`${args}.path`]: playbook };
      expect(run(JSON.stringify(payload))).toEqual({ status: 0, out: "", err: "" });
      payload[args].path = playbook;
      payload[`${args}.path`] = "/outside/private.txt";
      expect(run(JSON.stringify(payload)).out).toBe(allow);
    }
  });

  test("accepts unrelated nested metadata without treating it as tool arguments", () => {
    const payload = JSON.parse(claudeInput("Read", playbook));
    payload.metadata = [{ "tool_input.path": "/outside", "a/b": true, "a~b": null }, [0, -1.25e3, "text"]];
    expect(run(JSON.stringify(payload)).out).toBe(allow);
    for (const tool_input of [null, [payload.tool_input], "not an object"]) {
      expect(run(JSON.stringify({ ...payload, tool_input }))).toEqual({ status: 0, out: "", err: "" });
    }
  });

  test.each([
    ["trailing garbage", (s) => s + " garbage"],
    ["an incomplete exponent", (s) => s.slice(0, -1) + ',"extra":1e+}'],
    ["a leading-zero number", (s) => s.slice(0, -1) + ',"extra":01}'],
    ["an invalid escape", (s) => s.slice(0, -1) + ',"extra":"\\q"}'],
    ["a raw control character", (s) => s.slice(0, -1) + ',"extra":"a\tb"}'],
    ["duplicate arguments", (s) => s.slice(0, -1) + ',"tool_input":null}'],
  ])("stays silent for %s in the JSON envelope", (_name, corrupt) => {
    expect(run(corrupt(claudeInput("Read", playbook)))).toEqual({ status: 0, out: "", err: "" });
  });

  test("approves through the real path when the root is a symlink", () => {
    const dir = mkdtempSync(join(tmpdir(), "pstack-ptu-"));
    try {
      const link = join(dir, "pstack");
      symlinkSync(pluginRoot, link);
      const env = { COPILOT_PLUGIN_ROOT: link };
      expect(run(claudeInput("Read", join(link, "skills/how/SKILL.md")), env).out).toBe(allow);
      expect(run(claudeInput("Read", join(realpathSync(pluginRoot), "skills/how/SKILL.md")), env).out).toBe(allow);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const silent = {
    "a path that climbs out with ..": claudeInput("Read", join(pluginRoot, "../../../etc/passwd")),
    "a path with a . segment": claudeInput("Read", `${pluginRoot}./skills/how/SKILL.md`),
    "a path outside the plugin": claudeInput("Read", "/etc/passwd"),
    "a sibling directory sharing the prefix": claudeInput("Read", `${pluginRoot.replace(/\/$/, "")}-evil/x.md`),
    "the plugin root itself": claudeInput("Read", pluginRoot.replace(/\/$/, "")),
    "an empty path": claudeInput("Read", ""),
    "a quoted path": claudeInput("Read", `${pluginRoot}x"y.md`),
    "another tool": claudeInput("Bash", playbook),
    "an edit inside the plugin": claudeInput("Edit", playbook),
    "input that is not JSON": "not json",
    "empty input": "",
  };
  for (const [name, input] of Object.entries(silent)) {
    test(`stays silent and exits 0 for ${name}`, () => {
      expect(run(input)).toEqual({ status: 0, out: "", err: "" });
    });
  }

  // Copilot denies the call when the hook exits non-zero.
  test("exits 0 with no decision and reports the error when awk fails", () => {
    const bin = mkdtempSync(join(tmpdir(), "pstack-ptu-bin-"));
    try {
      writeFileSync(join(bin, "awk"), "#!/bin/sh\necho 'awk: broken' >&2\nexit 2\n", { mode: 0o755 });
      const r = spawnSync("sh", ["-c", command], {
        input: claudeInput("Read", playbook),
        env: { PATH: `${bin}:${process.env.PATH}`, COPILOT_PLUGIN_ROOT: pluginRoot },
        encoding: "utf8",
      });
      expect({ status: r.status, out: r.stdout, err: r.stderr }).toEqual({ status: 0, out: "", err: "awk: broken\n" });
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });

  test("drops a decision from an awk run that fails", () => {
    const bin = mkdtempSync(join(tmpdir(), "pstack-ptu-bin-"));
    try {
      writeFileSync(join(bin, "awk"), `#!/bin/sh\nprintf '%s\\n' '${allow.trim()}'\nexit 2\n`, { mode: 0o755 });
      const r = spawnSync("sh", ["-c", command], {
        input: claudeInput("Read", playbook),
        env: { PATH: `${bin}:${process.env.PATH}`, COPILOT_PLUGIN_ROOT: pluginRoot },
        encoding: "utf8",
      });
      expect({ status: r.status, out: r.stdout }).toEqual({ status: 0, out: "" });
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });
});

const deny = (out) => {
  expect(out.endsWith("}\n")).toBe(true);
  const d = JSON.parse(out);
  expect(Object.keys(d)).toEqual(["permissionDecision", "permissionDecisionReason"]);
  expect(d.permissionDecision).toBe("deny");
  return d.permissionDecisionReason;
};

const home = mkdtempSync(join(tmpdir(), "pstack-ptu-home-"));
const copilotHome = join(home, ".copilot");
mkdirSync(copilotHome);
const sheetPath = join(copilotHome, "pstack-models.md");
const workspace = join(home, "work");
mkdirSync(workspace);
afterAll(() => rmSync(home, { recursive: true, force: true }));

const models = JSON.parse(readFileSync(join(pluginRoot, "models.json"), "utf8"));
const ROLES = models.roles.map((r) => r.role);
const PANELS = new Set(models.roles.filter((r) => r.models === "panel").map((r) => r.role));

function sheet({ one = "gpt-5.5", strong = "claude-opus-5.5", panel = "claude-sonnet-5, gpt-5.5, gemini-3.8-flash", drop, set = {}, extra = "" } = {}) {
  const lines = ROLES.filter((r) => r !== drop).map((r) => {
    const v = set[r] ?? (PANELS.has(r) ? panel : ["bug-fix", "perf-issue", "hillclimb", "strongest judgment"].includes(r) ? strong : one);
    return `${r}: ${v}`;
  });
  return `# pstack model configuration\n\nPer-role model choices: header text.\n\n${lines.join("\n")}\n\nsession hook: on\n${extra}`;
}

const env = { COPILOT_PLUGIN_ROOT: pluginRoot, COPILOT_HOME: copilotHome, HOME: home };
const input = (tool_name, tool_input) =>
  JSON.stringify({ hook_event_name: "PreToolUse", session_id: "s", cwd: workspace, tool_name, tool_input });
const runWith = (sheetText, payload, extraEnv = {}) => {
  if (sheetText === null) rmSync(sheetPath, { force: true });
  else writeFileSync(sheetPath, sheetText);
  return run(payload, { ...env, ...extraEnv });
};
const quiet = { status: 0, out: "", err: "" };

describe("PreToolUse model check for pstack agents", () => {
  const agent = (model, agent_type = "pstack:poteto-agent") =>
    input("Agent", { agent_type, model, mode: "background", name: "w", prompt: "do it" });

  test("allows by silence a model the sheet names, in any role or panel slot", () => {
    for (const model of ["gpt-5.5", "claude-opus-5.5", "gemini-3.8-flash"]) {
      expect(runWith(sheet(), agent(model))).toEqual(quiet);
    }
  });

  test("denies an off-sheet model and lists each saved ID once", () => {
    const r = runWith(sheet(), agent("claude-haiku-4.5"));
    expect(r.status).toBe(0);
    const reason = deny(r.out);
    expect(reason).toContain("`claude-haiku-4.5` is not one of the user's saved pstack model choices");
    expect(reason).toContain("one of `gpt-5.5`, `claude-opus-5.5`, `claude-sonnet-5`, `gemini-3.8-flash`.");
    expect(reason.match(/`gpt-5.5`/g)).toHaveLength(1);
    expect(reason).toContain("setup-pstack");
  });

  test("a role value's effort suffix does not change the model it names", () => {
    const text = sheet({ strong: "claude-opus-5.5 @xhigh", panel: "claude-sonnet-5 @high, gpt-5.5, gemini-3.8-flash" });
    for (const model of ["claude-opus-5.5", "claude-sonnet-5", "gpt-5.5"]) expect(runWith(text, agent(model))).toEqual(quiet);
    const reason = deny(runWith(text, agent("claude-opus-5.5 @xhigh")).out);
    expect(reason).toContain("one of `gpt-5.5`, `claude-opus-5.5`, `claude-sonnet-5`, `gemini-3.8-flash`.");
  });

  test("the camelCase task form is checked too", () => {
    const payload = JSON.stringify({ toolName: "task", toolArgs: { agent_type: "pstack:comment-sicko", model: "o9" } });
    expect(deny(runWith(sheet(), payload).out)).toContain("`o9`");
  });

  test("a sheet with aliases says an alias role omits model", () => {
    const reason = deny(runWith(sheet({ one: "inherit-parent" }), agent("gpt-4.1")).out);
    expect(reason).toContain("A role saved as inherit-parent or auto omits `model`.");
    expect(reason).not.toContain("`inherit-parent`");
  });

  test("an all-alias sheet tells the agent to omit model", () => {
    const reason = deny(runWith(sheet({ one: "auto", strong: "inherit-parent", panel: "inherit-parent" }), agent("gpt-5.5")).out);
    expect(reason).toContain("without `model`");
  });

  const silent = {
    "a call with no model": [sheet(), input("Agent", { agent_type: "pstack:poteto-agent", prompt: "x" })],
    "an empty model": [sheet(), agent("")],
    "a non-pstack agent": [sheet(), agent("claude-haiku-4.5", "general-purpose")],
    "an agent type that only contains pstack:": [sheet(), agent("claude-haiku-4.5", "my-pstack:agent")],
    "no sheet": [null, agent("claude-haiku-4.5")],
    "a sheet with no role lines": ["session hook: on\n", agent("claude-haiku-4.5")],
    "a sheet missing a role": [sheet({ drop: "hillclimb" }), agent("claude-haiku-4.5")],
    "a sheet with a malformed ID": [sheet({ set: { "swarm workers": "Claude Opus" } }), agent("claude-haiku-4.5")],
    "a single-vendor panel": [sheet({ panel: "gpt-5.5, gpt-5.4" }), agent("claude-haiku-4.5")],
    "a payload json.awk cannot decode": [sheet(), agent("claude-haiku-4.5").replace("haiku", "h\\u00e9iku")],
  };
  for (const [name, [text, payload]] of Object.entries(silent)) {
    test(`stays silent for ${name}`, () => expect(runWith(text, payload)).toEqual(quiet));
  }

  test("checks a CRLF sheet with a byte-order mark", () => {
    const text = `\uFEFF${sheet().replaceAll("\n", "\r\n")}`;
    expect(runWith(text, agent("gpt-5.5"))).toEqual(quiet);
    expect(deny(runWith(text, agent("claude-haiku-4.5")).out)).toContain("one of `gpt-5.5`");
  });

  test.each(["utf8", "utf16le"])("setup, context, and model enforcement agree on a %s sheet", (encoding) => {
    const text = Buffer.from(`\uFEFF${sheet().replaceAll("\n", "\r\n")}`, encoding);
    writeFileSync(sheetPath, text);
    const invoke = (relative, args = []) => spawnSync("sh", [join(pluginRoot, relative), ...args], {
      env: { PATH: process.env.PATH, ...env }, encoding: "utf8",
    });
    const checked = invoke("skills/setup-pstack/scripts/check-sheet.sh");
    expect({ status: checked.status, out: checked.stdout, err: checked.stderr }).toEqual({ status: 0, out: "sheet ok\n", err: "" });
    const started = invoke("hooks/session-start.sh", ["copilot"]);
    expect(started.status).toBe(0);
    expect(JSON.parse(started.stdout).additionalContext).toContain("bug-fix: claude-opus-5.5");
    expect(deny(run(agent("off-sheet-model"), env).out)).toContain("`off-sheet-model`");
  });

  test("reads a sheet directory containing shell punctuation literally", () => {
    const directory = join(home, "copilot ' $value `literal`");
    mkdirSync(directory);
    writeFileSync(join(directory, "pstack-models.md"), Buffer.from(`\uFEFF${sheet()}`, "utf16le"));
    const result = run(agent("off-sheet-model"), { ...env, COPILOT_HOME: directory });
    expect(result.err).toBe("");
    expect(deny(result.out)).toContain("`off-sheet-model`");
  });

  test("a sheet that opts out of panel vendor diversity is valid", () => {
    expect(deny(runWith(sheet({ panel: "gpt-5.5, gpt-5.4", extra: "panel vendors: any\n" }), agent("o9")).out)).toContain("`o9`");
  });

  test("finds the sheet under HOME when COPILOT_HOME is unset", () => {
    writeFileSync(sheetPath, sheet());
    expect(deny(run(agent("claude-haiku-4.5"), { COPILOT_PLUGIN_ROOT: pluginRoot, HOME: home }).out)).toContain(sheetPath);
  });
});

describe("PreToolUse vendored script runs", () => {
  const root = pluginRoot.replace(/\/$/, "");
  const find = `${root}/skills/reflect/scripts/find-transcript.mjs`;
  const log = `${root}/skills/show-me-your-work/scripts/log.sh`;
  const bash = (command, cwd = workspace) => JSON.stringify({ tool_name: "Bash", cwd, tool_input: { command, description: "run" } });

  const allowed = {
    "a transcript search": `node ${find} ${workspace} prompt`,
    "a transcript search with explicit workspace": `node ${find} ${workspace} prompt ${workspace}`,
    "a single-quoted prompt": `node ${find} ${workspace} 'fix the billing bug'`,
    "a log with prose resembling an outside path": `bash ${log} log.tsv review /outside/private.txt why evidence result`,
    "surrounding spaces": `  bash ${log} log.tsv review decision why evidence result  `,
    "direct execution": `${log} log.tsv review decision why evidence result`,
    "a project flag with an absolute value": `node ${root}/skills/poteto-mode/scripts/resume.mjs begin --project=${workspace}`,
    "a project flag with a relative value": `node ${root}/skills/poteto-mode/scripts/resume.mjs begin --project=.`,
    "resume defaults": `node ${root}/skills/poteto-mode/scripts/resume.mjs read`,
    "resume publication": `node ${root}/skills/poteto-mode/scripts/resume.mjs publish --note note.md --artifact=a.md --artifact b.md`,
    "a relative transcript directory": `node ${find} notes/today prompt`,
    "a path in the plugin": `node ${root}/skills/poteto-mode/scripts/check-plan.mjs ${root}/skills/reflect/SKILL.md`,
    "a playbook check": `node ${root}/skills/poteto-mode/scripts/check-playbooks.mjs`,
    "a playbook check in a project": `node ${root}/skills/poteto-mode/scripts/check-playbooks.mjs .`,
    "an audit with defaults": `node ${root}/skills/poteto-mode/scripts/worktree-audit.mjs`,
    "an audit with explicit roots": `node ${root}/skills/poteto-mode/scripts/worktree-audit.mjs . transcripts more-transcripts`,
  };
  for (const [name, command] of Object.entries(allowed)) {
    test(`approves ${name}`, () => expect(run(bash(command), env)).toEqual({ status: 0, out: allow, err: "" }));
  }

  test("approves through the real path when the root is a symlink", () => {
    const dir = mkdtempSync(join(tmpdir(), "pstack-ptu-"));
    try {
      const link = join(dir, "pstack");
      symlinkSync(pluginRoot, link);
      const e = { ...env, COPILOT_PLUGIN_ROOT: link };
      expect(run(bash(`node ${link}/skills/reflect/scripts/find-transcript.mjs ${workspace} prompt`), e).out).toBe(allow);
      expect(run(bash(`node ${realpathSync(pluginRoot)}/skills/reflect/scripts/find-transcript.mjs ${workspace} prompt`), e).out).toBe(allow);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const refused = {
    "an unregistered script": `node ${root}/skills/example/scripts/new.mjs`,
    "a wrong interpreter for a registered script": `sh ${find} ${workspace} prompt`,
    "an incomplete transcript command": `node ${find} ${workspace}`,
    "an incomplete log command": `bash ${log} log.tsv review`,
    "an unknown resume option": `node ${root}/skills/poteto-mode/scripts/resume.mjs begin --new-option=path`,
    "a missing resume option value": `node ${root}/skills/poteto-mode/scripts/resume.mjs begin --project`,
    "a read with publication arguments": `node ${root}/skills/poteto-mode/scripts/resume.mjs read --note note.md`,
    "a publication without a note": `node ${root}/skills/poteto-mode/scripts/resume.mjs publish --artifact a.md`,
    "a chained rm": `node ${find} ${workspace} prompt;rm -rf ~`,
    "a spaced chain": `node ${find} ${workspace} prompt ; rm -rf ~`,
    "command substitution": `node ${find} ${workspace} prompt $(whoami)`,
    "a variable": `node ${find} ${workspace} prompt $HOME`,
    "backticks": `node ${find} ${workspace} prompt \`whoami\``,
    "an and-chain": `node ${find} ${workspace} prompt && rm -rf ~`,
    "a background job": `node ${find} ${workspace} prompt & curl evil`,
    "a pipe": `node ${find} ${workspace} prompt | sh`,
    "an output redirect": `node ${find} ${workspace} prompt > /etc/passwd`,
    "an input redirect": `node ${find} ${workspace} prompt < /etc/passwd`,
    "a subshell": `(node ${find} ${workspace} prompt)`,
    "a newline": `node ${find} ${workspace} prompt\nrm -rf ~`,
    "a carriage return": `node ${find} ${workspace} prompt\rrm -rf ~`,
    "a tab": `node\t${find}`,
    "a backslash": `node ${find} ${workspace} prompt a\\ b`,
    "a double quote": `node ${find} ${workspace} prompt "x"`,
    "an unterminated quote": `node ${find} ${workspace} prompt 'x`,
    "an unterminated quote before a space": `node ${find} ${workspace} prompt ' x`,
    "a quoted interpreter": `'node' ${find}`,
    "a quote glued to a word": `node ${find} ${workspace} prompt 'x'y`,
    "a glob": `node ${find} ${workspace} prompt *`,
    "a quoted semicolon": `node ${find} ${workspace} prompt 'a;b'`,
    "a quoted variable": `node ${find} ${workspace} prompt '$HOME'`,
    "a quoted newline": `node ${find} ${workspace} prompt 'a\nb'`,
    "a quoted tab": `node ${find} ${workspace} prompt 'a\tb'`,
    "a tilde": `node ${find} ${workspace} prompt ~/x`,
    "a .. script path": `node ${root}/skills/reflect/scripts/../../../hooks/session-start.sh`,
    "a .. argument": `node ${find} ${workspace} prompt ../../etc/passwd`,
    "a quoted .. argument": `node ${find} ${workspace} prompt '../x'`,
    "a relative flag that climbs into a sibling": `node ${root}/skills/poteto-mode/scripts/resume.mjs begin --project=../outside`,
    "a relative flag naming the parent": `node ${root}/skills/poteto-mode/scripts/resume.mjs begin --project=..`,
    "an absolute argument outside the workspace": `bash ${log} /etc/profile review decision why evidence result`,
    "a flag holding an outside path": `node ${root}/skills/poteto-mode/scripts/resume.mjs begin --project=/etc/x`,
    "a sibling prefix": `node ${root}-evil/skills/reflect/scripts/find-transcript.mjs`,
    "a script outside scripts/": `node ${root}/skills/reflect/SKILL.md`,
    "a hook script": `sh ${root}/hooks/session-start.sh`,
    "the scripts directory itself": `node ${root}/skills/reflect/scripts/`,
    "a relative script path": "node skills/reflect/scripts/find-transcript.mjs",
    "another interpreter": `python3 ${find}`,
    "an interpreter flag": `node -e ${find}`,
    "an interpreter alone": "node",
    "an empty command": "",
  };
  for (const [name, command] of Object.entries(refused)) {
    test(`stays silent for ${name}`, () => expect(run(bash(command), env)).toEqual(quiet));
  }

  // Copilot sends cwd as a real path (/private/tmp on macOS) while the agent
  // passes the path it knows.
  test("resolves a symlinked argument path against the real cwd", () => {
    const link = join(home, "linked-work");
    symlinkSync(workspace, link);
    try {
      expect(run(bash(`bash ${log} ${link}/decisions.md review decision why evidence result`, realpathSync(workspace)), env).out).toBe(allow);
      expect(run(bash(`bash ${log} ${link}/new/dir/decisions.md review decision why evidence result`, realpathSync(workspace)), env).out).toBe(allow);
      expect(run(bash(`bash ${log} ${join(home, "elsewhere.md")} review decision why evidence result`, realpathSync(workspace)), env)).toEqual(quiet);
      expect(run(bash(`bash ${log} '${link}/x y.md' review decision why evidence result`, realpathSync(workspace)), env).out).toBe(allow);
    } finally {
      rmSync(link);
    }
  });

  test.each([
    ["an outside directory", join(home, "outside")],
    ["a directory whose name contains a newline", `${workspace}\noutside`],
  ])("stays silent for a workspace symlink to %s", (_name, outside) => {
    const link = join(workspace, "linked-outside");
    mkdirSync(outside);
    symlinkSync(outside, link);
    try {
      expect(run(bash(`bash ${log} ${link}/log.tsv review decision why evidence result`), env)).toEqual(quiet);
      expect(run(bash(`bash ${log} linked-outside/log.tsv review decision why evidence result`), env)).toEqual(quiet);
      expect(run(bash(`node ${root}/skills/poteto-mode/scripts/resume.mjs begin --project=linked-outside`), env)).toEqual(quiet);
    } finally {
      rmSync(link);
      rmSync(outside, { recursive: true });
    }
  });

  test("stays silent for file symlinks, including dangling targets", () => {
    const target = join(home, "outside.tsv");
    const link = join(workspace, "linked-log.tsv");
    writeFileSync(target, "existing log\n");
    symlinkSync(target, link);
    try {
      expect(run(bash(`bash ${log} ${link} review decision why evidence result`), env)).toEqual(quiet);
      rmSync(target);
      expect(run(bash(`bash ${log} ${link} review decision why evidence result`), env)).toEqual(quiet);
    } finally {
      rmSync(link);
      rmSync(target, { force: true });
    }
  });

  test("stays silent when the plugin sits inside the workspace", () => {
    expect(run(bash(`node ${find} ${workspace} prompt`, root), env)).toEqual(quiet);
    expect(run(bash(`node ${find} ${workspace} prompt`, join(root, "..")), env)).toEqual(quiet);
  });

  // setup-pstack runs its sheet check in this form after it writes the sheet.
  test("approves setup-pstack's sheet check", () => {
    expect(run(bash(`sh ${root}/skills/setup-pstack/scripts/check-sheet.sh`), env)).toEqual({ status: 0, out: allow, err: "" });
  });
});
