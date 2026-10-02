// The pstack Pi extension end to end on real pi and real models. Skipped unless
// PSTACK_PI_LIVE=1. Each run builds a throwaway PI_CODING_AGENT_DIR with the
// user's credentials symlinked in and this repo installed as a package, so
// children load pstack too. Nothing under ~/.pi is written.
//
// The aliases resolve through the shipped models.json table of
// PSTACK_PI_LIVE_PROVIDER (default openai), or through the `pi models:`
// line in PSTACK_PI_LIVE_MODELS when it is set. The parent runs on the sonnet
// alias. PSTACK_PI_LIVE_KEEP=1 keeps the throwaway directory for inspection.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { openingPrompt } from "../../plugins/pstack/skills/reflect/scripts/find-transcript.mjs";
import { agentBody, alive as pidAlive, gitRepo, pluginRoot, readEntries, sleep } from "./harness.mjs";
import { agentByDescription, assistantModels, childEntries, descendants, jsonLines, liveModels, MINUTE, PiRpc, processTable, sections, textOf } from "./live-harness.mjs";

const LIVE = process.env.PSTACK_PI_LIVE === "1";
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const { sheet: SHEET, models: MODELS } = liveModels(pluginRoot, "# pstack live test sheet\n\n");
const PARENT_MODEL = MODELS.get("sonnet");
const MANDATE = readFileSync(join(pluginRoot, "hooks/session-start-context.md"), "utf8");
const MANDATE_KEY = "pstack-session-start";
const SHEET_KEY = "pstack-models";
// Pi stores an extension's prompt section wrapped in a tag named by its key.
const tagged = (key, text) => `<${key}>\n${text}\n</${key}>`;

let root;
let agentDir;
let work;
let env;
let git;

function writeSheet(text) {
  writeFileSync(join(agentDir, "pstack-models.md"), text);
}

async function withParent(fn) {
  const parent = new PiRpc({ cwd: work, env, model: PARENT_MODEL, thinking: "low" });
  try {
    return await fn(parent);
  } finally {
    await parent.close();
  }
}

function parentSessionFile(sessionId) {
  const dir = join(agentDir, "sessions");
  const files = readdirSync(dir, { recursive: true }).filter((f) => f.endsWith(`_${sessionId}.jsonl`));
  expect(files).toHaveLength(1);
  return join(dir, files[0]);
}

const suite = LIVE ? describe : describe.skip;

suite("pstack on live pi", () => {
  beforeAll(() => {
    // realpath: macOS's tmpdir is a symlink, and git reports the worktree's real path.
    root = realpathSync(mkdtempSync(join(tmpdir(), "pstack-pi-live-")));
    agentDir = join(root, "agent");
    work = join(root, "work");
    mkdirSync(agentDir);
    mkdirSync(work);
    symlinkSync(join(homedir(), ".pi", "agent", "auth.json"), join(agentDir, "auth.json"));
    env = { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_TELEMETRY: "0" };
    delete env.PSTACK_PI_DEPTH;
    const install = spawnSync("pi", ["install", repoRoot], { cwd: work, env, encoding: "utf8" });
    if (install.status !== 0) throw new Error(`pi install failed: ${install.stderr}`);
    // Keep no recent tokens so a two-turn session is big enough to compact.
    const settingsFile = join(agentDir, "settings.json");
    const settings = JSON.parse(readFileSync(settingsFile, "utf8"));
    writeFileSync(settingsFile, JSON.stringify({ ...settings, compaction: { keepRecentTokens: 0 } }, null, 2));
    writeSheet(SHEET);
    git = gitRepo(work);
    console.log(`live root: ${root}`);
  });

  afterAll(() => {
    if (!root) return;
    let calls = 0;
    const walk = (p) => {
      if (statSync(p).isDirectory()) for (const n of readdirSync(p)) walk(join(p, n));
      else if (p.endsWith(".jsonl"))
        for (const e of readEntries(p)) if ((e.type === "message" && e.message.role === "assistant") || e.type === "compaction") calls++;
    };
    walk(agentDir);
    console.log(`model calls recorded in session files: ${calls}`);
    if (process.env.PSTACK_PI_LIVE_KEEP !== "1") rmSync(root, { recursive: true, force: true });
  });

  test(
    "panel: three background agents on opus, fable, and sonnet each notify, on their own resolved model",
    async () => {
      await withParent(async (parent) => {
        const from = await parent.run(
          [
            "In this one turn, make exactly three agent tool calls, each with run_in_background true:",
            '1. description "panel-opus", model "opus", prompt "Reply with exactly one word: alpha"',
            '2. description "panel-fable", model "fable", prompt "Reply with exactly one word: beta"',
            '3. description "panel-sonnet", model "sonnet", prompt "Reply with exactly one word: gamma"',
            "After the calls, reply with exactly one word: started. Reply to each completion notice with exactly one word: noted.",
          ].join("\n"),
        );
        await parent.until(() => parent.notices(from).length >= 3, 4 * MINUTE, "three notices");
        await parent.idle(from);
        const file = await parent.sessionFile();

        const expected = { "panel-opus": ["opus", "alpha"], "panel-fable": ["fable", "beta"], "panel-sonnet": ["sonnet", "gamma"] };
        const notices = parent.notices(from);
        expect(notices).toHaveLength(3);
        const seen = new Set();
        for (const [description, [alias, word]] of Object.entries(expected)) {
          const snaps = agentByDescription(file, description);
          const last = snaps.at(-1);
          expect(last).toMatchObject({ status: "completed", agent: { model: MODELS.get(alias) } });
          expect(pidAlive(last.pid)).toBe(false);
          const notice = notices.find((n) => n.details.agentId === last.agent.id);
          expect(notice.details.status).toBe("completed");
          expect(textOf(notice).toLowerCase()).toContain(word);
          const child = childEntries(last);
          expect([...assistantModels(child)]).toEqual([MODELS.get(alias)]);
          const childSections = sections(child);
          expect(childSections[SHEET_KEY]).toBe(tagged(SHEET_KEY, SHEET));
          expect(childSections[MANDATE_KEY]).toBeUndefined();
          seen.add(MODELS.get(alias));
        }
        expect(seen.size).toBe(3);
      });
    },
    8 * MINUTE,
  );

  test(
    "stop: stop_agent kills a running agent's process tree and list_agents shows it stopped",
    async () => {
      await withParent(async (parent) => {
        const from = await parent.run(
          'Make one agent tool call with run_in_background true, description "sleeper", prompt "Use the bash tool to run exactly this command and wait for it: sleep 300". Then reply with exactly one word: started.',
        );
        const file = await parent.sessionFile();
        const record = agentByDescription(file, "sleeper")[0];
        expect(pidAlive(record.pid)).toBe(true);
        const sleeper = await parent.until(
          () => descendants(record.pid).find((p) => /(^|\/|\s)sleep 300\b/.test(p.args)),
          3 * MINUTE,
          "the child's sleep 300",
        );
        const tree = descendants(record.pid).map((p) => p.pid);

        const stopFrom = await parent.run(
          `Call stop_agent with id "${record.agent.id}". Then call list_agents. Then reply with exactly one word: stopped. Reply to any completion notice with exactly one word: noted.`,
        );
        const [stopResult] = parent.toolResults("stop_agent", stopFrom);
        expect(JSON.parse(textOf(stopResult))).toMatchObject({ agentId: record.agent.id, status: "stopped" });
        expect(pidAlive(record.pid)).toBe(false);
        expect(pidAlive(sleeper.pid)).toBe(false);
        expect(tree.filter(pidAlive)).toEqual([]);
        expect(processTable().filter((p) => p.pgid === record.pid)).toEqual([]);
        const [listResult] = parent.toolResults("list_agents", stopFrom);
        expect(JSON.parse(textOf(listResult)).find((a) => a.id === record.agent.id).status).toBe("stopped");
        expect(agentByDescription(file, "sleeper").at(-1).status).toBe("stopped");
        const notice = parent.notices(from).find((n) => n.details.agentId === record.agent.id);
        expect(notice.details.status).toBe("stopped");
        expect(textOf(notice)).toContain("(stopped before it replied)");
      });
    },
    8 * MINUTE,
  );

  test(
    "resume: send_message to a finished agent answers from its first run, in the same session file",
    async () => {
      await withParent(async (parent) => {
        const from = await parent.run(
          [
            'Make one agent tool call in the foreground (run_in_background false), description "keeper", prompt "Remember this code word: PELICAN-42. Reply with exactly one word: stored".',
            'After it returns, call send_message with to "keeper" and message "What was the code word I gave you earlier? Reply with the code word only." Do not repeat the code word in your message.',
            "Then reply with exactly one word: sent. Reply to the completion notice with exactly one word: noted.",
          ].join("\n"),
        );
        await parent.until(() => parent.notices(from).length >= 1, 3 * MINUTE, "the resume notice");
        await parent.idle(from);
        const file = await parent.sessionFile();
        const snaps = agentByDescription(file, "keeper");
        const [notice] = parent.notices(from);
        expect(notice.details).toMatchObject({ agentId: snaps[0].agent.id, status: "completed" });
        expect(textOf(notice)).toContain("PELICAN-42");
        expect(new Set(snaps.map((s) => s.agent.sessionId)).size).toBe(1);
        const prompts = childEntries(snaps[0])
          .filter((e) => e.type === "message" && e.message.role === "user")
          .map((e) => textOf(e.message));
        expect(prompts).toHaveLength(2);
        expect(prompts[0]).toContain("PELICAN-42");
        expect(prompts[1]).not.toContain("PELICAN");
      });
    },
    6 * MINUTE,
  );

  test(
    "steer: send_message to a running agent reaches that run at its next tool boundary, and it reports once",
    async () => {
      const out = join(root, "steer-out.txt");
      await withParent(async (parent) => {
        const from = await parent.run(
          [
            'Make one agent tool call with run_in_background true, description "steered", and this prompt:',
            `"Use the bash tool to run exactly this command and wait for it: sleep 40. When it finishes, use the write tool to write one word to ${out}: ALPHA, unless a later message told you another word, in which case write that word. Then reply with the word you wrote."`,
            "Then reply with exactly one word: started.",
          ].join("\n"),
        );
        const file = await parent.sessionFile();
        const record = agentByDescription(file, "steered")[0];
        await parent.until(() => descendants(record.pid).some((p) => /(^|\/|\s)sleep 40\b/.test(p.args)), 3 * MINUTE, "the child's sleep 40");

        const sendFrom = await parent.run(
          'Call send_message with to "steered" and message "Change of plan: write BRAVO instead of ALPHA." Then reply with exactly one word: sent. Reply to any completion notice with exactly one word: noted.',
        );
        expect(pidAlive(record.pid)).toBe(true);
        const [sent] = parent.toolResults("send_message", sendFrom);
        expect(sent.details).toEqual({ agentId: record.agent.id, running: true });

        await parent.until(() => parent.notices(from).length >= 1, 4 * MINUTE, "the completion notice");
        await parent.idle(from);
        await sleep(5000);
        const notices = parent.notices(from);
        expect(notices).toHaveLength(1);
        expect(notices[0].details).toMatchObject({ agentId: record.agent.id, status: "completed" });
        expect(textOf(notices[0])).toContain("BRAVO");
        expect(readFileSync(out, "utf8").trim()).toBe("BRAVO");

        const snaps = agentByDescription(file, "steered");
        expect(new Set(snaps.map((s) => s.pid))).toEqual(new Set([record.pid]));
        const child = childEntries(snaps.at(-1));
        const prompts = child.filter((e) => e.type === "message" && e.message.role === "user").map((e) => textOf(e.message));
        expect(prompts).toHaveLength(2);
        expect(prompts[1]).toContain("BRAVO");
        const steerAt = child.findIndex((e) => e.type === "message" && e.message.role === "user" && textOf(e.message).includes("BRAVO"));
        const writes = child.filter((e, i) => i > steerAt && e.type === "message" && e.message.role === "assistant" && e.message.content.some((p) => p.type === "toolCall" && p.name === "write"));
        expect(writes).toHaveLength(1);
      });
    },
    8 * MINUTE,
  );

  test(
    "effort: pstack:effort-high runs the child at thinking high with the effort agent as its system prompt",
    async () => {
      await withParent(async (parent) => {
        await parent.run(
          'Make one agent tool call in the foreground with subagent_type "pstack:effort-high", description "effort", prompt "Reply with exactly one word: done". Then reply with exactly one word: ok.',
        );
        const record = agentByDescription(await parent.sessionFile(), "effort").at(-1);
        expect(record).toMatchObject({ status: "completed", agent: { subagentType: "pstack:effort-high", thinking: "high" } });
        const child = childEntries(record);
        const levels = child.filter((e) => e.type === "thinking_level_change").map((e) => e.thinkingLevel);
        expect(levels.at(-1)).toBe("high");
        const childSections = sections(child);
        expect(childSections.addendum).toContain(agentBody("effort-agents/effort-high.md"));
        expect(childSections[SHEET_KEY]).toBe(tagged(SHEET_KEY, SHEET));
        expect(childSections[MANDATE_KEY]).toBeUndefined();
      });
    },
    5 * MINUTE,
  );

  test(
    "worktree: an isolated agent runs in its own worktree, removed when clean and kept with changes; pstack:poteto-agent carries its agent file",
    async () => {
      await withParent(async (parent) => {
        const cleanFrom = await parent.run(
          'Make one agent tool call in the foreground with isolation "worktree", description "wt-clean", prompt "Run pwd with the bash tool and reply with its output only". Then reply with exactly one word: ok.',
        );
        const file = await parent.sessionFile();
        const clean = agentByDescription(file, "wt-clean").at(-1);
        const prefix = join(work, ".claude", "worktrees", "agent-");
        expect(clean.agent.worktree.path.startsWith(prefix)).toBe(true);
        const [cleanResult] = parent.toolResults("agent", cleanFrom);
        expect(textOf(cleanResult)).toContain(`worktree: ${clean.agent.worktree.path} (no changes; removed)`);
        const bashOut = childEntries(clean)
          .filter((e) => e.type === "message" && e.message.role === "toolResult" && e.message.toolName === "bash")
          .map((e) => textOf(e.message).trim());
        expect(bashOut).toContain(clean.agent.worktree.path);
        expect(existsSync(clean.agent.worktree.path)).toBe(false);
        expect(git("worktree", "list", "--porcelain")).not.toContain(clean.agent.worktree.path);
        expect(git("branch", "--list", clean.agent.worktree.branch)).toBe("");

        const dirtyFrom = await parent.run(
          'Make one agent tool call in the foreground with subagent_type "pstack:poteto-agent", isolation "worktree", description "wt-dirty", prompt "Use the bash tool to run exactly: echo hi > note.txt. Then reply with exactly one word: done". Then reply with exactly one word: ok.',
        );
        const dirty = agentByDescription(file, "wt-dirty").at(-1);
        expect(dirty.agent.subagentType).toBe("pstack:poteto-agent");
        expect(sections(childEntries(dirty)).addendum).toContain(agentBody("agents/poteto-agent.md"));
        const [dirtyResult] = parent.toolResults("agent", dirtyFrom);
        expect(textOf(dirtyResult)).toContain(`worktree: ${dirty.agent.worktree.path} (branch ${dirty.agent.worktree.branch})`);
        expect(readFileSync(join(dirty.agent.worktree.path, "note.txt"), "utf8")).toBe("hi\n");
        expect(git("worktree", "list", "--porcelain")).toContain(dirty.agent.worktree.path);
        git("worktree", "remove", "--force", dirty.agent.worktree.path);
      });
    },
    6 * MINUTE,
  );

  test(
    "wake: schedule_wakeup re-invokes the parent with the stored prompt after 60 s",
    async () => {
      await withParent(async (parent) => {
        const wakePrompt = "WAKE-PING: reply with exactly one word: pong";
        const from = await parent.run(
          `Call schedule_wakeup with delaySeconds 60, reason "live test", and prompt "${wakePrompt}". Then reply with exactly one word: scheduled.`,
        );
        const [scheduled] = parent.toolResults("schedule_wakeup", from);
        expect(scheduled.details.delaySeconds).toBe(60);
        const fired = await parent.until(
          () => parent.messages(from).find((m) => m.role === "user" && textOf(m) === wakePrompt),
          2 * MINUTE,
          "the wakeup prompt",
        );
        expect(fired.at - scheduled.at).toBeGreaterThanOrEqual(59_000);
        await parent.idle(from);
        expect(parent.messages(from).some((m) => m.role === "assistant" && m.at > fired.at)).toBe(true);
      });
    },
    5 * MINUTE,
  );

  test(
    "wake: /loop 1m fires now and again a minute later, and /loop stop cancels it",
    async () => {
      await withParent(async (parent) => {
        const loopPrompt = "LOOP-PING: reply with exactly one word: pong";
        const fires = () => parent.messages().filter((m) => m.role === "user" && textOf(m) === loopPrompt);
        await parent.command("prompt", { message: `/loop 1m ${loopPrompt}` });
        await parent.until(() => fires().length >= 2, 3 * MINUTE, "two loop fires");
        const [first, second] = fires();
        expect(second.at - first.at).toBeGreaterThanOrEqual(59_000);
        await parent.idle(0);

        const stopFrom = parent.events.length;
        await parent.command("prompt", { message: "/loop stop" });
        await parent.until(
          () => parent.events.slice(stopFrom).find((e) => e.type === "extension_ui_request" && e.message === "Loop stopped."),
          30_000,
          "the stop notice",
        );
        await sleep(first.at + 2 * MINUTE + 10_000 - Date.now());
        expect(fires()).toHaveLength(2);
      });
    },
    7 * MINUTE,
  );

  test(
    "hook and transcripts: the mandate survives compaction, session hook: off drops it, and find-transcript finds the session",
    async () => {
      const opening = `LIVE-OPENING-${Date.now()}: reply with exactly one word: hello`;
      await withParent(async (parent) => {
        await parent.run(opening);
        const file = await parent.sessionFile();
        expect(sections(readEntries(file))[MANDATE_KEY]).toBe(tagged(MANDATE_KEY, MANDATE));
        expect(sections(readEntries(file))[SHEET_KEY]).toBe(tagged(SHEET_KEY, SHEET));

        await parent.run("Reply with exactly one word: two");
        await parent.command("compact");
        await parent.run("Reply with exactly one word: again");
        const entries = readEntries(file);
        expect(entries.some((e) => e.type === "compaction")).toBe(true);
        const after = sections(entries);
        expect(after[MANDATE_KEY]).toBe(tagged(MANDATE_KEY, MANDATE));
        expect(after[SHEET_KEY]).toBe(tagged(SHEET_KEY, SHEET));

        const found = spawnSync("node", [join(pluginRoot, "skills/reflect/scripts/find-transcript.mjs"), dirname(file), opening.slice(0, 30)], {
          encoding: "utf8",
        });
        expect(found.stdout.trim()).toBe(file);
        expect(await openingPrompt(file)).toBe(opening);
      });

      const offSheet = SHEET.replace("session hook: on", "session hook: off");
      writeSheet(offSheet);
      try {
        await withParent(async (parent) => {
          await parent.run("Reply with exactly one word: hello");
          const off = sections(readEntries(await parent.sessionFile()));
          expect(off[MANDATE_KEY]).toBeUndefined();
          expect(off[SHEET_KEY]).toBe(tagged(SHEET_KEY, offSheet));
        });
      } finally {
        writeSheet(SHEET);
      }
    },
    6 * MINUTE,
  );

  test(
    "tools: the model calls list_agents at its first turn without tool_search, by default and under codemode only",
    async () => {
      const PSTACK_TOOLS = ["agent", "send_message", "list_agents", "stop_agent", "ask_user_question", "schedule_wakeup"];
      const prompt = "Call the list_agents tool directly as your first action. Then reply with exactly one word: done.";
      const codemodeDir = join(root, "codemode-only");
      mkdirSync(join(codemodeDir, ".pi"), { recursive: true });
      writeFileSync(join(codemodeDir, ".pi", "settings.json"), JSON.stringify({ defaultTools: ["+codemode"], codemode: { mode: "only" } }));
      for (const [cwd, extra] of [[work, []], [codemodeDir, ["--approve"]]]) {
        const run = spawnSync("pi", ["--mode", "json", "-p", "--model", PARENT_MODEL, "--thinking", "low", ...extra, prompt], {
          cwd,
          env,
          encoding: "utf8",
        });
        expect({ cwd, code: run.status, stderr: run.status === 0 ? "" : run.stderr }).toEqual({ cwd, code: 0, stderr: "" });
        const events = run.stdout.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
        const entries = readEntries(parentSessionFile(events.find((e) => e.type === "session").id));
        const system = entries.find((e) => e.type === "message" && e.message.role === "system").message;
        const declared = system.toolsAdded.map((t) => t.name);
        expect({ cwd, declared: PSTACK_TOOLS.filter((t) => declared.includes(t)) }).toEqual({ cwd, declared: PSTACK_TOOLS });
        const calls = entries
          .filter((e) => e.type === "message" && e.message.role === "assistant")
          .flatMap((e) => e.message.content.filter((c) => c.type === "toolCall").map((c) => c.name));
        expect({ cwd, first: calls[0], searched: calls.includes("tool_search") }).toEqual({ cwd, first: "list_agents", searched: false });
      }
    },
    5 * MINUTE,
  );

  test(
    "print mode: a pi --mode json -p parent ends only after its background agent's notice turn",
    async () => {
      const proc = spawn(
        "pi",
        [
          "--mode", "json", "-p", "--model", PARENT_MODEL, "--thinking", "low",
          'Make one agent tool call with run_in_background true, description "printbg", prompt "Reply with exactly one word: ready". Then reply with exactly one word: waiting. When the completion notice arrives, reply with exactly one word: received.',
        ],
        { cwd: work, env, stdio: ["ignore", "pipe", "pipe"] },
      );
      const events = [];
      let stderr = "";
      proc.stdout.on("data", jsonLines((e) => events.push(e)));
      proc.stderr.on("data", (d) => (stderr += d));
      const code = await new Promise((r) => proc.on("close", r));
      expect({ code, stderr: code === 0 ? "" : stderr }).toEqual({ code: 0, stderr: "" });

      const ends = events.filter((e) => e.type === "message_end").map((e) => e.message);
      const noticeAt = ends.findIndex((m) => m.role === "custom" && m.customType === "pstack-agent");
      expect(noticeAt).toBeGreaterThan(-1);
      const notice = ends[noticeAt];
      expect(notice.details.status).toBe("completed");
      expect(textOf(notice).toLowerCase()).toContain("ready");
      expect(ends.slice(noticeAt + 1).some((m) => m.role === "assistant")).toBe(true);
      expect(events.at(-1).type).toBe("agent_settled");
      const sessionId = events.find((e) => e.type === "session").id;
      const record = agentByDescription(parentSessionFile(sessionId), "printbg").at(-1);
      expect(record).toMatchObject({ id: notice.details.agentId, status: "completed" });
      expect(pidAlive(record.pid)).toBe(false);
    },
    5 * MINUTE,
  );
});
