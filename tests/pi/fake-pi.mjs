#!/usr/bin/env node
// Stands in for `pi --mode rpc` (the harness points settings.pi at it). It logs
// its invocation, each reply, steer, and settle to PSTACK_FAKE_PI_LOG, so a
// test can wait for the moment it needs, reads JSON commands from stdin as real pi
// does, and plays the steps PSTACK_FAKE_PI_SCRIPT names for the prompt it is
// given: { "default": [steps], "byPrompt": { "<prompt>": [steps] } }.
//
// Steps: { reply } emits an assistant message_end ("${prompt}", "${history}"
// and "${steered}" expand; history is the earlier prompts of the same
// --session-id, steered the steer messages taken so far); { error } emits a
// failed assistant message; { raw } writes stdout verbatim; { stderr },
// { sleep: ms }, { exit: code } ends the process at once, { grandchild: true }
// spawns a sleeping process as a running bash command would (detached, killed
// on SIGTERM) and { grandchild: "background" } one a finished command left
// behind (detached, never killed), { ignoreSigterm: true },
// { touch: "<file>" } writes a file in the working directory, { mute: true }
// stops answering commands from then on, { grandchildHoldingPipes: true }
// spawns a SIGTERM-ignoring process on this process's stdio, { askUser: true }
// sends a notify and a select UI request and waits for a response to either.
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

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
};
const sessionId = flag("--session-id");
const sessionDir = flag("--session-dir");
const systemFile = flag("--append-system-prompt");

const log = (record) => {
  if (process.env.PSTACK_FAKE_PI_LOG) appendFileSync(process.env.PSTACK_FAKE_PI_LOG, JSON.stringify(record) + "\n");
};
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

const script = process.env.PSTACK_FAKE_PI_SCRIPT ? JSON.parse(readFileSync(process.env.PSTACK_FAKE_PI_SCRIPT, "utf8")) : {};

const steerQueue = [];
const steered = [];
let aborted = false;
let wake = () => {};
let stdinClosed = false;
let started = false;
let muted = false;
let uiAnswered = () => {};
// As pi's rpc mode: SIGTERM kills the process trees of the bash commands still
// running, then exits 143.
const trackedCommands = new Set();
process.on("SIGTERM", () => {
  for (const pid of trackedCommands) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {}
  }
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
  depth: process.env.PSTACK_PI_DEPTH ?? null,
  systemPrompt: systemFile && existsSync(systemFile) ? readFileSync(systemFile, "utf8") : null,
  history,
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
  if ("reply" in step) {
    out({ type: "message_end", message: assistant([{ type: "text", text: expand(step.reply) }]) });
    log({ kind: "reply", pid: process.pid });
  }
  if ("error" in step) out({ type: "message_end", message: assistant([], { stopReason: "error", errorMessage: step.error }) });
  if ("raw" in step) process.stdout.write(step.raw);
  if ("touch" in step) writeFileSync(step.touch, "changed\n");
  if ("stderr" in step) process.stderr.write(step.stderr);
  if ("sleep" in step) {
    const until = Date.now() + step.sleep;
    while (!aborted && Date.now() < until) await pause(until - Date.now());
  }
  if ("exit" in step) process.exit(step.exit);
  if (step.mute) muted = true;
  if (step.ignoreSigterm) {
    process.removeAllListeners("SIGTERM");
    process.on("SIGTERM", () => log({ kind: "sigterm-ignored", pid: process.pid }));
    log({ kind: "ignoring-sigterm", pid: process.pid });
  }
  if (step.grandchild) {
    // As pi's bash tool: detached, so in its own process group. A running
    // command is tracked and killed on SIGTERM; one a finished command left in
    // the background is not.
    // "ingroup" is not how pi spawns anything; it pins down that the runner
    // sends no signal to the group after a clean exit.
    const g = spawn("sleep", ["300"], { stdio: "ignore", detached: step.grandchild !== "ingroup" });
    if (step.grandchild === true) trackedCommands.add(g.pid);
    log({ kind: "grandchild", pid: g.pid, background: step.grandchild === "background" });
  }
  if (step.grandchildHoldingPipes) {
    const g = spawn("sh", ["-c", 'trap "" TERM; exec sleep 300'], { stdio: "inherit" });
    log({ kind: "grandchild", pid: g.pid });
  }
  if (step.askUser) {
    out({ type: "extension_ui_request", id: "u0", method: "notify", message: "fyi", notifyType: "info" });
    out({ type: "extension_ui_request", id: "u1", method: "select", title: "Which?", options: ["a", "b"] });
    await new Promise((resolve) => (uiAnswered = resolve));
  }
  if ("lingerAfterSettle" in step) linger = step.lingerAfterSettle;
  if ("holdSettle" in step) holdSettle = step.holdSettle;
  if ("awaitMessage" in step) {
    const until = Date.now() + step.awaitMessage;
    while (!steerQueue.length && !aborted && Date.now() < until) await pause(until - Date.now());
  }
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
