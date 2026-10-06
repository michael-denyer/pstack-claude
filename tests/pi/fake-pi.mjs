#!/usr/bin/env node
// Stands in for `pi --mode rpc` (the harness points settings.pi at it). It logs
// its invocation, each reply, steer, and settle to its second argument, so a
// test can wait for the moment it needs, reads JSON commands from stdin as real pi
// does, and plays the steps its first argument's script names for the prompt it is
// given: { "default": [steps], "byPrompt": { "<prompt>": [steps] } }.
//
// Steps: { reply } emits an assistant message_end ("${prompt}", "${history}"
// and "${steered}" expand; history is the earlier prompts of the same
// --session-id, steered the steer messages taken so far); { error } emits a
// failed assistant message; { raw } writes stdout verbatim; { stderr },
// { sleep: ms }, { exit: code } ends the process at once, { spawn: "<kind>" }
// starts a sleeping process of a kind in SPAWNS below and logs it as
// "grandchild" with that kind in `as`, { ignoreSigterm: true },
// { touch: "<file>" } writes a file in the working directory, { mute: true }
// stops answering commands from then on, { askUser: true } sends a notify and
// a select UI request and waits for a response to either.
// A step has exactly one key. A step with more, a step key or spawn kind this
// file does not know, or a mute, ignoreSigterm, or askUser step whose value is
// not true ends the process with exit code 64, so a misspelled step cannot pass
// for the behaviour it names.
//
// A steer command is queued and taken at the next step boundary, where it is
// emitted as a user message_end and logged as "steered", as pi delivers a steer
// after the current tool call. { awaitMessage: ms } waits up to ms for one.
// After the last step the run settles; the process then waits for stdin to
// close and exits, as pi does. { lingerAfterSettle: ms } keeps it alive that
// long after a close, to test a message that arrives in that window.
// { holdSettle: ms } logs "idle" and then holds every stdout line, the settle
// included, for ms: a steer sent meanwhile is answered "queued" after the
// settle, as pi answers a steer it has already stopped for, and never runs.
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const [scriptPath, logPath, ...argv] = process.argv.slice(2);
// As pi (cli/setup.js): the title replaces the arguments ps shows for it.
process.title = "pi";
const flag = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
};
const sessionId = flag("--session-id");
const sessionDir = flag("--session-dir");
const systemFile = flag("--append-system-prompt");

const log = (record) => appendFileSync(logPath, JSON.stringify(record) + "\n");
let held;
const out = (event) => {
  const line = JSON.stringify(event) + "\n";
  if (held) held.push(line);
  else process.stdout.write(line);
};
const respond = (command, extra = {}) => out({ type: "response", id: command.id, command: command.type, success: true, ...extra });

let history = [];
const sessionFile = sessionId && sessionDir ? join(sessionDir, `${sessionId}.fake.jsonl`) : undefined;
if (sessionFile) {
  mkdirSync(sessionDir, { recursive: true });
  if (existsSync(sessionFile)) history = readFileSync(sessionFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}
const remember = (text) => sessionFile && appendFileSync(sessionFile, JSON.stringify(text) + "\n");

const script = JSON.parse(readFileSync(scriptPath, "utf8"));

const DEAF = ["sh", ["-c", 'trap "" TERM; exec sleep 300']];
const SPAWNS = {
  // A bash command still running: pi's bash tool detaches it into its own
  // group, and pi kills that group when it gets SIGTERM.
  running: { detached: true, tracked: true },
  // One a finished bash command left behind: its own group, never killed.
  background: { detached: true },
  // In this process's group, which is not how pi spawns anything; it shows
  // which signals reach the group.
  ingroup: {},
  // In this process's group and ignoring SIGTERM.
  deaf: { command: DEAF },
  // The same, holding this process's stdio open.
  "holding-pipes": { command: DEAF, stdio: "inherit" },
};
const STEPS = {
  reply: (text) => {
    out({ type: "message_end", message: assistant([{ type: "text", text: expand(text) }]) });
    log({ kind: "reply", pid: process.pid });
  },
  error: (message) => out({ type: "message_end", message: assistant([], { stopReason: "error", errorMessage: message }) }),
  raw: (text) => process.stdout.write(text),
  touch: (file) => writeFileSync(file, "changed\n"),
  stderr: (text) => process.stderr.write(text),
  sleep: (ms) => waitUntil(ms, () => false),
  exit: (code) => process.exit(code),
  mute: () => (muted = true),
  ignoreSigterm: () => {
    process.removeAllListeners("SIGTERM");
    process.on("SIGTERM", () => log({ kind: "sigterm-ignored", pid: process.pid }));
    log({ kind: "ignoring-sigterm", pid: process.pid });
  },
  spawn: (kind) => {
    const { command = ["sleep", ["300"]], detached = false, stdio = "ignore", tracked = false } = SPAWNS[kind];
    const g = spawn(...command, { stdio, detached });
    if (tracked) trackedCommands.add(g.pid);
    log({ kind: "grandchild", as: kind, pid: g.pid });
  },
  askUser: async () => {
    out({ type: "extension_ui_request", id: "u0", method: "notify", message: "fyi", notifyType: "info" });
    out({ type: "extension_ui_request", id: "u1", method: "select", title: "Which?", options: ["a", "b"] });
    await new Promise((resolve) => (uiAnswered = resolve));
  },
  lingerAfterSettle: (ms) => (linger = ms),
  holdSettle: (ms) => (holdSettle = ms),
  awaitMessage: (ms) => waitUntil(ms, () => steerQueue.length > 0),
};
const FLAG_STEPS = new Set(["mute", "ignoreSigterm", "askUser"]);
function stepProblem(step) {
  const keys = Object.keys(step);
  if (keys.length !== 1) return `a step needs exactly one key, got ${JSON.stringify(step)}`;
  if (!Object.hasOwn(STEPS, keys[0])) return `unknown step key "${keys[0]}"`;
  if (keys[0] === "spawn" && !Object.hasOwn(SPAWNS, step.spawn)) return `unknown spawn kind "${step.spawn}"`;
  if (FLAG_STEPS.has(keys[0]) && step[keys[0]] !== true) return `step "${keys[0]}" takes only true, got ${JSON.stringify(step[keys[0]])}`;
  return null;
}
for (const step of [...(script.default ?? []), ...Object.values(script.byPrompt ?? {}).flat()]) {
  const problem = stepProblem(step);
  if (problem) {
    process.stderr.write(`fake-pi: ${problem}\n`);
    process.exit(64);
  }
}

const steerQueue = [];
const steered = [];
let aborted = false;
let wake = () => {};
let stdinClosed = false;
let started = false;
let muted = false;
let uiAnswered = () => {};
// As pi: an abort or SIGTERM kills the process trees of the bash commands still
// running, and SIGTERM then exits 143. Killing on abort too matters when an
// abort, a stdin close, and a SIGTERM arrive together: the run can settle and
// exit before the SIGTERM handler runs.
const trackedCommands = new Set();
const killTracked = () => {
  for (const pid of trackedCommands) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {}
  }
};
process.on("SIGTERM", () => {
  killTracked();
  process.exit(143);
});
let settledAt;
let linger = 0;
let holdSettle = 0;

const prompted = new Promise((resolve) => {
  const lines = createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    if (!line.trim() || muted) return;
    const command = JSON.parse(line);
    if (command.type === "prompt") {
      // As pi: a prompt an extension command consumes starts no run, so no
      // agent_settled follows, and the process lives until stdin closes.
      if (command.message.startsWith("/")) return respond(command, { data: { disposition: "handled" } });
      respond(command, { data: { disposition: "started" } });
      started = true;
      resolve(command.message);
    } else if (command.type === "steer") {
      // As pi: an extension command cannot be a steer.
      if (command.message.startsWith("/")) return respond(command, { success: false, error: "Extension commands are not allowed in steer" });
      respond(command, { data: { disposition: "queued" } });
      steerQueue.push(command.message);
      wake();
    } else if (command.type === "abort") {
      aborted = true;
      killTracked();
      wake();
      respond(command);
    } else if (command.type === "extension_ui_response") {
      log({ kind: "ui-response", id: command.id, cancelled: command.cancelled === true, pid: process.pid });
      uiAnswered();
    } else respond(command);
  });
  lines.on("close", () => {
    stdinClosed = true;
    if (!started) process.exit(0);
    if (settledAt !== undefined) setTimeout(() => process.exit(0), Math.max(0, settledAt + linger - Date.now()));
  });
});

out({ type: "session", version: 3, id: sessionId ?? "none", timestamp: new Date().toISOString(), cwd: process.cwd() });
const prompt = await prompted;
remember(prompt);
log({
  kind: "invocation",
  argv,
  prompt,
  cwd: process.cwd(),
  pid: process.pid,
  depth: flag("--pstack-depth") ?? null,
  // As pi: a value that names no file is appended as the prompt text itself.
  systemPrompt: systemFile && existsSync(systemFile) ? readFileSync(systemFile, "utf8") : (systemFile ?? null),
});
const steps = script.byPrompt?.[prompt] ?? script.default ?? [{ reply: "ok" }];

const expand = (text) =>
  text.replaceAll("${prompt}", prompt).replaceAll("${history}", history.join(" | ")).replaceAll("${steered}", steered.join(" | "));
const takeSteers = () => {
  for (const text of steerQueue.splice(0)) {
    steered.push(text);
    remember(text);
    log({ kind: "steered", text, pid: process.pid });
    out({ type: "message_end", message: { role: "user", content: [{ type: "text", text }], timestamp: Date.now() } });
  }
};
const assistant = (content, extra = {}) => ({ role: "assistant", content, stopReason: "stop", timestamp: Date.now(), ...extra });
const waitUntil = async (ms, done) => {
  const until = Date.now() + ms;
  while (!aborted && !done() && Date.now() < until) await pause(until - Date.now());
};
// Resolves after ms, or as soon as a steer or abort arrives.
const pause = (ms) => new Promise((r) => {
  const t = setTimeout(r, ms);
  wake = () => {
    clearTimeout(t);
    r();
  };
});

out({ type: "agent_start" });
out({ type: "message_end", message: { role: "user", content: prompt, timestamp: Date.now() } });

for (const step of steps) {
  if (aborted) break;
  const [[key, value]] = Object.entries(step);
  await STEPS[key](value);
  takeSteers();
}
if (holdSettle) held = [];
out({ type: "agent_end", messages: [] });
out({ type: "agent_settled" });
settledAt = Date.now();
log({ kind: "settled", pid: process.pid });
if (holdSettle) {
  log({ kind: "idle", pid: process.pid });
  setTimeout(() => {
    const lines = held;
    held = undefined;
    process.stdout.write(lines.join(""));
  }, holdSettle);
}
if (stdinClosed) setTimeout(() => process.exit(0), linger);
