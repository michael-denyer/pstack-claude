#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureDevinProfile } from "../plugins/pstack/skills/setup-pstack/scripts/devin-profile.mjs";

if (spawnSync("devin", ["--version"], { encoding: "utf8" }).error?.code === "ENOENT") {
  console.log("SKIP: devin is not installed");
  process.exit(0);
}

const plugin = fileURLToPath(new URL("../plugins/pstack", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "pstack-devin-smoke-"));
const project = join(root, "project");
const xdg = join(root, "config");
const exportPath = join(root, "session.json");
const env = { ...process.env, XDG_CONFIG_HOME: xdg, CLAUDE_PLUGIN_ROOT: plugin };
const command = (args, cwd = project) => {
  const result = spawnSync("devin", args, { cwd, env, encoding: "utf8", timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${args.join(" ")} failed:\n${result.stderr}\n${result.stdout}`);
  return result.stdout;
};

let passed = false;
try {
  mkdirSync(join(project, ".devin"), { recursive: true });
  mkdirSync(join(xdg, "devin"), { recursive: true });
  writeFileSync(join(xdg, "devin/config.json"), JSON.stringify({ version: 1, shell: { setup_complete: true },
    read_config_from: { agents_standard: false, cursor: false, windsurf: false, claude: false, copilot: false, opencode: false, zed: false } }));
  symlinkSync(join(plugin, "skills"), join(project, ".devin/skills"), "dir");
  writeFileSync(join(project, ".devin/hooks.v1.json"), readFileSync(join(plugin, "hooks.json")));
  const models = command(["models", "list"]);
  const uids = [...models.matchAll(/^  (\S+)\s{2,}/gm)].map((match) => match[1]).filter((uid) => uid !== "aliases:");
  const model = process.env.PSTACK_DEVIN_SMOKE_MODEL ?? (uids.includes("swe-1-6") ? "swe-1-6" : uids[0]);
  assert(uids.includes(model), `smoke model ${model} was not listed by devin models list`);
  const { name, path } = ensureDevinProfile({ model, agentsDir: join(xdg, "devin/agents") });
  assert(readFileSync(path, "utf8").includes(`model: ${JSON.stringify(model)}\n`), "profile pins the listed UID");
  const prompt = `This is a read-only pstack integration test. Invoke the shared unslop skill with the skill tool. Then launch one foreground subagent with run_subagent using profile ${name}, title "pstack smoke child", and task "Reply with exactly PSTACK_DEVIN_CHILD_OK. Use no tools and change no files." I explicitly authorize that subagent. After its tool result, report the result. Do not read or edit any files, run shell commands, or launch any other subagents.`;
  command(["--model", model, "--respect-workspace-trust", "false", "--export", exportPath, "-p", prompt]);
  const exported = JSON.parse(readFileSync(exportPath, "utf8"));
  const system = exported.steps.filter((step) => step.source === "system").map((step) => step.message ?? "").join("\n");
  assert(system.includes("You have pstack."), "real project hook injected the routing mandate");
  assert(system.includes(`${plugin}/skills/poteto-mode/references/devin-tools.md`), "hook injected the actual mapping path");
  assert(system.includes(name), "session discovered the generated global profile");
  const calls = exported.steps.flatMap((step) => (step.tool_calls ?? []).map((call) => ({ call, step })));
  const invoked = calls.find(({ call }) => call.function_name === "skill" && call.arguments.skill === "unslop");
  assert(invoked, "export records the real shared unslop skill invocation");
  const skillResult = invoked.step.observation?.results?.find((result) => result.source_call_id === invoked.call.tool_call_id)?.content ?? "";
  assert(skillResult.includes("Unslop") && skillResult.includes("Patterns to detect"), "skill tool returned the actual shipped skill body");
  const source = skillResult.match(/^Source: (.+)$/m)?.[1];
  assert(source, "skill invocation records its source file");
  assert.equal(realpathSync(source), realpathSync(join(plugin, "skills/unslop/SKILL.md")), "invoked skill comes from the actual shared tree");
  const dispatched = calls.find(({ call }) => call.function_name === "run_subagent" && call.arguments.profile === name);
  assert(dispatched, "export records native run_subagent dispatch with the generated profile");
  assert.notEqual(dispatched.call.arguments.is_background, true, "smoke child runs in foreground");
  const result = dispatched.step.observation?.results?.find((entry) => entry.source_call_id === dispatched.call.tool_call_id)?.content ?? "";
  assert(result.includes("completed successfully") && result.includes("PSTACK_DEVIN_CHILD_OK"), "native child tool result contains the sentinel");
  assert(calls.every(({ call }) => ["skill", "run_subagent"].includes(call.function_name)), "smoke made only the authorized tool calls");
  console.log(`PASS: project routing, shared skill invocation, global pinned profile ${name}, and native child result on ${model}`);
  console.log("UNVERIFIED: native plugin installation and native hook-root expansion require a policy-permitted install; this smoke uses project hooks.");
  passed = true;
} finally {
  if (passed && !process.env.PSTACK_DEVIN_SMOKE_KEEP) rmSync(root, { recursive: true, force: true });
  else console.error(`Artifacts: ${root}`);
}
