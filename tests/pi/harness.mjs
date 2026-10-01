// A minimal stand-in for Pi's ExtensionAPI and ExtensionContext that records
// what the extension registers and sends, plus per-test fixtures.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";

import { parseSheet } from "../../plugins/pstack/pi/config.ts";

export const pluginRoot = fileURLToPath(new URL("../../plugins/pstack/", import.meta.url));
export const fakePiBin = fileURLToPath(new URL("./fake-pi.mjs", import.meta.url));

export const fixtureModels = {
  available: ["opus", "fable", "sonnet", "haiku"],
  pi: {
    fallback: "anthropic",
    models: {
      anthropic: {
        opus: "anthropic/fixture-opus",
        fable: "anthropic/fixture-fable",
        sonnet: "anthropic/fixture-sonnet",
        haiku: "anthropic/fixture-haiku",
      },
      "openai-codex": {
        opus: "openai-codex/fixture-opus",
        fable: "openai-codex/fixture-fable",
        sonnet: "openai-codex/fixture-sonnet",
        haiku: "openai-codex/fixture-haiku",
      },
    },
  },
};

export function fakePi({ thinking = "medium" } = {}) {
  const tools = new Map();
  const commands = new Map();
  const handlers = new Map();
  const messages = [];
  const userMessages = [];
  const entries = [];
  const api = {
    registerTool: (tool) => tools.set(tool.name, tool),
    registerCommand: (name, options) => commands.set(name, options),
    on(event, handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      return () => {};
    },
    sendMessage: (message, options) => messages.push({ message, options }),
    sendUserMessage: (content, options) => userMessages.push({ content, options }),
    getThinkingLevel: () => thinking,
    appendEntry: (customType, data) =>
      entries.push({ type: "custom", customType, data: JSON.parse(JSON.stringify(data)) }),
  };
  return {
    api,
    tools,
    commands,
    messages,
    userMessages,
    entries,
    async emit(event, payload, ctx) {
      const results = [];
      for (const h of handlers.get(event) ?? []) results.push(await h({ type: event, ...payload }, ctx));
      return results;
    },
    call(name, params, ctx, signal) {
      return tools.get(name).execute("call-1", params, signal, undefined, ctx);
    },
  };
}

export function fakeCtx({ cwd, sessionId = "parent-session", entries = [], model, mode = "tui", hasUI = false, ui, idle = true } = {}) {
  return {
    cwd,
    mode,
    hasUI,
    ui,
    model: model === undefined ? { provider: "anthropic", id: "parent-model" } : model,
    isIdle: () => (typeof idle === "function" ? idle() : idle),
    sessionManager: { getSessionId: () => sessionId, getEntries: () => entries },
  };
}

// A temp world: agent dir, a fixture models.json, a fake-pi script and log.
export function world({ script = {}, sheet = null, killGraceMs = 300 } = {}) {
  const root = mkdtempSync(join(tmpdir(), "pstack-pi-"));
  const agentDir = join(root, "agent");
  mkdirSync(agentDir);
  if (sheet !== null) writeFileSync(join(agentDir, "pstack-models.md"), sheet);
  const modelsFile = join(root, "models.json");
  writeFileSync(modelsFile, JSON.stringify(fixtureModels));
  const scriptFile = join(root, "script.json");
  writeFileSync(scriptFile, JSON.stringify(script));
  const logFile = join(root, "fake-pi.log");
  const cwd = join(root, "work");
  mkdirSync(cwd);
  const settings = {
    pluginRoot,
    modelsFile,
    agentDir,
    pi: { command: fakePiBin, args: [] },
    childEnv: {
      PATH: process.env.PATH,
      HOME: root,
      PSTACK_PI_DEPTH: "1",
      PSTACK_FAKE_PI_SCRIPT: scriptFile,
      PSTACK_FAKE_PI_LOG: logFile,
    },
    depth: 0,
    killGraceMs,
  };
  return {
    root,
    agentDir,
    cwd,
    settings,
    setScript: (s) => writeFileSync(scriptFile, JSON.stringify(s)),
    log: () =>
      existsSync(logFile)
        ? readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
        : [],
    invocations() {
      return this.log().filter((r) => r.kind === "invocation");
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

// The sheet and alias map the real-pi runs use: the shipped table of
// PSTACK_PI_LIVE_PROVIDER (default openai-codex), with any aliases the
// `pi models:` line in PSTACK_PI_LIVE_MODELS names replaced.
export function liveModels(root, head = "", extra = "") {
  const line = process.env.PSTACK_PI_LIVE_MODELS;
  const provider = process.env.PSTACK_PI_LIVE_PROVIDER ?? "openai-codex";
  const sheet = `${head}${line ? `${line}\n` : ""}${extra}session hook: on\n`;
  const shipped = JSON.parse(readFileSync(join(root, "models.json"), "utf8")).pi.models[provider];
  if (!shipped) throw new Error(`models.json has no pi table for "${provider}"`);
  return { sheet, models: new Map([...Object.entries(shipped), ...parseSheet(sheet).piModels]) };
}

export function gitRepo(dir) {
  const run = (...args) => {
    const r = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    if (r.status !== 0) throw new Error(r.stderr);
    return r.stdout.trim();
  };
  run("init", "-q", "-b", "main");
  run("config", "user.email", "t@example.com");
  run("config", "user.name", "t");
  writeFileSync(join(dir, "README"), "x\n");
  run("add", "README");
  run("commit", "-q", "-m", "init");
  return run;
}

export async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

export function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const MINUTE = 60_000;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
