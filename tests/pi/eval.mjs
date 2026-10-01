#!/usr/bin/env bun
// Runs pstack workflows on real pi and checks each run against what its skill
// requires, read from pi's own session files and the repo afterwards. Costs
// real model calls, so it is a script, not a test.
//
//   bun tests/pi/eval.mjs [--only interrogate,how] [--runs 3] [--jobs 3] [--keep]
//
// Picks models like the live suite: PSTACK_PI_LIVE_PROVIDER and
// PSTACK_PI_LIVE_MODELS. A run with a failed check keeps its directory.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { scenarios } from "./eval-scenarios.mjs";
import { gitRepo, jsonLines, liveModels, PiRpc } from "./harness.mjs";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const { values: opts } = parseArgs({
  options: {
    only: { type: "string" },
    runs: { type: "string", default: "3" },
    jobs: { type: "string", default: "3" },
    keep: { type: "boolean", default: false },
  },
});

function exec(command, args, { cwd, env, input = "", timeoutMs = 60_000 } = {}) {
  return new Promise((resolve) => {
    const proc = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    const events = [];
    let stdout = "";
    let stderr = "";
    const parse = jsonLines((e) => events.push(e));
    proc.stdout.on("data", (d) => {
      stdout += d;
      try {
        parse(d);
      } catch {}
    });
    proc.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => proc.kill("SIGTERM"), timeoutMs);
    proc.on("close", (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, stdout, stderr, events });
    });
    proc.stdin.end(input);
  });
}

async function makeWorld(scenario) {
  const { sheet, models } = liveModels(join(repoRoot, "plugins/pstack"), "", scenario.sheet ?? "");
  const root = mkdtempSync(join(tmpdir(), `pstack-pi-eval-${scenario.name}-`));
  const agentDir = join(root, "agent");
  const work = join(root, "work");
  mkdirSync(agentDir);
  mkdirSync(work);
  symlinkSync(join(homedir(), ".pi", "agent", "auth.json"), join(agentDir, "auth.json"));
  const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_TELEMETRY: "0" };
  for (const key of Object.keys(env)) {
    if ((key.startsWith("PI_") && key !== "PI_CODING_AGENT_DIR" && key !== "PI_TELEMETRY") || key.startsWith("PSTACK_PI_")) delete env[key];
  }
  const install = await exec("pi", ["install", repoRoot], { cwd: work, env });
  if (install.status !== 0) throw new Error(`pi install failed: ${install.stderr}`);
  writeFileSync(join(agentDir, "pstack-models.md"), sheet);
  return { root, agentDir, work, env, models, git: gitRepo(work) };
}

const piPrint = (w, prompt, { model = w.models.get("opus"), timeoutMs = 20 * 60_000 } = {}) =>
  exec("pi", ["--mode", "json", "-p", "--model", model, "--thinking", "medium"], { cwd: w.work, env: w.env, input: prompt, timeoutMs });

const readEntries = (file) => readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

function jsonlFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .flatMap((n) => (statSync(join(dir, n)).isDirectory() ? jsonlFiles(join(dir, n)) : n.endsWith(".jsonl") ? [join(dir, n)] : []))
    .sort();
}

const textOf = (message) =>
  typeof message.content === "string" ? message.content : (message.content ?? []).map((c) => c.text ?? "").join("");

// Each tool call with its result, timed by the entries that hold them.
function calls(entries) {
  const results = new Map();
  for (const e of entries) if (e.type === "message" && e.message.role === "toolResult") results.set(e.message.toolCallId, e);
  return entries
    .filter((e) => e.type === "message" && e.message.role === "assistant")
    .flatMap((e) =>
      e.message.content
        .filter((c) => c.type === "toolCall")
        .map((c) => {
          const r = results.get(c.id);
          return {
            name: c.name,
            args: c.arguments ?? {},
            at: Date.parse(e.timestamp),
            resultAt: r ? Date.parse(r.timestamp) : Infinity,
            output: r ? textOf(r.message) : "",
            isError: r?.message.isError ?? false,
          };
        }),
    );
}

// The parent session, every agent session under it, and each agent's latest record.
function trace(w) {
  const [parentFile] = jsonlFiles(join(w.agentDir, "sessions"));
  const files = [parentFile, ...jsonlFiles(join(w.agentDir, "pstack"))].filter(Boolean);
  const sessions = new Map(files.map((f) => [f, readEntries(f)]));
  const records = new Map();
  for (const entries of sessions.values()) {
    for (const e of entries) if (e.type === "custom" && e.customType === "pstack-agents") records.set(e.data.id, e.data);
  }
  const parent = sessions.get(parentFile) ?? [];
  // Agents may start agents of their own; the skills govern only what the lead dispatched.
  const leads = new Set(parent.filter((e) => e.type === "custom" && e.customType === "pstack-agents").map((e) => e.data.id));
  const sessionOf = (r) => [...sessions].find(([f]) => f.startsWith(r.sessionDir) && f.includes(r.sessionId))?.[1] ?? [];
  const texts = (entries) =>
    entries
      .map((e, i) => ({ i, at: Date.parse(e.timestamp), text: e.type === "message" && e.message.role === "assistant" ? textOf(e.message) : "" }))
      .filter((t) => t.text);
  return {
    parent,
    records: [...records.values()].filter((r) => leads.has(r.id)),
    allRecords: [...records.values()],
    sessionOf,
    textOf,
    calls,
    texts,
    allCalls: () => [...sessions.values()].flatMap(calls),
    finalText: texts(parent).at(-1)?.text ?? "",
  };
}

async function pool(items, size, fn) {
  const queue = [...items];
  await Promise.all(Array.from({ length: size }, async () => {
    while (queue.length) await fn(queue.shift());
  }));
}

const only = opts.only?.split(",");
const selected = scenarios.filter((s) => !only || only.includes(s.name));
const runs = Number(opts.runs);
const results = [];
await pool(
  selected.flatMap((s) => Array.from({ length: runs }, (_, i) => ({ s, n: i + 1 }))),
  Number(opts.jobs),
  async ({ s, n }) => {
    const started = Date.now();
    let w;
    let checks;
    let error;
    try {
      w = await makeWorld(s);
      await s.setup?.(w);
      const run = await s.drive(w, { piPrint, PiRpc });
      checks = await s.checks({ w, run, t: trace(w) });
    } catch (e) {
      error = e;
      checks = [["the run finished without an error", false]];
    }
    const failed = checks.filter(([, ok]) => !ok);
    results.push({ s: s.name, n, checks });
    const kept = w && (failed.length || opts.keep);
    console.log(
      `[${s.name} #${n}] ${checks.length - failed.length}/${checks.length} checks in ${Math.round((Date.now() - started) / 1000)} s` +
        (kept ? `, kept ${w.root}` : ""),
    );
    for (const [name] of failed) console.log(`    FAIL  ${name}`);
    if (error) console.log(`    ${error.stack}`);
    if (w && !kept) rmSync(w.root, { recursive: true, force: true });
  },
);

console.log("\nscenario       passes  check");
let allPassed = true;
for (const s of selected) {
  const mine = results.filter((r) => r.s === s.name);
  const names = [...new Set(mine.flatMap((r) => r.checks.map(([name]) => name)))];
  for (const name of names) {
    const passes = mine.filter((r) => r.checks.some(([c, ok]) => c === name && ok)).length;
    if (passes < mine.length) allPassed = false;
    console.log(`${s.name.padEnd(14)} ${`${passes}/${mine.length}`.padEnd(7)} ${name}`);
  }
}
process.exit(allPassed ? 0 : 1);
