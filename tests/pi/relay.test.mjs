// A child's permission ask reaching its parent, on real pi 1.4 with the real
// @gotgenes/pi-permission-system 42.0.0 and a scripted provider (fake-provider.mjs),
// so it makes no model call and needs no credentials. Skipped unless
// PSTACK_PI_PERMISSION_SYSTEM names an installed copy of that package and Pi is
// installed. Each run builds a throwaway PI_CODING_AGENT_DIR, so nothing under
// ~/.pi is written.
//
//   npm install --ignore-scripts @gotgenes/pi-permission-system@42.0.0 @earendil-works/pi-coding-agent@1.4.0
//   PI_PACKAGE_DIR=$PWD/node_modules/@earendil-works/pi-coding-agent \
//   PSTACK_PI_PERMISSION_SYSTEM=$PWD/node_modules/@gotgenes/pi-permission-system \
//   bun test tests/pi/relay.test.mjs
import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { findPiPackage } from "../../tools/pi-package.mjs";
import { startFakeProvider, relayScript } from "./fake-provider.mjs";
import { jsonLines } from "./live-harness.mjs";
import { readEntries, sleep } from "./harness.mjs";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const permissionSystem = process.env.PSTACK_PI_PERMISSION_SYSTEM;
const piDir = findPiPackage();
const suite = permissionSystem && piDir ? describe : describe.skip;

const cleanups = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

// An agent directory with pstack and the permission system installed as global
// packages, so children load both, a provider that answers from relayScript, and
// a policy that asks for bash and allows the rest.
async function relayWorld() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pstack-relay-")));
  const agentDir = join(root, "agent");
  const work = join(root, "work");
  mkdirSync(work, { recursive: true });
  mkdirSync(join(agentDir, "extensions", "pi-permission-system"), { recursive: true });
  const marker = join(work, "marker.txt");
  const provider = await startFakeProvider(relayScript(marker));
  cleanups.push(async () => {
    await provider.close();
    rmSync(root, { recursive: true, force: true });
  });
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [repoRoot, permissionSystem] }));
  writeFileSync(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        fake: {
          baseUrl: provider.url,
          apiKey: "unused",
          api: "openai-completions",
          compat: { supportsUsageInStreaming: false, supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false },
          models: [{ id: "scripted" }],
        },
      },
    }),
  );
  writeFileSync(join(agentDir, "extensions", "pi-permission-system", "config.json"), JSON.stringify({ permission: { "*": "allow", bash: "ask" } }));
  const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" };
  delete env.PI_SUBAGENT_PARENT_SESSION;
  const reviewLog = () => {
    const file = join(agentDir, "extensions", "pi-permission-system", "logs", "pi-permission-system-permission-review.jsonl");
    return existsSync(file) ? readEntries(file) : [];
  };
  return { work, marker, env, reviewLog };
}

const PROMPT = "PARENT-TASK start the probe";
const piArgs = (...rest) => [join(piDir, "dist", "cli.js"), "--model", "fake/scripted", ...rest];

// The parent as `pi --mode rpc`, which has a UI: every dialog it is sent goes to
// `answer`, whose return value is the response. Resolves with what the run left.
async function runRpcParent(world, answer) {
  const proc = spawn("node", piArgs("--mode", "rpc"), { cwd: world.work, env: world.env, stdio: ["pipe", "pipe", "pipe"] });
  const dialogs = [];
  const messages = [];
  const pending = new Map();
  let stderr = "";
  proc.stderr.on("data", (d) => (stderr += d));
  const lines = jsonLines((record) => {
    if (record.type === "response") pending.get(record.id)?.(record);
    else if (record.type === "message_end") messages.push(record.message);
    else if (record.type === "extension_ui_request" && ["select", "confirm", "input", "editor"].includes(record.method)) {
      dialogs.push(record);
      proc.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: record.id, ...answer(record) })}\n`);
    }
  });
  proc.stdout.on("data", lines.write);
  proc.stdin.on("error", () => {});
  let closed = false;
  const exited = new Promise((resolve) => proc.on("close", resolve));
  exited.then(() => (closed = true));
  cleanups.push(() => proc.kill("SIGKILL"));
  const died = (what) => new Error(`pi exited before ${what}. stderr: ${stderr.slice(-800)}`);
  const command = (type) =>
    new Promise((resolve, reject) => {
      if (closed) return reject(died(`answering ${type}`));
      pending.set(type, resolve);
      exited.then(() => reject(died(`answering ${type}`)));
      proc.stdin.write(`${JSON.stringify({ id: type, type })}\n`);
    });
  const done = () => messages.some((m) => m.role === "assistant" && JSON.stringify(m.content).includes("PARENT-DONE"));
  proc.stdin.write(`${JSON.stringify({ id: "prompt", type: "prompt", message: PROMPT })}\n`);
  const deadline = Date.now() + 45_000;
  while (!done()) {
    if (closed) throw died("the parent finished");
    if (Date.now() > deadline) throw new Error(`the parent did not finish. stderr: ${stderr.slice(-800)}`);
    await sleep(100);
  }
  const { data } = await command("get_state");
  proc.stdin.end();
  await exited;
  const agentResult = messages.find((m) => m.role === "toolResult" && m.toolName === "agent");
  const childReport = agentResult ? agentResult.content[0].text : "(no agent tool result arrived)";
  return { sessionId: data.sessionId, dialogs, childReport };
}

const permissionTitle = (dialog) => dialog.title.split("\n")[0];
const choose = (label) => (dialog) => ({ value: dialog.options?.find((o) => o === label) ?? "" });

suite("a child's permission ask on real pi", () => {
  test("reaches the parent's prompt, and the parent's approval lets the child's bash run", async () => {
    const world = await relayWorld();
    const run = await runRpcParent(world, choose("Yes"));
    expect(run.dialogs.map(permissionTitle)).toEqual(["Permission Required (Subagent)"]);
    expect(run.dialogs[0].title).toContain("full command : echo probed >");
    expect(existsSync(world.marker)).toBe(true);
    expect(run.childReport).toContain("CHILD-DONE");
    expect(run.childReport).not.toContain("denied");
    const created = world.reviewLog().find((e) => e.event === "forwarded_permission.request_created");
    expect(created.targetSessionId).toBe(run.sessionId);
    expect(created.requesterSessionId).not.toBe(run.sessionId);
  }, 60_000);

  test("reaches the parent's prompt, and the parent's denial stops the child's bash", async () => {
    const world = await relayWorld();
    const run = await runRpcParent(world, (dialog) => (dialog.method === "input" ? { value: "" } : choose("No")(dialog)));
    expect(run.dialogs.length).toBeGreaterThan(0);
    expect(existsSync(world.marker)).toBe(false);
    expect(run.childReport).toContain("denied this 'bash' call");
  }, 60_000);

  test("without a UI in the parent, the child is not relayed: no prompt reaches anyone and the ask is denied at once", async () => {
    const world = await relayWorld();
    const proc = spawn("node", piArgs("-p", PROMPT), { cwd: world.work, env: world.env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    proc.stdout.on("data", (d) => (out += d));
    cleanups.push(() => proc.kill("SIGKILL"));
    let timer;
    const timeout = new Promise((resolve) => (timer = setTimeout(resolve, 45_000, "timeout")));
    const code = await Promise.race([new Promise((resolve) => proc.on("close", resolve)), timeout]);
    clearTimeout(timer);
    expect(code).toBe(0);
    expect(out).toContain("denied this 'bash' call");
    expect(existsSync(world.marker)).toBe(false);
    const events = world.reviewLog().map((e) => e.event);
    expect(events).not.toContain("forwarded_permission.request_created");
    expect(events).not.toContain("forwarded_permission.relay_started");
  }, 60_000);
});
