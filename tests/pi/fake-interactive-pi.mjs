#!/usr/bin/env node
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const dir = process.env.FAKE_ORCA_DIR;
const argv = process.argv.slice(2);
const flag = (name) => argv[argv.indexOf(name) + 1];
const script = existsSync(join(dir, "script.json")) ? JSON.parse(readFileSync(join(dir, "script.json"), "utf8")) : {};
const log = (record) => appendFileSync(join(dir, "pi.jsonl"), `${JSON.stringify({ pid: process.pid, ...record })}\n`);

const prompt = argv.at(-1);
const session = join(flag("--session-dir"), `2026-01-01T00-00-00-000Z_${flag("--session-id")}.jsonl`);
const append = (entry) => appendFileSync(session, `${JSON.stringify(entry)}\n`);
const write = (role, text, extra, id) => append({ type: "message", id, message: { role, content: [{ type: "text", text }], ...extra } });

const files = readdirSync(flag("--session-dir")).filter((name) => !name.endsWith(".jsonl"));
log({ argv, prompt, files, cwd: process.cwd(), env: { PSTACK_PROBE: process.env.PSTACK_PROBE, ORCA_PANE_KEY: process.env.ORCA_PANE_KEY, ORCA_PI_STATUS_OWNED: process.env.ORCA_PI_STATUS_OWNED } });
if (script.exit !== undefined) {
  if (script.stderr) process.stderr.write(script.stderr);
  process.exit(script.exit);
}
if (script.startDelay) await sleep(script.startDelay);

const inbox = join(dir, "inbox.jsonl");
const typed = () => (existsSync(inbox) ? readFileSync(inbox, "utf8").split("\n").filter(Boolean) : []);
const unsubmitted = typed().length;
write("user", prompt);
if (script.hang) {
  write("assistant", "working", { stopReason: "toolUse" });
  log({ tool: spawn("sleep", ["30"], { stdio: "ignore" }).pid });
} else if (script.awaitSteer) {
  while (typed().length <= unsubmitted) await sleep(20);
  write("assistant", "before the steer", { stopReason: "stop" });
  const pastTwoPolls = 2 * script.pollMs + 200;
  await sleep(pastTwoPolls);
  const steer = JSON.parse(typed()[unsubmitted]);
  write("user", steer);
  write("assistant", `steered: ${steer}`, { stopReason: "stop" });
} else if (script.retry) {
  const shorterThanAPoll = script.pollMs - 50;
  for (let attempt = 1; attempt <= 5; attempt++) {
    write("assistant", "", { stopReason: "error", errorMessage: "overloaded" }, `e${attempt}`);
    await sleep(shorterThanAPoll);
    append({ type: "context_edit", id: `c${attempt}`, targetId: `e${attempt}`, replacement: null });
    await sleep(100);
  }
  write("assistant", "reply after retry", { stopReason: "stop" });
} else {
  write("assistant", `reply to ${prompt}`, { stopReason: script.stopReason ?? "stop" });
}
setInterval(() => {}, 1000);
