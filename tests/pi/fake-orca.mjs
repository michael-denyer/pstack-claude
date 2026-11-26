#!/usr/bin/env node
// `terminal create` runs its --command as Orca does: in a session of its own, with the terminal's environment and not the caller's.
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.env.FAKE_ORCA_DIR;
const argv = process.argv.slice(2);
const script = existsSync(join(dir, "script.json")) ? JSON.parse(readFileSync(join(dir, "script.json"), "utf8")) : {};
const value = (name) => argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const answer = async (result) => {
  if (script.slow?.[command]) await new Promise((resolve) => setTimeout(resolve, script.slow[command]));
  console.log(JSON.stringify({ id: "1", ok: true, result }, null, 2));
};
const fail = (message) => {
  console.log(JSON.stringify({ id: "1", ok: false, error: { code: "runtime_error", message } }));
  process.exit(1);
};

appendFileSync(join(dir, "calls.jsonl"), `${JSON.stringify(argv)}\n`);
const command = argv.slice(0, 2).join(" ");
if (script.fail?.[command]) fail(script.fail[command]);
if (script.delay?.[command]) await new Promise((resolve) => setTimeout(resolve, script.delay[command]));
if (script.garbage?.[command]) {
  console.log(script.garbage[command]);
  process.exit(0);
}

if (command === "terminal create") {
  const terminal = spawn("sh", ["-c", value("command")], { detached: true, stdio: "ignore", env: { PATH: process.env.PATH, ORCA_PANE_KEY: "child-pane" } });
  terminal.unref();
  answer({ terminal: { handle: "term_child", processId: terminal.pid } });
} else if (command === "terminal send") {
  appendFileSync(join(dir, "inbox.jsonl"), `${JSON.stringify(value("text"))}\n`);
  answer({ send: { accepted: true } });
} else if (command === "terminal read") {
  answer({ terminal: { tail: ["screen line one", "screen line two"] } });
} else if (command === "terminal close") {
  answer({ close: {} });
} else fail(`unknown command ${command}`);
