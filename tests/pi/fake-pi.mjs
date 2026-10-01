#!/usr/bin/env node
// Stands in for `pi --mode json -p` (selected with PSTACK_PI_BIN). It logs its
// invocation to PSTACK_FAKE_PI_LOG and plays the steps PSTACK_FAKE_PI_SCRIPT
// names for its prompt, read from stdin as real pi does: { "default": [steps], "byPrompt": { "<prompt>": [steps] } }.
//
// Steps: { reply } emits an assistant message_end ("${prompt}" and "${history}"
// expand, history being the earlier prompts of the same --session-id);
// { error } emits a failed assistant message; { raw } writes stdout verbatim;
// { stderr }, { sleep: ms }, { exit: code }, { grandchild: true } spawns a
// sleeping process in this process group, { ignoreSigterm: true },
// { touch: "<file>" } writes a file in the working directory.
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
};
const prompt = readFileSync(0, "utf8");
const sessionId = flag("--session-id");
const sessionDir = flag("--session-dir");
const systemFile = flag("--append-system-prompt");

const log = (record) => {
  if (process.env.PSTACK_FAKE_PI_LOG) appendFileSync(process.env.PSTACK_FAKE_PI_LOG, JSON.stringify(record) + "\n");
};

let history = [];
if (sessionId && sessionDir) {
  mkdirSync(sessionDir, { recursive: true });
  const file = join(sessionDir, `${sessionId}.fake.jsonl`);
  if (existsSync(file)) history = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  appendFileSync(file, JSON.stringify(prompt) + "\n");
}

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

const script = process.env.PSTACK_FAKE_PI_SCRIPT ? JSON.parse(readFileSync(process.env.PSTACK_FAKE_PI_SCRIPT, "utf8")) : {};
const steps = script.byPrompt?.[prompt] ?? script.default ?? [{ reply: "ok" }];

const out = (event) => process.stdout.write(JSON.stringify(event) + "\n");
const expand = (text) => text.replaceAll("${prompt}", prompt).replaceAll("${history}", history.join(" | "));
const assistant = (content, extra = {}) => ({
  role: "assistant",
  content,
  stopReason: "stop",
  timestamp: Date.now(),
  ...extra,
});

out({ type: "session", version: 3, id: sessionId ?? "none", timestamp: new Date().toISOString(), cwd: process.cwd() });
out({ type: "agent_start" });
out({ type: "message_end", message: { role: "user", content: prompt, timestamp: Date.now() } });

let code = 0;
for (const step of steps) {
  if ("reply" in step) out({ type: "message_end", message: assistant([{ type: "text", text: expand(step.reply) }]) });
  if ("error" in step) {
    out({ type: "message_end", message: assistant([], { stopReason: "error", errorMessage: step.error }) });
    code = 1;
  }
  if ("raw" in step) process.stdout.write(step.raw);
  if ("touch" in step) writeFileSync(step.touch, "changed\n");
  if ("stderr" in step) process.stderr.write(step.stderr);
  if ("sleep" in step) await new Promise((r) => setTimeout(r, step.sleep));
  if ("exit" in step) code = step.exit;
  if (step.ignoreSigterm) process.on("SIGTERM", () => log({ kind: "sigterm-ignored", pid: process.pid }));
  if (step.grandchild) {
    const g = spawn("sleep", ["300"], { stdio: "ignore" });
    log({ kind: "grandchild", pid: g.pid });
  }
}
out({ type: "agent_end", messages: [] });
process.exitCode = code;
process.stdout.end(() => process.exit(code));
