// A minimal stand-in for Pi's ExtensionAPI and ExtensionContext that records
// what the extension registers and sends, plus per-test fixtures.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const pluginRoot = fileURLToPath(new URL("../../plugins/pstack/", import.meta.url));
export const fakePiBin = fileURLToPath(new URL("./fake-pi.mjs", import.meta.url));

export const fixtureModels = {
  available: ["opus", "fable", "sonnet", "haiku"],
  pi: {
    models: {
      opus: "anthropic/fixture-opus",
      fable: "anthropic/fixture-fable",
      sonnet: "anthropic/fixture-sonnet",
      haiku: "anthropic/fixture-haiku",
    },
  },
};

export function fakePi() {
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

export function fakeCtx({ cwd, sessionId = "parent-session", entries = [], model, hasUI = false, ui, idle = true } = {}) {
  return {
    cwd,
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
      PSTACK_PI_CHILD: "1",
      PSTACK_FAKE_PI_SCRIPT: scriptFile,
      PSTACK_FAKE_PI_LOG: logFile,
    },
    isChild: false,
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
