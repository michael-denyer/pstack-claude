#!/usr/bin/env bun
// Runs a real pstack workflow on real pi: /skill:interrogate over a branch with a
// planted off-by-one, in print mode, then checks the session files for what the
// workflow must do on Pi. Costs real model calls, so it is a script, not a test.
//
//   bun tests/pi/dogfood.mjs [--keep]
//
// Reads PSTACK_PI_LIVE_MODELS like the live suite (a `pi models:` line).
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseSheet } from "../../plugins/pstack/pi/config.ts";
import { gitRepo } from "./harness.mjs";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const PI_MODELS =
  process.env.PSTACK_PI_LIVE_MODELS ??
  "pi models: opus=openai-codex/gpt-6-astra, fable=openai-codex/gpt-6-sol, sonnet=openai-codex/gpt-6-luna, haiku=openai-codex/gpt-6-luna";
const SHEET = `${PI_MODELS}\ninterrogate reviewers: opus, fable, sonnet\nsession hook: on\n`;
const MODELS = parseSheet(SHEET).piModels;

const root = mkdtempSync(join(tmpdir(), "pstack-pi-dogfood-"));
const agentDir = join(root, "agent");
const work = join(root, "work");
mkdirSync(agentDir);
mkdirSync(work);
symlinkSync(join(homedir(), ".pi", "agent", "auth.json"), join(agentDir, "auth.json"));
const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_TELEMETRY: "0" };
delete env.PSTACK_PI_CHILD;
delete env.PSTACK_PI_BIN;
const install = spawnSync("pi", ["install", repoRoot], { cwd: work, env, encoding: "utf8" });
if (install.status !== 0) throw new Error(`pi install failed: ${install.stderr}`);
writeFileSync(join(agentDir, "pstack-models.md"), SHEET);

const git = gitRepo(work);
git("checkout", "-q", "-b", "paginate");
writeFileSync(
  join(work, "paginate.js"),
  `// Returns the items on a page. Pages are numbered from 1.
export function paginate(items, page, size) {
  if (size <= 0) throw new RangeError("size must be positive");
  return items.slice(page * size, page * size + size);
}
`,
);
git("add", "paginate.js");
git("commit", "-q", "-m", "Add paginate(items, page, size); pages are numbered from 1");

const prompt =
  "/skill:interrogate Review the change on this branch against main. Intent: add paginate(items, page, size), " +
  "which returns the items on the given page, with pages numbered from 1.";
const started = Date.now();
const run = spawnSync("pi", ["--mode", "json", "-p", "--model", MODELS.get("opus"), "--thinking", "medium"], {
  cwd: work,
  env,
  input: prompt,
  encoding: "utf8",
  timeout: 20 * 60_000,
  maxBuffer: 256 * 1024 * 1024,
});
const events = run.stdout.split("\n").filter(Boolean).map((l) => JSON.parse(l));

const readEntries = (file) => readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const sessionsDir = join(agentDir, "sessions");
const parentFile = readdirSync(sessionsDir).flatMap((d) => readdirSync(join(sessionsDir, d)).map((f) => join(sessionsDir, d, f)))[0];
const parent = readEntries(parentFile);
// /skill:<name> inlines the SKILL.md body into the first user message, so no read call is needed for it.
const firstUser = parent.find((e) => e.type === "message" && e.message.role === "user")?.message.content ?? "";
const firstUserText = typeof firstUser === "string" ? firstUser : firstUser.map((c) => c.text ?? "").join("");
const toolCalls = parent
  .filter((e) => e.type === "message" && e.message.role === "assistant")
  .flatMap((e) => e.message.content.filter((c) => c.type === "toolCall"));
const reads = toolCalls.filter((c) => c.name === "read").map((c) => c.arguments.path ?? c.arguments.file_path ?? "");
const agentCalls = toolCalls.filter((c) => c.name === "agent").map((c) => c.arguments);
const records = new Map();
for (const e of parent) if (e.type === "custom" && e.customType === "pstack-agents") records.set(e.data.id, e.data);

const childModels = [];
const walk = (p) => {
  if (statSync(p).isDirectory()) for (const n of readdirSync(p)) walk(join(p, n));
  else if (p.endsWith(".jsonl") && p !== parentFile) {
    const models = new Set(readEntries(p).filter((e) => e.type === "message" && e.message.role === "assistant").map((e) => e.message.model));
    childModels.push([...models].join(","));
  }
};
walk(join(agentDir, "pstack"));

const finalText = parent
  .filter((e) => e.type === "message" && e.message.role === "assistant")
  .map((e) => e.message.content.filter((c) => c.type === "text").map((c) => c.text).join("\n"))
  .filter(Boolean)
  .at(-1);

const checks = {
  "pi exited 0": run.status === 0,
  "the run ended with agent_settled": events.at(-1)?.type === "agent_settled",
  "the prompt carried interrogate's SKILL.md": firstUserText.includes('<skill name="interrogate"') && firstUserText.includes("On Pi, read the [platform mapping]"),
  "the parent read pi-tools.md": reads.some((p) => p.includes("pi-tools.md")),
  "three reviewers were dispatched": agentCalls.length === 3,
  "every reviewer was readonly": [...records.values()].length === 3 && [...records.values()].every((r) => r.readonly === true),
  "the reviewers ran on three distinct models": new Set([...records.values()].map((r) => r.model)).size === 3,
  "each reviewer's session used its own model": childModels.length === 3 && new Set(childModels).size === 3,
  "every reviewer completed": [...records.values()].every((r) => r.status === "completed"),
  "the verdict has an Act On section": /act on/i.test(finalText ?? ""),
  "the verdict names the page offset bug": /(page\s*-\s*1|\(page - 1\)|off[- ]by[- ]one|first page|skips?)/i.test(finalText ?? ""),
};

console.log(`root: ${root}`);
console.log(`elapsed: ${Math.round((Date.now() - started) / 1000)} s, exit ${run.status}, signal ${run.signal}`);
console.log(`agent calls: ${JSON.stringify(agentCalls.map((a) => ({ model: a.model, readonly: a.readonly, type: a.subagent_type })))}`);
console.log(`child models: ${childModels.join(" | ")}`);
console.log(`reads: ${reads.join(", ")}`);
for (const [name, ok] of Object.entries(checks)) console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
console.log(`\n--- final verdict ---\n${finalText}`);
if (run.status !== 0) console.log(`stderr: ${run.stderr.slice(-2000)}`);
if (!process.argv.includes("--keep")) rmSync(root, { recursive: true, force: true });
process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
