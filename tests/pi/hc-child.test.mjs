import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { sessionFile } from "../../plugins/pstack/pi/agents.ts";
import { envScript, HcChild, replyIn } from "../../plugins/pstack/pi/hc-child.ts";

const entry = (role, content, extra = {}) => JSON.stringify({ type: "message", id: randomUUID().slice(0, 8), message: { role, content, ...extra } });
const text = (value) => [{ type: "text", text: value }];

function transcript(lines) {
  const file = join(mkdtempSync(join(tmpdir(), "pstack-hc-reply-")), "session.jsonl");
  writeFileSync(file, `${lines.join("\n")}\n`);
  return file;
}

test("the reply is the last assistant text written after the run began", () => {
  const earlier = [JSON.stringify({ type: "session", version: 3 }), entry("user", text("first task")), entry("assistant", text("old answer"), { stopReason: "stop" })];
  const file = transcript([
    ...earlier,
    entry("user", text("second task")),
    entry("assistant", [{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "ls" } }], { stopReason: "toolUse" }),
    entry("toolResult", text("a.txt")),
    entry("assistant", text("new answer"), { stopReason: "stop" }),
    JSON.stringify({ type: "custom", customType: "agent-summary", data: {} }),
  ]);
  const from = Buffer.byteLength(`${earlier.join("\n")}\n`);
  expect(replyIn(file, from)).toEqual({ finalText: "new answer", errorMessage: "" });
  expect(replyIn(file, statSync(file).size)).toEqual({ finalText: "", errorMessage: "" });
});

test("a run that ends on a failed message keeps its earlier text and reports the error", () => {
  const file = transcript([
    entry("assistant", text("partial findings"), { stopReason: "toolUse" }),
    entry("assistant", [], { stopReason: "error", errorMessage: "overloaded" }),
  ]);
  expect(replyIn(file, 0)).toEqual({ finalText: "partial findings", errorMessage: "overloaded" });
  expect(replyIn(undefined, 0)).toEqual({ finalText: "", errorMessage: "" });
});

test("the env file sets the parent's variables, quoted for sh, and leaves the terminal's own variables to herdr-core", () => {
  const file = join(mkdtempSync(join(tmpdir(), "pstack-hc-env-")), "env");
  const tricky = "it's $HOME `id` \"q\"\nnext line \\ end";
  writeFileSync(file, envScript({ PSTACK_A: tricky, PSTACK_EMPTY: "", TERM: "dumb", HC_TERMINAL_ID: "t0", "BAD-NAME": "x", PSTACK_UNSET: undefined }));
  const read = '. "$1" && printf "%s|%s|%s|%s|%s" "$PSTACK_A" "${PSTACK_EMPTY-unset}" "$TERM" "$HC_TERMINAL_ID" "${PSTACK_UNSET-unset}"';
  const result = spawnSync("sh", ["-c", read, "sh", file], { encoding: "utf8", env: { PATH: process.env.PATH, TERM: "xterm", HC_TERMINAL_ID: "t9" } });
  expect(result.stdout).toBe(`${tricky}||xterm|t9|unset`);
  expect(readFileSync(file, "utf8")).not.toContain("BAD-NAME");
});

const LIVE = process.env.PSTACK_PI_HC_LIVE === "1" && Boolean(process.env.HC_TERMINAL_ID);
const MODEL = process.env.PSTACK_PI_HC_MODEL;
const suite = LIVE ? describe : describe.skip;
const MINUTE = 60_000;
const GRACE = 5_000;
const EXTENSION = fileURLToPath(new URL("../../plugins/pstack/pi/index.ts", import.meta.url));
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");

suite("HcChild on a live hc core", () => {
  function pathWithout(root, names) {
    return process.env.PATH.split(":")
      .map((dir, i) => {
        if (!names.some((name) => existsSync(join(dir, name)))) return dir;
        const copy = join(root, `path-${i}`);
        mkdirSync(copy);
        for (const file of readdirSync(dir)) if (!names.includes(file)) symlinkSync(join(dir, file), join(copy, file));
        return copy;
      })
      .join(":");
  }

  function launch(prompt, { args = [], env = {}, files = {}, withPstack = false, slowStart = false } = {}) {
    const root = mkdtempSync(join(tmpdir(), "pstack-hc-live-"));
    const cwd = join(root, "work");
    const identity = { sessionDir: join(root, "agents"), sessionId: randomUUID() };
    mkdirSync(cwd);
    mkdirSync(identity.sessionDir);
    writeFileSync(join(cwd, "a.txt"), "1\n2\n3\n");
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(dirname(join(cwd, rel)), { recursive: true });
      writeFileSync(join(cwd, rel), text);
    }
    if (withPstack || slowStart) {
      const agentDir = join(root, "agent");
      mkdirSync(agentDir);
      for (const file of ["models.json", "auth.json"]) if (existsSync(join(AGENT_DIR, file))) symlinkSync(join(AGENT_DIR, file), join(agentDir, file));
      env = { ...env, PI_CODING_AGENT_DIR: agentDir };
    }
    if (withPstack) args = [...args, "--extension", EXTENSION];
    if (slowStart) env = { ...env, PATH: pathWithout(root, ["fd", "rg"]) };
    const name = `pstack-test-${identity.sessionId.slice(0, 8)}`;
    const envFile = join(identity.sessionDir, "child.env");
    const started = {};
    const onStart = (pid) => {
      started.pid = pid;
      started.argv = JSON.parse(spawnSync("hc", ["get", "--json", name], { encoding: "utf8" }).stdout).argv;
    };
    const flags = ["--session-id", identity.sessionId, "--session-dir", identity.sessionDir, "--model", MODEL, "--thinking", "low", ...args];
    const child = new HcChild(name, "pi", flags, { cwd, env, envFile, graceMs: GRACE, transcript: () => sessionFile(identity), onStart }, prompt);
    return { child, cwd, name, envFile, started };
  }

  const gone = (name) => spawnSync("hc", ["get", "--json", name]).status !== 0;
  const running = (command) => spawnSync("pgrep", ["-f", `^${command}$`]).status === 0;
  const until = async (predicate, ms) => {
    for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(500)) if (predicate()) return true;
    return predicate();
  };

  test(
    "a run settles on the reply in its transcript, with the parent's environment kept off argv and without edit tools, and leaves no terminal",
    async () => {
      process.env.PSTACK_HC_PROBE = "hcprobe42";
      const prompt = "Run `wc -l a.txt` and `echo $PSTACK_HC_PROBE` with bash, then try the write tool on b.txt. Reply with the line count, the echoed word, and whether write existed.";
      const { child, cwd, name, envFile, started } = launch(prompt, { args: ["--exclude-tools", "edit,write"] });
      delete process.env.PSTACK_HC_PROBE;
      const exit = await child.exited;
      expect(exit.settled).toBe(true);
      expect(exit.errorMessage).toBe("");
      expect(exit.finalText).toContain("3");
      expect(exit.finalText).toContain("hcprobe42");
      expect(JSON.stringify(started.argv)).not.toContain("hcprobe42");
      expect(existsSync(envFile)).toBe(false);
      expect(existsSync(join(cwd, "b.txt"))).toBe(false);
      expect(gone(name)).toBe(true);
    },
    5 * MINUTE,
  );

  test(
    "a prompt that starts with a dash reaches the child as text",
    async () => {
      const { child } = launch("--help is not a flag here. Reply with the word dashed, and nothing else.");
      const exit = await child.exited;
      expect(exit.settled).toBe(true);
      expect(exit.finalText.toLowerCase()).toContain("dashed");
    },
    5 * MINUTE,
  );

  test(
    "a prompt sent while pi is still starting, here downloading fd and rg, is submitted once its startup ends",
    async () => {
      const { child, cwd } = launch("Reply with the word started, and nothing else.", { slowStart: true });
      const exit = await child.exited;
      expect(exit.settled).toBe(true);
      expect(exit.finalText.toLowerCase()).toContain("started");
      expect(existsSync(join(dirname(cwd), "agent", "bin", "fd"))).toBe(true);
    },
    5 * MINUTE,
  );

  test(
    "a steer reaches a working child, and the run ends on the steered reply",
    async () => {
      const { child } = launch("Run `sleep 20` with bash and wait for it, then reply with the word done, unless I tell you otherwise.");
      await Bun.sleep(10_000);
      expect((await child.steer("When the sleep ends, reply with the word steered instead, and nothing else.")).taken).toBe(true);
      const exit = await child.exited;
      expect(exit.settled).toBe(true);
      expect(exit.finalText.toLowerCase()).toContain("steered");
    },
    5 * MINUTE,
  );

  test(
    "end stops a working run within the grace period and removes its terminal",
    async () => {
      const { child, name } = launch("Run `ping -c 90 127.0.0.1 > /dev/null` with bash and wait for it to finish, then say done.");
      await Bun.sleep(10_000);
      const started = Date.now();
      child.end(GRACE);
      const exit = await child.exited;
      expect(exit.settled).toBe(false);
      expect(Date.now() - started).toBeLessThan(GRACE + 10_000);
      expect(gone(name)).toBe(true);
    },
    5 * MINUTE,
  );

  test(
    "end gives the child time to stop its own background agent and the command that agent runs",
    async () => {
      const marker = `sleep ${4000 + Math.floor(Math.random() * 999)}`;
      const prompt = `Call the agent tool once with run_in_background true, model "${MODEL}", description "sleeper", and prompt "Run \`${marker}\` with bash and wait for it to finish." Then run \`sleep 120\` with bash and wait for it.`;
      const { child, name } = launch(prompt, { withPstack: true });
      expect(await until(() => running(marker), 2 * MINUTE)).toBe(true);
      child.end(GRACE);
      await child.exited;
      expect(await until(() => !running(marker), GRACE + 10_000)).toBe(true);
      expect(gone(name)).toBe(true);
    },
    5 * MINUTE,
  );

  test(
    "a run that stops at a question fails with the dialog's screen as its diagnostic",
    async () => {
      const { child, name } = launch("Use the ask_user_question tool to ask me one question, 'alpha or beta?', with the options alpha and beta.", { withPstack: true });
      const exit = await child.exited;
      expect(exit.settled).toBe(false);
      expect(exit.stderr).toContain("alpha");
      expect(gone(name)).toBe(true);
    },
    5 * MINUTE,
  );

  test(
    "with --no-approve, a child in an untrusted project folder starts without the trust dialog",
    async () => {
      const { child } = launch("Reply with the word trusted-or-not, and nothing else.", { args: ["--no-approve"], files: { ".pi/settings.json": "{}\n" } });
      const exit = await child.exited;
      expect(exit.settled).toBe(true);
      expect(exit.finalText).toContain("trusted-or-not");
    },
    5 * MINUTE,
  );
});
