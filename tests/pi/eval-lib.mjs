// The eval's world, trace, and helpers that scenario files import.
//
// A scenario is an object, default-exported (alone or in an array) from
// tests/pi/eval/<skill>.mjs, which `bun tests/pi/eval.mjs` loads:
//
//   name     unique; `--only <name>` selects it.
//   repo     optional key of REPOS ("zustand"). `work/` is then a fresh clone of
//            that repo with its dependencies linked in; without it `work/` is an
//            empty git repo on `main` holding one README commit.
//   sheet    optional extra lines for the Pi override sheet (pstack-models.md),
//            e.g. "why investigators: sonnet\n".
//   setup    optional (w) => void | Promise, run before drive.
//   drive    (w, { piPrint, PiRpc }) => run. Drives real pi. piPrint(w, prompt,
//            { model, timeoutMs }) resolves { status, signal, stdout, stderr, events }.
//   checks   ({ w, run, t }) => [name, boolean][]. Each name states one
//            requirement of the skill the scenario runs. Read only pi's session
//            files (t) and the repo afterwards (w).
//
// w: { root, agentDir, work, env, models, git }. w.models maps a model alias
//   ("opus", "fable", "sonnet", "haiku") to the provider/id it resolves to, the
//   sheet's `pi models:` line included. w.git(...args) runs git in work/ and
//   returns trimmed stdout. w.env is the child env pi runs with.
// t: { parent, records, allRecords, sessionOf, textOf, calls, texts, allCalls,
//   finalText }. t.records are the agents the lead dispatched, t.allRecords
//   every agent at any depth; each is the extension's AgentRecord (model,
//   subagentType, readonly, status, startedAt, endedAt, ...). t.calls(entries)
//   lists tool calls with args, output, and call/result times; t.sessionOf(r) is
//   an agent's session entries; t.texts(entries) its assistant texts;
//   t.finalText the lead's last text.
//
// Every world is read-only toward GitHub: a clone's push URL and every network
// push URL route to a git remote helper that refuses, and PATH starts with a
// `gh` that refuses any command that could write to GitHub. makeWorld proves
// both before returning.
import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

import { gitRepo, jsonLines, liveModels } from "./harness.mjs";

export const MINUTE = 60_000;
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

// Each repo's clone URL, its install command (run once in the cache), the
// commands its world puts on PATH, and env its world needs. A world links the
// cache's node_modules, so pnpm must not check it against the clone's path:
// that check wants to purge and reinstall the shared cache.
const PNPM = ["npx", "--yes", "pnpm@11.3.0"];
const REPOS = {
  zustand: {
    url: "https://github.com/pmndrs/zustand.git",
    install: [...PNPM, "install", "--frozen-lockfile"],
    bin: { pnpm: PNPM },
    env: { pnpm_config_verify_deps_before_run: "false" },
  },
};

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

async function execOk(command, args, options) {
  const r = await exec(command, args, options);
  if (r.status !== 0) throw new Error(`${command} ${args.join(" ")} failed (${r.status ?? r.signal}): ${r.stderr.slice(-2000)}`);
  return r;
}

const gitIn = (dir) => (...args) => {
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};

// A full-history clone with dependencies installed, built once and shared by
// every run. `<name>.ready` marks a finished build; `<name>.lock` serializes
// builders across processes.
const cacheRoot = join(homedir(), ".cache", "pstack-pi-eval");
const builds = new Map();
function repoCache(name) {
  if (!builds.has(name)) builds.set(name, buildCache(name));
  return builds.get(name);
}

async function buildCache(name) {
  const spec = REPOS[name];
  if (!spec) throw new Error(`unknown repo "${name}"; known: ${Object.keys(REPOS).join(", ")}`);
  const dir = join(cacheRoot, name);
  const ready = `${dir}.ready`;
  const lock = `${dir}.lock`;
  mkdirSync(cacheRoot, { recursive: true });
  for (const deadline = Date.now() + 30 * MINUTE; !existsSync(ready); ) {
    try {
      mkdirSync(lock);
    } catch {
      if (Date.now() > deadline) throw new Error(`${lock} held for 30 minutes; remove it if no build is running`);
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }
    try {
      if (existsSync(ready)) break;
      rmSync(dir, { recursive: true, force: true });
      await execOk("git", ["clone", "-q", spec.url, dir], { timeoutMs: 10 * MINUTE });
      const [command, ...args] = spec.install;
      await execOk(command, args, { cwd: dir, timeoutMs: 20 * MINUTE });
      writeFileSync(ready, `${gitIn(dir)("rev-parse", "HEAD")}\n`);
    } finally {
      rmSync(lock, { recursive: true, force: true });
    }
  }
  return dir;
}

export const GUARD = "pstack eval world: GitHub is read-only here";
const PUSH_BLOCKED = "readonly://push-disabled/";

// Read-only verbs per gh command; null allows the command with any arguments.
// Everything else is refused, so a write the table forgot fails closed.
const GH_READ_ONLY = {
  pr: ["view", "list", "diff", "checks", "status", "checkout"],
  issue: ["view", "list", "status"],
  repo: ["view", "list", "clone"],
  release: ["view", "list", "download"],
  run: ["view", "list", "watch", "download"],
  workflow: ["view", "list"],
  search: null,
  label: ["list"],
  gist: ["view", "list"],
  cache: ["list"],
  ruleset: ["view", "list", "check"],
  auth: ["status"],
  status: null,
  browse: null,
  help: null,
  version: null,
  "--version": null,
};

const ghShim = (realGh) => `#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const READ_ONLY = ${JSON.stringify(GH_READ_ONLY)};
const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith("-"));
function refusal() {
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) return null;
  const [command, verb] = positional;
  if (command === "api") {
    const method = args.flatMap((a, i) =>
      a === "-X" || a === "--method" ? [args[i + 1]] : a.startsWith("--method=") ? [a.slice(9)] : a.startsWith("-X") && a.length > 2 ? [a.slice(2)] : [],
    );
    if (method.some((m) => !/^(GET|HEAD)$/i.test(String(m)))) return "gh api with a non-GET method";
    if (args.some((a) => /^(-f|-F|--field|--raw-field|--input)(=|$)/.test(a) || /^-[fF]./.test(a))) return "gh api with request fields";
    if (positional[1] === "graphql") return "gh api graphql";
    return null;
  }
  if (!(command in READ_ONLY)) return "gh " + command;
  const verbs = READ_ONLY[command];
  return verbs === null || verbs.includes(verb) ? null : "gh " + command + " " + (verb ?? "");
}
const refused = refusal();
if (refused) {
  process.stderr.write(${JSON.stringify(GUARD)} + ": " + refused.trim() + " could write to GitHub, so it is refused.\\n");
  process.exit(1);
}
const r = spawnSync(${JSON.stringify(realGh)}, args, { stdio: "inherit" });
process.exit(r.status ?? 1);
`;

const pushHelper = `#!/bin/sh
echo "${GUARD}: git push is disabled." >&2
exit 1
`;

function realGh(env) {
  const r = spawnSync("sh", ["-c", "command -v gh"], { env, encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : "gh-not-installed";
}

// Puts the gh shim and the refusing push helper first on PATH, and routes every
// network push URL to that helper, whatever repo the push runs in.
function guardEnv(root, env) {
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), ghShim(realGh(env)));
  writeFileSync(join(bin, "git-remote-readonly"), pushHelper);
  chmodSync(join(bin, "gh"), 0o755);
  chmodSync(join(bin, "git-remote-readonly"), 0o755);
  const prefixes = ["https://", "http://", "ssh://", "git://", "git@"];
  const guarded = { ...env, PATH: `${bin}${delimiter}${env.PATH}`, GIT_CONFIG_COUNT: String(prefixes.length) };
  prefixes.forEach((p, i) => {
    guarded[`GIT_CONFIG_KEY_${i}`] = `url.${PUSH_BLOCKED}.pushInsteadOf`;
    guarded[`GIT_CONFIG_VALUE_${i}`] = p;
  });
  return guarded;
}

// The writes a world must refuse, each with the output it produced.
export function guardCheck(w) {
  const run = (command, ...args) => {
    const r = spawnSync(command, args, { cwd: w.work, env: w.env, encoding: "utf8", timeout: 30_000 });
    return { command: [command, ...args].join(" "), status: r.status, output: `${r.stdout}${r.stderr}`.trim() };
  };
  const attempts = [
    run("git", "push", "https://github.com/pmndrs/zustand.git", "HEAD:refs/heads/pstack-eval"),
    run("gh", "pr", "comment", "1", "-b", "x"),
    run("gh", "api", "-X", "POST", "repos/pmndrs/zustand/issues", "-f", "title=x"),
  ];
  if (w.git("remote").includes("origin")) attempts.unshift(run("git", "push"));
  return attempts.map((a) => ({ ...a, refused: a.status !== 0 && a.output.includes(GUARD) }));
}

async function cloneInto(root, work, env, name) {
  const cache = await repoCache(name);
  for (const [command, argv] of Object.entries(REPOS[name].bin ?? {})) {
    writeFileSync(join(root, "bin", command), `#!/bin/sh\nexec ${argv.join(" ")} "$@"\n`);
    chmodSync(join(root, "bin", command), 0o755);
  }
  Object.assign(env, REPOS[name].env);
  // --shared borrows the cache's objects; /tmp is often another filesystem, where --local cannot hardlink.
  await execOk("git", ["clone", "-q", "--shared", cache, work]);
  const git = gitIn(work);
  git("remote", "set-url", "origin", REPOS[name].url);
  git("remote", "set-url", "--push", "origin", PUSH_BLOCKED);
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  if (existsSync(join(cache, "node_modules"))) {
    symlinkSync(join(cache, "node_modules"), join(work, "node_modules"));
    appendFileSync(join(work, ".git", "info", "exclude"), "/node_modules\n");
  }
  return git;
}

export async function makeWorld(scenario) {
  const { sheet, models } = liveModels(join(repoRoot, "plugins/pstack"), "", scenario.sheet ?? "");
  const root = mkdtempSync(join(tmpdir(), `pstack-pi-eval-${scenario.name}-`));
  const agentDir = join(root, "agent");
  const work = join(root, "work");
  mkdirSync(agentDir);
  mkdirSync(work);
  symlinkSync(join(homedir(), ".pi", "agent", "auth.json"), join(agentDir, "auth.json"));
  const base = { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_TELEMETRY: "0" };
  for (const key of Object.keys(base)) {
    if ((key.startsWith("PI_") && key !== "PI_CODING_AGENT_DIR" && key !== "PI_TELEMETRY") || key.startsWith("PSTACK_PI_") || key.startsWith("GIT_CONFIG_")) delete base[key];
  }
  try {
    const env = guardEnv(root, base);
    const git = scenario.repo ? await cloneInto(root, work, env, scenario.repo) : gitRepo(work);
    const w = { root, agentDir, work, env, models, git };
    const leaks = guardCheck(w).filter((a) => !a.refused);
    if (leaks.length) throw new Error(`the world's GitHub guard let writes through: ${JSON.stringify(leaks)}`);
    const install = await exec("pi", ["install", repoRoot], { cwd: work, env });
    if (install.status !== 0) throw new Error(`pi install failed: ${install.stderr}`);
    writeFileSync(join(agentDir, "pstack-models.md"), sheet);
    return w;
  } catch (e) {
    rmSync(root, { recursive: true, force: true });
    throw e;
  }
}

export const piPrint = (w, prompt, { model = w.models.get("opus"), timeoutMs = 20 * MINUTE } = {}) =>
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
export function trace(w) {
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

export const writeFiles = (dir, files) => {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
};

export const isEdit = (c, file) => (c.name === "edit" || c.name === "write") && String(c.args.path ?? "").endsWith(file);
export const settled = (run) => run.events.at(-1)?.type === "agent_settled";
export const firstUserText = (t) => {
  const u = t.parent.find((e) => e.type === "message" && e.message.role === "user");
  return u ? t.textOf(u.message) : "";
};
export const readPiTools = (t) => t.calls(t.parent).some((c) => c.name === "read" && String(c.args.path).endsWith("pi-tools.md"));
export const notices = (t) => t.parent.flatMap((e, i) => (e.type === "custom_message" && e.customType === "pstack-agent" ? [i] : []));
export const sessionModels = (t, r) =>
  [...new Set(t.sessionOf(r).filter((e) => e.type === "message" && e.message.role === "assistant").map((e) => `${e.message.provider}/${e.message.model}`))];
// The prompt an agent was started with: the first user message of its session.
export const agentPrompt = (t, r) => {
  const u = t.sessionOf(r).find((e) => e.type === "message" && e.message.role === "user");
  return u ? t.textOf(u.message) : "";
};

// Runs `fn(dir)` in a throwaway detached checkout of `sha`.
export function atCommit(w, sha, fn) {
  const dir = join(w.root, `at-${sha.slice(0, 12)}`);
  w.git("worktree", "add", "-q", "--detach", dir, sha);
  try {
    return fn(dir);
  } finally {
    w.git("worktree", "remove", "--force", dir);
  }
}

export const node = (dir, ...args) => spawnSync("node", args, { cwd: dir, encoding: "utf8", timeout: 60_000 });
