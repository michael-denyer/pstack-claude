// What the real-pi suite needs beyond the fake-backed harness.
import { expect } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";

import { parseSheet } from "../../plugins/pstack/pi/config.ts";
import { readEntries, sleep } from "./harness.mjs";

export const MINUTE = 60_000;

// The sheet and alias map the real-pi runs use: the shipped table of
// PSTACK_PI_LIVE_PROVIDER (default openai), with any aliases the
// `pi models:` line in PSTACK_PI_LIVE_MODELS names replaced.
export function liveModels(root, head = "") {
  const line = process.env.PSTACK_PI_LIVE_MODELS;
  const provider = process.env.PSTACK_PI_LIVE_PROVIDER ?? "openai";
  const sheet = `${head}${line ? `${line}\n` : ""}session hook: on\n`;
  const shipped = JSON.parse(readFileSync(join(root, "models.json"), "utf8")).pi.models[provider];
  if (!shipped) throw new Error(`models.json has no pi table for "${provider}"`);
  return { sheet, models: new Map([...Object.entries(shipped), ...parseSheet(sheet).piModels]) };
}

export const textOf = (m) =>
  typeof m.content === "string" ? m.content : (m.content ?? []).map((p) => p.text ?? "").filter(Boolean).join("\n");

// Splits only on LF: a Unicode line separator is valid inside a JSON string.
export function jsonLines(onRecord) {
  const decoder = new StringDecoder("utf8");
  let buf = "";
  return (chunk) => {
    buf += decoder.write(chunk);
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      const line = buf.slice(0, i).replace(/\r$/, "");
      buf = buf.slice(i + 1);
      if (line.trim()) onRecord(JSON.parse(line));
    }
  };
}

// Drives a real `pi --mode rpc` process: commands get responses, everything
// else is kept as a timestamped event.
export class PiRpc {
  events = [];
  pending = new Map();
  nextId = 0;
  stderr = "";

  constructor({ cwd, env, model, thinking = "low" }) {
    this.proc = spawn("pi", ["--mode", "rpc", "--model", model, "--thinking", thinking], {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc.stdout.on(
      "data",
      jsonLines((record) => {
        const resolve = record.type === "response" && this.pending.get(record.id);
        if (resolve) {
          this.pending.delete(record.id);
          resolve(record);
        } else this.events.push({ ...record, at: Date.now() });
      }),
    );
    this.proc.stderr.on("data", (d) => (this.stderr += d));
    this.exited = new Promise((r) => this.proc.on("close", r));
  }

  async command(type, fields = {}) {
    const id = `c${++this.nextId}`;
    const response = new Promise((r) => this.pending.set(id, r));
    this.proc.stdin.write(JSON.stringify({ id, type, ...fields }) + "\n");
    const res = await response;
    if (!res.success) throw new Error(`${type} failed: ${res.error}`);
    return res.data;
  }

  async until(predicate, timeoutMs, what) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = predicate();
      if (value) return value;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}. stderr: ${this.stderr.slice(-800)}`);
      await sleep(250);
    }
  }

  // Sends a prompt and waits until the session is settled and idle.
  async run(message, timeoutMs = 3 * MINUTE) {
    const from = this.events.length;
    await this.command("prompt", { message });
    await this.idle(from, timeoutMs);
    return from;
  }

  async idle(from, timeoutMs = 3 * MINUTE) {
    await this.until(() => this.events.slice(from).some((e) => e.type === "agent_settled"), timeoutMs, "agent_settled");
    for (;;) {
      const state = await this.command("get_state");
      if (!state.isStreaming && !state.isCompacting && state.pendingMessageCount === 0) return state;
      await sleep(250);
    }
  }

  messages(from = 0) {
    return this.events.slice(from).filter((e) => e.type === "message_end").map((e) => ({ ...e.message, at: e.at }));
  }

  notices(from = 0) {
    return this.messages(from).filter((m) => m.role === "custom" && m.customType === "pstack-agent");
  }

  toolResults(name, from = 0) {
    return this.messages(from).filter((m) => m.role === "toolResult" && m.toolName === name);
  }

  async sessionFile() {
    return (await this.command("get_state")).sessionFile;
  }

  async close() {
    this.proc.stdin.end();
    const done = await Promise.race([this.exited.then(() => true), sleep(20_000).then(() => false)]);
    if (!done) this.proc.kill("SIGKILL");
  }
}

// The agent registry as persisted in the parent session: every snapshot per id, in order.
function registry(sessionFile) {
  const byId = new Map();
  for (const e of readEntries(sessionFile)) {
    if (e.type !== "custom" || e.customType !== "pstack-agents") continue;
    byId.set(e.data.agent.id, [...(byId.get(e.data.agent.id) ?? []), e.data]);
  }
  return byId;
}

export function agentByDescription(sessionFile, description) {
  const found = [...registry(sessionFile).values()].filter((snaps) => snaps[0].agent.description === description);
  expect(found).toHaveLength(1);
  return found[0];
}

export function childEntries({ agent }) {
  const files = readdirSync(agent.sessionDir).filter((f) => f.endsWith(`_${agent.sessionId}.jsonl`));
  expect(files).toHaveLength(1);
  return readEntries(join(agent.sessionDir, files[0]));
}

// The system prompt sections in force at the end of the session: a compaction
// checkpoint resets them, later system messages patch them by name.
export function sections(entries) {
  let current = {};
  for (const e of entries) {
    if (e.type === "compaction" && e.systemMessage) current = { ...(e.systemMessage.sections ?? {}) };
    if (e.type !== "message" || e.message.role !== "system") continue;
    for (const [key, value] of Object.entries(e.message.sections ?? {})) {
      if (value === null) delete current[key];
      else current[key] = value;
    }
  }
  return current;
}

export const assistantModels = (entries) =>
  new Set(entries.filter((e) => e.type === "message" && e.message.role === "assistant").map((e) => `${e.message.provider}/${e.message.model}`));

export function processTable() {
  const out = spawnSync("ps", ["-eo", "pid=,ppid=,pgid=,args="], { encoding: "utf8" }).stdout;
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [, pid, ppid, pgid, args] = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      return { pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid), args };
    });
}

export function descendants(pid) {
  const table = processTable();
  const found = [];
  const walk = (p) => {
    for (const row of table.filter((r) => r.ppid === p)) {
      found.push(row);
      walk(row.pid);
    }
  };
  walk(pid);
  return found;
}
