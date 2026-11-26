// Never run a bare `orca` here: on Linux it is a screen reader.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { sessionFile } from "../../plugins/pstack/pi/agents.ts";
import { alive } from "../../plugins/pstack/pi/child.ts";
import { OrcaChild } from "../../plugins/pstack/pi/orca-child.ts";
import { readEntries, withEnv } from "./harness.mjs";

const LIVE = process.env.PSTACK_PI_ORCA_LIVE === "1";
const MODEL = process.env.PSTACK_PI_ORCA_MODEL ?? "magpie/claude/claude-haiku-5-5";
const ORCA_IDE = process.env.ORCA_IDE ?? join(homedir(), ".local", "bin", "orca-ide");
const USER_AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const EXTENSION = fileURLToPath(new URL("../../plugins/pstack/pi/index.ts", import.meta.url));
const MINUTE = 60_000;
const GRACE = 5_000;
const suite = LIVE ? describe : describe.skip;

const freePort = () =>
  new Promise((resolve) => {
    const server = createServer().listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

const until = async (predicate, ms) => {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(500)) if (predicate()) return true;
  return predicate();
};

suite("the orca host on a live Orca runtime", () => {
  let root;
  let data;
  let serveEnv;
  let session;
  let work;
  let agentDir;

  const ours = (pid) => {
    try {
      return readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").includes(`ORCA_USER_DATA_PATH=${data}`);
    } catch {
      return false;
    }
  };

  function orca(...args) {
    const run = spawnSync(session?.cli ?? ORCA_IDE, [...args, "--json"], { encoding: "utf8", env: serveEnv, timeout: 2 * MINUTE });
    const answer = JSON.parse(run.stdout || "{}");
    if (run.status !== 0 || answer.ok === false) throw new Error(`orca ${args.join(" ")} failed: ${run.stderr}${run.stdout}`);
    return answer.result;
  }
  const terminals = () => orca("terminal", "list", `--worktree=id:${session.workspace}`).terminals;
  const userTexts = (identity) => readEntries(sessionFile(identity)).filter((e) => e.type === "message" && e.message.role === "user");
  const toolStarted = (identity) =>
    until(() => {
      const file = sessionFile(identity);
      return Boolean(file) && readEntries(file).some((e) => e.type === "message" && e.message.role === "assistant" && e.message.content.some((c) => c.type === "toolCall"));
    }, 2 * MINUTE);

  function launch(prompt, { args = [], env = {}, identity } = {}) {
    identity ??= { id: `a${randomUUID().slice(0, 8)}`, sessionDir: join(root, "agents"), sessionId: randomUUID() };
    mkdirSync(identity.sessionDir, { recursive: true });
    const started = {};
    const child = new OrcaChild(
      "pi",
      ["--session-id", identity.sessionId, "--session-dir", identity.sessionDir, "--model", MODEL, "--thinking", "low", "--approve", ...args],
      {
        session,
        title: `pstack live ${identity.id}`,
        cwd: work,
        env: { PI_CODING_AGENT_DIR: agentDir, ...env },
        files: join(identity.sessionDir, identity.id),
        graceMs: GRACE,
        transcript: () => sessionFile(identity),
        onStart: (pid) => {
          started.pid = pid;
        },
      },
      prompt,
    );
    return { child, identity, started };
  }

  beforeAll(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "pstack-orca-live-")));
    const home = join(root, "home");
    data = join(root, "data");
    agentDir = join(root, "agent");
    work = join(root, "work");
    for (const dir of [home, data, join(agentDir, "extensions"), work]) mkdirSync(dir, { recursive: true });
    for (const file of ["auth.json", "models.json"]) if (existsSync(join(USER_AGENT_DIR, file))) symlinkSync(join(USER_AGENT_DIR, file), join(agentDir, file));
    const status = join(USER_AGENT_DIR, "extensions", "orca-agent-status.ts");
    if (existsSync(status)) copyFileSync(status, join(agentDir, "extensions", "orca-agent-status.ts"));
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ quietStartup: true }));
    for (const name of Object.keys(process.env)) if (/^(ORCA|PI|T3|HC)_/.test(name)) delete process.env[name];
    process.env.PI_TELEMETRY = "0";

    spawnSync("git", ["init", "-q", "-b", "main", work]);
    spawnSync("git", ["-C", work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"]);
    writeFileSync(join(work, "a.txt"), "1\n2\n3\n");

    const { USER, LOGNAME, SHELL, LANG, XDG_RUNTIME_DIR, PATH } = process.env;
    serveEnv = { HOME: home, USER, LOGNAME, SHELL, LANG, XDG_RUNTIME_DIR, PATH, ORCA_USER_DATA_PATH: data };
    const port = await freePort();
    spawn(ORCA_IDE, ["serve", "--port", String(port), "--bind", "127.0.0.1", "--no-pairing", "--json"], { cwd: root, env: serveEnv, detached: true, stdio: "ignore" }).unref();
    const ready = await until(() => {
      try {
        return orca("status").runtime.state === "ready";
      } catch {
        return false;
      }
    }, MINUTE);
    if (!ready) throw new Error("the isolated orca-ide serve did not become ready");
    const cli = join(data, "cli", "bin", "orca");
    if (!readFileSync(cli, "utf8").includes(`ORCA_USER_DATA_PATH='${data}'`)) throw new Error(`refusing to run ${cli}: it does not pin ${data}`);
    orca("repo", "add", `--path=${work}`);
    const workspace = orca("worktree", "list").worktrees.find((w) => w.path === work).id;
    session = { cli, workspace };
    console.log(`isolated orca runtime on 127.0.0.1:${port}, data ${data}`);
  }, 2 * MINUTE);

  afterAll(async () => {
    if (session) {
      try {
        orca("terminal", "close", `--worktree=id:${session.workspace}`, "--all");
      } catch {}
    }
    for (const pid of readdirSync("/proc").filter((p) => /^\d+$/.test(p) && ours(p))) {
      try {
        process.kill(Number(pid), "SIGTERM");
      } catch {}
    }
    await until(() => !readdirSync("/proc").some((p) => /^\d+$/.test(p) && ours(p)), 30_000);
    if (root) rmSync(root, { recursive: true });
  }, MINUTE);

  test(
    "a run settles on the reply in its transcript, in a tab Orca lists with the agent's title, with the parent's environment off argv and its files removed",
    async () => {
      const { child, identity, started } = await withEnv({ PSTACK_ORCA_PROBE: "orcaprobe42" }, () =>
        launch("Run `wc -l a.txt` and `echo $PSTACK_ORCA_PROBE` with bash, then try the write tool on b.txt. Reply with the line count, the echoed word, and whether write existed.", {
          args: ["--exclude-tools", "edit,write"],
        }),
      );
      await until(() => started.pid !== undefined, MINUTE);
      expect(readFileSync(`/proc/${started.pid}/cmdline`, "utf8")).not.toContain("orcaprobe42");
      expect(await until(() => orca("agent", "list").agents.some((a) => a.title === `pstack live ${identity.id}`), MINUTE)).toBe(true);
      const exit = await child.exited;
      expect(exit.settled).toBe(true);
      expect(exit.errorMessage).toBe("");
      expect(exit.finalText).toContain("3");
      expect(exit.finalText).toContain("orcaprobe42");
      expect(existsSync(join(work, "b.txt"))).toBe(false);
      for (const ext of [".env", ".prompt", ".sh"]) expect(existsSync(join(identity.sessionDir, `${identity.id}${ext}`))).toBe(false);
      expect(alive(started.pid)).toBe(false);
      expect(await until(() => terminals().length === 0, 10_000)).toBe(true);
    },
    5 * MINUTE,
  );

  test(
    "a prompt that starts with a dash, with quotes, $, backticks, and trailing newlines, reaches the child as written, and one that starts with an @ or a / gains one leading space",
    async () => {
      for (const lead of ["--help is not a flag.", "@a.txt is not a file argument.", "/pstack-agents is not a command here."]) {
        const prompt = `${lead} Quote test: "dq" 'sq' & <b> $HOME \`id\`\nSecond line. Reply with the word verbatim, and nothing else.\n\n`;
        const { child, identity } = launch(prompt, { args: ["--extension", EXTENSION, "--pstack-depth", "1"] });
        const exit = await child.exited;
        expect(exit.settled).toBe(true);
        expect(exit.finalText.toLowerCase()).toContain("verbatim");
        expect(userTexts(identity)[0].message.content[0].text).toBe(/^[@/]/.test(lead) ? ` ${prompt}` : prompt);
      }
    },
    5 * MINUTE,
  );

  test(
    "a long multi-line steer reaches a working child in the same turn, and the run ends on the steered reply",
    async () => {
      const { child, identity } = launch("Run `sleep 20` with bash and wait for it, then reply with the word done, unless I tell you otherwise.");
      expect(await toolStarted(identity)).toBe(true);
      const filler = Array.from({ length: 150 }, (_, i) => `filler line ${i} "q" & $HOME`).join("\n");
      const steer = `When the sleep ends, reply with the word steered instead, and nothing else.\n${filler}`;
      expect((await child.steer(steer)).taken).toBe(true);
      const exit = await child.exited;
      expect(exit.settled).toBe(true);
      expect(exit.finalText.toLowerCase()).toContain("steered");
      const users = userTexts(identity);
      expect(users.length).toBe(2);
      expect(users[1].message.content[0].text).toContain("filler line 149");
    },
    5 * MINUTE,
  );

  test(
    "a steer sent as soon as the tab starts, before pi has drawn its screen, is not lost",
    async () => {
      const { child, identity, started } = launch("Run `sleep 5` with bash and wait for it, then reply with the word done, unless I tell you otherwise.");
      await until(() => started.pid !== undefined, MINUTE);
      await until(() => existsSync(`/proc/${started.pid}`), 5_000);
      expect((await child.steer("When the sleep ends, reply with the word early instead, and nothing else.")).taken).toBe(true);
      const exit = await child.exited;
      expect(exit.settled).toBe(true);
      expect(exit.finalText.toLowerCase()).toContain("early");
      expect(userTexts(identity).length).toBe(2);
    },
    5 * MINUTE,
  );

  test(
    "end stops a working run and the command it runs within the grace period, and its tab goes",
    async () => {
      const marker = `sleep ${900 + Math.floor(Math.random() * 99)}`;
      const { child, identity, started } = launch(`Run \`${marker}\` with bash and wait for it to finish, then say done.`);
      expect(await toolStarted(identity)).toBe(true);
      const running = () => spawnSync("pgrep", ["-f", `^${marker}$`]).status === 0;
      expect(await until(running, 30_000)).toBe(true);
      const at = Date.now();
      child.end(GRACE);
      const exit = await child.exited;
      expect(exit.settled).toBe(false);
      expect(Date.now() - at).toBeLessThan(GRACE + 10_000);
      expect(alive(started.pid)).toBe(false);
      expect(await until(() => !running(), 10_000)).toBe(true);
      expect(await until(() => terminals().length === 0, 10_000)).toBe(true);
    },
    5 * MINUTE,
  );

  test(
    "Escape typed into the tab during a tool call, with a steer still queued, ends the run as stopped in Orca",
    async () => {
      const { child, identity } = launch("Run `sleep 30` with bash and wait for it, then reply with the word done.");
      expect(await toolStarted(identity)).toBe(true);
      expect((await child.steer("When the sleep ends, reply with the word kiwi instead.")).taken).toBe(true);
      const tab = terminals()[0].handle;
      orca("terminal", "send", `--terminal=${tab}`, "--text=\u001b");
      const exit = await child.exited;
      expect(exit.interruption).toBe("stopped in Orca");
      expect(await until(() => terminals().length === 0, 10_000)).toBe(true);
    },
    5 * MINUTE,
  );

  test(
    "a second run on the same session id resumes the conversation in a new tab",
    async () => {
      const first = launch("Remember the word marmalade. Reply with the word noted, and nothing else.");
      expect((await first.child.exited).settled).toBe(true);
      const second = launch("Which word did I ask you to remember? Reply with that word only.", { identity: first.identity });
      const exit = await second.child.exited;
      expect(exit.settled).toBe(true);
      expect(exit.finalText.toLowerCase()).toContain("marmalade");
      expect(readdirSync(first.identity.sessionDir).filter((n) => n.endsWith(`_${first.identity.sessionId}.jsonl`)).length).toBe(1);
    },
    5 * MINUTE,
  );

  test(
    "a child that starts a background agent of its own settles on the reply it gives once that agent is done",
    async () => {
      const prompt = `Call the agent tool once with run_in_background true, model "${MODEL}", description "sleeper", and prompt "Run \`sleep 20\` with bash, then reply with the word pineapple." Then reply with the word waiting. When the agent's result arrives, reply with the word it gave, and nothing else.`;
      const { child } = launch(prompt, { args: ["--extension", EXTENSION, "--pstack-depth", "1"] });
      const exit = await child.exited;
      expect(exit.settled).toBe(true);
      expect(exit.finalText.toLowerCase()).toContain("pineapple");
    },
    5 * MINUTE,
  );

  test(
    "end stops the child's own background agent and the command it runs",
    async () => {
      const marker = `sleep ${4000 + Math.floor(Math.random() * 999)}`;
      const prompt = `Call the agent tool once with run_in_background true, model "${MODEL}", description "sleeper", and prompt "Run \`${marker}\` with bash and wait for it to finish." Then run \`sleep 120\` with bash and wait for it.`;
      const { child } = launch(prompt, { args: ["--extension", EXTENSION, "--pstack-depth", "1"] });
      const running = () => spawnSync("pgrep", ["-f", `^${marker}$`]).status === 0;
      expect(await until(running, 2 * MINUTE)).toBe(true);
      child.end(GRACE);
      await child.exited;
      expect(await until(() => !running(), GRACE + 15_000)).toBe(true);
      expect(await until(() => terminals().length === 0, 10_000)).toBe(true);
    },
    5 * MINUTE,
  );

  test(
    "Escape in the tab of a child's own agent ends that agent as stopped, and the child's run ends on the reply it gives to the notice",
    async () => {
      const marker = `sleep ${5000 + Math.floor(Math.random() * 999)}`;
      const prompt = `Call the agent tool once with run_in_background true, model "${MODEL}", description "inner", and prompt "Run \`${marker}\` with bash and wait for it." Then reply with the word waiting. When the agent's result arrives, reply with the word mango, and nothing else.`;
      writeFileSync(join(agentDir, "pstack-models.md"), "pi agent host: orca\n");
      try {
        const { child } = launch(prompt, { args: ["--extension", EXTENSION, "--pstack-depth", "1"] });
        const running = () => spawnSync("pgrep", ["-f", `^${marker}$`]).status === 0;
        expect(await until(running, 2 * MINUTE)).toBe(true);
        const tabs = terminals();
        expect(tabs.length).toBe(2);
        orca("terminal", "send", `--terminal=${tabs.find((t) => t.title === "inner").handle}`, "--text=\u001b");
        const exit = await child.exited;
        expect(exit.settled).toBe(true);
        expect(exit.finalText.toLowerCase()).toContain("mango");
      } finally {
        rmSync(join(agentDir, "pstack-models.md"));
      }
    },
    5 * MINUTE,
  );

  test(
    "a steer sent right after the launch, before Orca has created the tab, reaches the same run",
    async () => {
      const { child, identity } = launch("Run `sleep 5` with bash and wait for it, then reply with the word done, unless I tell you otherwise.");
      expect((await child.steer("When the sleep ends, reply with the word early instead, and nothing else.")).taken).toBe(true);
      const exit = await child.exited;
      expect(exit.finalText.toLowerCase()).toContain("early");
      expect(userTexts(identity).length).toBe(2);
    },
    5 * MINUTE,
  );

  test(
    "a steer of only whitespace is refused, and the run still ends on its reply",
    async () => {
      const { child, identity } = launch("Run `sleep 5` with bash and wait for it, then reply with the word done.");
      expect(await toolStarted(identity)).toBe(true);
      expect((await child.steer(" \n ")).response).toMatchObject({ success: false });
      expect((await child.exited).settled).toBe(true);
      expect(userTexts(identity).length).toBe(1);
    },
    5 * MINUTE,
  );

  test(
    "end while Orca does not answer terminal create returns once the call gives up after 10 s, and no tab runs pi",
    async () => {
      const runtime = readdirSync("/proc").filter((p) => /^\d+$/.test(p) && ours(p) && readFileSync(`/proc/${p}/cmdline`, "utf8").includes("serve")).map(Number);
      for (const pid of runtime) process.kill(pid, "SIGSTOP");
      let exit;
      const at = Date.now();
      try {
        const { child } = launch("Reply with the word late.");
        await Bun.sleep(1_000);
        child.end(GRACE);
        exit = await child.exited;
      } finally {
        for (const pid of runtime) process.kill(pid, "SIGCONT");
      }
      expect(exit).toMatchObject({ settled: false, errorMessage: "orca terminal create did not answer within 10 s" });
      expect(Date.now() - at).toBeLessThan(15_000);
      await Bun.sleep(5_000);
      expect(spawnSync("pgrep", ["-f", "Reply with the word late"]).status).toBe(1);
      expect(await until(() => terminals().length === 0, 10_000)).toBe(true);
    },
    5 * MINUTE,
  );

  test(
    "a pi that fails to start fails the run with its error",
    async () => {
      const { child } = launch("Reply with the word never.", { args: ["--model", "nope/no-such-model"] });
      const exit = await child.exited;
      expect(exit.settled).toBe(false);
      expect(exit.stderr).toContain("no-such-model");
    },
    5 * MINUTE,
  );
});
