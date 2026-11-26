import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { sessionFile } from "../../plugins/pstack/pi/agents.ts";
import { envScript } from "../../plugins/pstack/pi/hc-child.ts";
import { OrcaChild, orcaSession, SETTLE_POLL_MS, settledRun } from "../../plugins/pstack/pi/orca-child.ts";
import { alive, readEntries, waitFor, withEnv } from "./harness.mjs";

const FAKE_ORCA = fileURLToPath(new URL("./fake-orca.mjs", import.meta.url));
const FAKE_PI = fileURLToPath(new URL("./fake-interactive-pi.mjs", import.meta.url));
const GRACE = 300;

const scratch = [];
const scratchDir = () => {
  scratch.push(realpathSync(mkdtempSync(join(tmpdir(), "pstack-orca-"))));
  return scratch.at(-1);
};
const children = [];
afterEach(() => {
  for (const child of children.splice(0)) child.signal("SIGKILL");
  for (const dir of scratch.splice(0)) {
    for (const { pid } of logged(dir, "pi.jsonl")) if (pid) kill(pid);
    rmSync(dir, { recursive: true });
  }
  delete process.env.FAKE_ORCA_DIR;
});

const kill = (pid) => {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {}
};
const logged = (dir, name) => (existsSync(join(dir, name)) ? readEntries(join(dir, name)) : []);

function launch(prompt, { script = {}, command = FAKE_PI, args = [], env = {}, cwdName = "work" } = {}) {
  const root = scratchDir();
  const cwd = join(root, cwdName);
  const identity = { sessionDir: join(root, "agents"), sessionId: randomUUID() };
  mkdirSync(cwd);
  mkdirSync(identity.sessionDir);
  writeFileSync(join(root, "script.json"), JSON.stringify({ pollMs: SETTLE_POLL_MS, ...script }));
  process.env.FAKE_ORCA_DIR = root;
  const started = [];
  const child = new OrcaChild(
    command,
    ["--session-id", identity.sessionId, "--session-dir", identity.sessionDir, ...args],
    {
      session: { cli: FAKE_ORCA, workspace: "repo-1::/work/tree" },
      title: "--a title",
      cwd,
      env,
      files: join(identity.sessionDir, "a1"),
      graceMs: GRACE,
      transcript: () => sessionFile(identity),
      onStart: (pid) => started.push(pid),
    },
    prompt,
  );
  children.push(child);
  const calls = (command) => logged(root, "calls.jsonl").filter((argv) => argv[1] === command);
  const leftovers = () => readdirSync(identity.sessionDir).filter((name) => name.startsWith("a1."));
  return { child, root, cwd, identity, started, calls, leftovers, pi: () => logged(root, "pi.jsonl") };
}

describe("OrcaChild", () => {
  test("a run opens a terminal in the parent's workspace, settles on the reply, ends pi, and closes the tab", async () => {
    const run = await withEnv({ ORCA_PI_STATUS_OWNED: "1" }, () => launch("count the files", { env: { PSTACK_PROBE: "it's $HOME" } }));
    const exit = await run.child.exited;
    expect(exit).toEqual({ exitCode: null, settled: true, finalText: "reply to count the files", errorMessage: "", interruption: undefined, stderr: "" });
    const [create] = run.calls("create");
    expect(create).toEqual(["terminal", "create", "--worktree=id:repo-1::/work/tree", "--title=--a title", `--command=exec sh '${run.identity.sessionDir}/a1.sh'`, "--json"]);
    const [pi] = run.pi();
    expect(run.started).toEqual([pi.pid]);
    expect(pi.cwd).toBe(run.cwd);
    expect(pi.files.toSorted()).toEqual(["a1.err", "a1.sh"]);
    expect(pi.env).toEqual({ PSTACK_PROBE: "it's $HOME", ORCA_PANE_KEY: "child-pane" });
    expect(alive(pi.pid)).toBe(false);
    expect(run.calls("close")).toEqual([["terminal", "close", "--terminal=term_child", "--json"]]);
    expect(run.calls("read")).toEqual([]);
    expect(run.leftovers()).toEqual([]);
  });

  test("the launch script passes the prompt and every argument through sh verbatim", async () => {
    const prompt = "-x is no flag: \"double\" 'single' $HOME `id` $(id) \\ end\nnext line *\n\n";
    const args = ["--append-system-prompt", "<active_agent name=\"a's\" />", "$HOME", "two words"];
    const run = launch(prompt, { args, cwdName: "it's a $dir" });
    expect((await run.child.exited).settled).toBe(true);
    const [pi] = run.pi();
    expect(pi.argv.slice(-6)).toEqual([...args, "--", prompt]);
    expect(pi.cwd).toBe(run.cwd);
  });

  test("a prompt starting with @ or / gets one leading space, since pi reads an @ argument as a file and a / one as a command", async () => {
    for (const prompt of ["@README.md says what?", "/pstack-agents"]) {
      const run = launch(prompt);
      expect((await run.child.exited).settled).toBe(true);
      expect(run.pi()[0].argv.slice(-2)).toEqual(["--", ` ${prompt}`]);
    }
  });

  test("a steer is sent verbatim, and the run settles only once its turn is in", async () => {
    const run = launch("start", { script: { awaitSteer: true } });
    await waitFor(() => run.started.length === 1 && run.pi().length === 1);
    expect(await run.child.steer("--help me\ninstead")).toEqual({ response: { success: true }, taken: true });
    const exit = await run.child.exited;
    expect(exit).toMatchObject({ settled: true, finalText: "steered: --help me\ninstead" });
    expect(run.calls("send")).toEqual([["terminal", "send", "--terminal=term_child", "--text=--help me\ninstead", "--enter", "--json"]]);
    expect(await run.child.steer("too late")).toEqual({ response: undefined, taken: false });
    expect(run.calls("send")).toHaveLength(1);
  }, 15_000);

  test("a steer that pi's editor would run as a shell or slash command is refused, not typed", async () => {
    const run = launch("start", { script: { hang: true } });
    await waitFor(() => run.started.length === 1 && run.pi().length === 2);
    for (const message of ["!rm -rf x", "  /quit", "\n!!ls"]) {
      const answer = await run.child.steer(message);
      expect(answer.taken).toBe(false);
      expect(answer.response).toMatchObject({ success: false });
      expect(answer.response.error).toContain("starts with ! or /");
    }
    expect(run.calls("send")).toEqual([]);
    run.child.end(GRACE);
    await run.child.exited;
  });

  test("a steer with no text, which pi's editor would drop, is refused, not typed", async () => {
    const run = launch("start", { script: { hang: true } });
    await waitFor(() => run.started.length === 1 && run.pi().length === 2);
    for (const message of ["", "  ", "\n\t \r\n"]) {
      const answer = await run.child.steer(message);
      expect(answer.taken).toBe(false);
      expect(answer.response).toMatchObject({ success: false });
    }
    expect(run.calls("send")).toEqual([]);
    run.child.end(GRACE);
    await run.child.exited;
  });

  test("a steer sent before Orca has answered terminal create is typed into the tab once it has, in the same run", async () => {
    const run = launch("start", { script: { awaitSteer: true, delay: { "terminal create": 1000 } } });
    expect(await run.child.steer("early")).toEqual({ response: { success: true }, taken: true });
    expect(await run.child.exited).toMatchObject({ settled: true, finalText: "steered: early" });
    expect(run.calls("send")).toHaveLength(1);
  }, 15_000);

  test("a steer sent before pi has started is typed once pi has taken its prompt, since pi keeps earlier text in its editor unsubmitted", async () => {
    const run = launch("start", { script: { awaitSteer: true, startDelay: 1000 } });
    await waitFor(() => run.started.length === 1);
    expect(await run.child.steer("early")).toEqual({ response: { success: true }, taken: true });
    expect(await run.child.exited).toMatchObject({ settled: true, finalText: "steered: early" });
  }, 15_000);

  test("a steer to a pi that fails to start is not taken, and does not wait", async () => {
    const run = launch("x", { script: { exit: 1, stderr: "no model" } });
    expect(await run.child.steer("more")).toEqual({ response: undefined, taken: false });
    expect(run.calls("send")).toEqual([]);
  });

  test("end while terminal create hangs returns once the call gives up after 10 s, and no tab runs pi", async () => {
    const run = launch("x", { script: { delay: { "terminal create": 60_000 } } });
    await waitFor(() => run.calls("create").length === 1);
    const at = Date.now();
    run.child.end(GRACE);
    const exit = await Promise.race([run.child.exited, Bun.sleep(15_000).then(() => "still waiting")]);
    expect(exit).toMatchObject({ settled: false, errorMessage: "orca terminal create did not answer within 10 s" });
    expect(Date.now() - at).toBeLessThan(12_000);
    expect(run.started).toEqual([]);
    expect(run.leftovers()).toEqual([]);
  }, 20_000);

  test("a run whose terminal close hangs still ends once the call gives up after 10 s", async () => {
    const run = launch("x", { script: { delay: { "terminal close": 60_000 } } });
    const exit = await Promise.race([run.child.exited, Bun.sleep(15_000).then(() => "still waiting")]);
    expect(exit).toMatchObject({ settled: true, finalText: "reply to x" });
  }, 20_000);

  test("a steer too long for one command-line argument is refused, and the run goes on", async () => {
    const run = launch("start", { script: { awaitSteer: true } });
    await waitFor(() => run.started.length === 1);
    const answer = await run.child.steer("x".repeat(2 * 1024 * 1024));
    expect(answer.taken).toBe(false);
    expect(answer.response.error).toContain("put it in a file");
    expect(await run.child.steer("short")).toEqual({ response: { success: true }, taken: true });
    expect(await run.child.exited).toMatchObject({ settled: true, finalText: "steered: short" });
  }, 15_000);

  test("a steer Orca accepts only after the run has settled on it is taken, so it is not sent again", async () => {
    const run = launch("start", { script: { awaitSteer: true, slow: { "terminal send": 4_000 } } });
    await waitFor(() => run.started.length === 1);
    const steer = run.child.steer("late");
    expect(await run.child.exited).toMatchObject({ settled: true, finalText: "steered: late" });
    expect(await steer).toEqual({ response: { success: true }, taken: true });
  }, 15_000);

  test("a steer Orca does not take is not waited for", async () => {
    const run = launch("start", { script: { hang: true, fail: { "terminal send": "no pane" } } });
    await waitFor(() => run.started.length === 1 && run.pi().length === 2);
    expect(await run.child.steer("more")).toEqual({ response: undefined, taken: false });
    writeFileSync(sessionFile(run.identity), `${JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" } })}\n`, { flag: "a" });
    expect(await run.child.exited).toMatchObject({ settled: true, finalText: "done" });
  });

  test("end during a run kills pi and the command it runs, and closes the tab", async () => {
    const run = launch("long task", { script: { hang: true } });
    await waitFor(() => run.pi().length === 2);
    const [{ pid }, { tool }] = run.pi();
    run.child.end(GRACE);
    const exit = await run.child.exited;
    expect(exit).toMatchObject({ settled: false, finalText: "working", stderr: "" });
    await waitFor(() => !alive(pid) && !alive(tool));
    expect(run.calls("close")).toHaveLength(1);
    expect(run.calls("read")).toEqual([]);
  });

  test("a signal before Orca has answered terminal create, as when the parent exits, leaves the tab nothing to start", async () => {
    const run = launch("x", { script: { delay: { "terminal create": 1000 } } });
    await waitFor(() => run.calls("create").length === 1);
    run.child.signal("SIGTERM");
    await run.child.exited;
    expect(run.started).toHaveLength(1);
    expect(run.pi()).toEqual([]);
    expect(run.leftovers()).toEqual([]);
  }, 15_000);

  test("end before the terminal is created ends it as soon as it is", async () => {
    const run = launch("never mind", { script: { hang: true } });
    run.child.end(GRACE);
    const exit = await run.child.exited;
    expect(exit.settled).toBe(false);
    expect(alive(run.started[0])).toBe(false);
    expect(run.calls("close")).toHaveLength(1);
    expect(run.leftovers()).toEqual([]);
  });

  test("a failed reply that pi drops to retry does not end the run, and the retried reply does", async () => {
    const run = launch("x", { script: { retry: true } });
    expect(await run.child.exited).toMatchObject({ settled: true, finalText: "reply after retry", errorMessage: "" });
  }, 15_000);

  test("an aborted turn is a run stopped in Orca", async () => {
    const run = launch("x", { script: { stopReason: "aborted" } });
    expect(await run.child.exited).toMatchObject({ settled: true, interruption: "stopped in Orca" });
  });

  test("a pi that exits before replying fails the run with what it wrote to stderr", async () => {
    const run = launch("x", { script: { exit: 1, stderr: "Error: Model \"nope/x\" not found.\n" } });
    expect(await run.child.exited).toMatchObject({ settled: false, stderr: "Error: Model \"nope/x\" not found.\n" });
    expect(run.leftovers()).toEqual([]);
  });

  test("a pi that exits silently before replying fails the run with the terminal's screen", async () => {
    const run = launch("x", { script: { exit: 1 } });
    expect(await run.child.exited).toMatchObject({ exitCode: null, settled: false, finalText: "", stderr: "screen line one\nscreen line two" });
    expect(run.calls("read")).toEqual([["terminal", "read", "--terminal=term_child", "--screen", "--json"]]);
    expect(run.calls("close")).toHaveLength(1);
  });

  test("an Orca CLI answer that is not JSON is the run's error, with the command and the text", async () => {
    const run = launch("x", { script: { garbage: { "terminal create": "Orca is still starting" } } });
    expect(await run.child.exited).toMatchObject({ settled: false, errorMessage: "orca terminal create answered: Orca is still starting" });
  });

  test("an Orca CLI failure is the run's error, and no file is left", async () => {
    const run = launch("x", { script: { fail: { "terminal create": "selector_not_found: no such worktree" } } });
    expect(await run.child.exited).toEqual({ exitCode: null, settled: false, finalText: "", errorMessage: "selector_not_found: no such worktree", stderr: "" });
    expect(run.started).toEqual([]);
    expect(run.leftovers()).toEqual([]);
  });
});

test("the settle rule: every user message is in and the last message is an assistant's that calls no tool", () => {
  const message = (role, stopReason) => ({ type: "message", message: { role, content: [], stopReason } });
  const turn = [message("user"), message("assistant", "toolUse"), message("toolResult"), message("assistant", "stop")];
  const noise = { type: "custom", customType: "agent-summary" };
  expect(settledRun([...turn, noise], 0)).toEqual({ interruption: undefined });
  expect(settledRun(turn.slice(0, 2), 0)).toBeUndefined();
  expect(settledRun(turn.slice(0, 3), 0)).toBeUndefined();
  expect(settledRun(turn, 1)).toBeUndefined();
  expect(settledRun([...turn, message("user")], 1)).toBeUndefined();
  expect(settledRun([...turn, message("user"), message("assistant", "stop")], 1)).toEqual({ interruption: undefined });
  expect(settledRun([message("user"), message("assistant", "aborted")], 0)).toEqual({ interruption: "stopped in Orca" });
  expect(settledRun([], 0)).toBeUndefined();
  const aborted = message("assistant", "aborted");
  expect(settledRun([message("user"), message("assistant", "toolUse"), aborted], 1)).toEqual({ interruption: "stopped in Orca" });
  const agent = (status) => ({ type: "custom", customType: "pstack-agents", data: { agent: { id: "a9" }, status } });
  const notice = (status, triggerTurn = true) => ({ type: "custom_message", customType: "pstack-agent", content: "pstack agent finished.", details: { agentId: "a9", status, triggerTurn } });
  const waiting = [message("user"), message("assistant", "toolUse"), agent("running"), message("toolResult"), message("assistant", "stop")];
  expect(settledRun(waiting, 0)).toBeUndefined();
  expect(settledRun([...waiting, agent("completed")], 0)).toEqual({ interruption: undefined });
  expect(settledRun([...waiting, agent("completed"), notice("completed")], 0)).toBeUndefined();
  expect(settledRun([...waiting, agent("completed"), notice("completed"), message("assistant", "stop")], 0)).toEqual({ interruption: undefined });
  expect(settledRun([...waiting, agent("stopped"), notice("stopped", false)], 0)).toEqual({ interruption: undefined });
  expect(settledRun([...waiting, agent("stopped"), notice("stopped")], 0)).toBeUndefined();
  const failed = { type: "message", id: "e1", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "overloaded" } };
  expect(settledRun([message("user"), failed], 0)).toEqual({ interruption: undefined });
  expect(settledRun([message("user"), failed, { type: "context_edit", id: "c1", targetId: "e1", replacement: null }], 0)).toBeUndefined();
});

test("an Orca session needs the terminal handle, the CLI wrapper, and the workspace", () => {
  const env = { ORCA_TERMINAL_HANDLE: "term_1", ORCA_CLI_COMMAND: "/data/cli/bin/orca", ORCA_WORKTREE_ID: "r::/p" };
  expect(orcaSession(env, "linux")).toEqual({ cli: "/data/cli/bin/orca", workspace: "r::/p" });
  for (const name of Object.keys(env)) expect(orcaSession({ ...env, [name]: undefined }, "linux")).toBeUndefined();
});

test("without ORCA_CLI_COMMAND only macOS falls back to orca on PATH, as Orca's macOS app sets none", () => {
  const env = { ORCA_TERMINAL_HANDLE: "term_1", ORCA_WORKTREE_ID: "r::/p" };
  expect(orcaSession(env, "darwin")).toEqual({ cli: "orca", workspace: "r::/p" });
  expect(orcaSession(env, "linux")).toBeUndefined();
  expect(orcaSession(env, "win32")).toBeUndefined();
});

test("without ORCA_WORKTREE_ID the workspace is ORCA_WORKSPACE_ID, which Orca sets on every tab", () => {
  const env = { ORCA_TERMINAL_HANDLE: "term_1", ORCA_CLI_COMMAND: "/data/cli/bin/orca", ORCA_WORKSPACE_ID: "r::/w" };
  expect(orcaSession(env, "linux")).toEqual({ cli: "/data/cli/bin/orca", workspace: "r::/w" });
  expect(orcaSession({ ...env, ORCA_WORKTREE_ID: "r::/p" }, "linux")).toEqual({ cli: "/data/cli/bin/orca", workspace: "r::/p" });
});

test("the env file leaves out the variables sh holds read-only, so sourcing it never stops the launch", () => {
  const file = join(scratchDir(), "env");
  writeFileSync(file, envScript({ UID: "1", EUID: "1", PPID: "1", SHELLOPTS: "x", BASHOPTS: "x", PSTACK_A: "a" }, "ORCA_"));
  for (const shell of ["sh", "bash"]) {
    expect(spawnSync(shell, ["-c", '. "$1" && printf %s "$PSTACK_A"', "sh", file], { encoding: "utf8" }).stdout).toBe("a");
  }
});

test("the env file drops the variables of the terminal program it is written for", () => {
  const file = join(scratchDir(), "env");
  const env = { PSTACK_A: "a", ORCA_PANE_KEY: "parent", ORCA_PI_STATUS_OWNED: "1", HC_TERMINAL_ID: "t0", TERM: "dumb" };
  const exported = (prefix) => {
    writeFileSync(file, envScript(env, prefix));
    return spawnSync("sh", ["-c", '. "$1" && env', "sh", file], { encoding: "utf8", env: {} }).stdout;
  };
  const names = (out) => Object.keys(env).filter((name) => out.includes(`\n${name}=`) || out.startsWith(`${name}=`));
  expect(names(exported("ORCA_"))).toEqual(["PSTACK_A", "HC_TERMINAL_ID"]);
  expect(names(exported("HC_"))).toEqual(["PSTACK_A", "ORCA_PANE_KEY", "ORCA_PI_STATUS_OWNED"]);
});
