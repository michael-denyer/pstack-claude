import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  type AgentDefinition,
  type Effort,
  loadAgentTypes,
  readSheet,
  resolveModel,
  type Settings,
  stateDir,
} from "./config.ts";
import { post, take } from "./inbox.ts";

export const ENTRY_TYPE = "pstack-agents";
export const NOTICE_TYPE = "pstack-agent";
export const OUTPUT_CAP_BYTES = 50 * 1024;
const STDERR_CAP = 8 * 1024;
const CLOSE_AFTER_EXIT_MS = 2000;
// Claude Code lets agents nest three layers below the main session and withholds
// the Agent tool at the third.
export const MAX_SPAWN_DEPTH = 3;

export type AgentStatus = "running" | "completed" | "failed" | "stopped";

export interface Worktree {
  repo: string;
  path: string;
  branch: string;
  base: string;
  kept?: boolean;
}

// Everything needed to list an agent or resume it, persisted as a session entry.
export interface AgentRecord {
  id: string;
  description: string;
  subagentType: string;
  model?: string;
  thinking?: Effort | ReturnType<ExtensionAPI["getThinkingLevel"]>;
  readonly?: boolean;
  sessionId: string;
  sessionDir: string;
  systemPromptFile?: string;
  cwd: string;
  worktree?: Worktree;
  status: AgentStatus;
  pid?: number;
  exitCode?: number | null;
  startedAt: string;
  endedAt?: string;
  finalText?: string;
  outputFile?: string;
}

interface Run {
  child: ChildProcess;
  stopRequested: boolean;
  // Set by a session-shutdown stop: the session is being torn down, so no notice.
  silent: boolean;
  done: Promise<void>;
}

export interface AgentParams {
  description: string;
  prompt: string;
  subagent_type?: string;
  model?: string;
  run_in_background?: boolean;
  isolation?: "worktree";
  readonly?: boolean;
}

function git(cwd: string, args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${(r.stderr || r.error?.message || "").trim()}`);
  return r.stdout.trim();
}

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {}
}

// A persisted pid may have been reused; only a process still running this
// agent's session is ours to kill.
function runsSession(pid: number, sessionId: string): boolean {
  const r = spawnSync("ps", ["-o", "args=", "-p", String(pid)], { encoding: "utf8" });
  return r.status === 0 && r.stdout.includes(sessionId);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const inboxDir = (record: AgentRecord) => join(record.sessionDir, `${record.id}.inbox`);

function assistantText(message: any): string {
  if (message?.role !== "assistant" || !Array.isArray(message.content)) return "";
  return message.content
    .filter((p: any) => p?.type === "text" && typeof p.text === "string")
    .map((p: any) => p.text)
    .join("\n")
    .trim();
}

// Cuts at a UTF-8 character boundary at or below the byte cap.
export function truncateUtf8(text: string, cap: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= cap) return text;
  let end = cap;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString("utf8");
}

export class AgentRunner {
  readonly records = new Map<string, AgentRecord>();
  private readonly runs = new Map<string, Run>();

  constructor(
    private readonly pi: ExtensionAPI,
    private readonly settings: Settings,
  ) {}

  agentTypes(): Map<string, AgentDefinition> {
    return loadAgentTypes(this.settings.pluginRoot);
  }

  async start(params: AgentParams, ctx: ExtensionContext): Promise<AgentRecord> {
    const type = params.subagent_type || "general-purpose";
    const types = this.agentTypes();
    const def = type === "general-purpose" ? undefined : types.get(type);
    if (type !== "general-purpose" && !def) {
      throw new Error(`Unknown subagent_type "${type}". Valid types: ${["general-purpose", ...types.keys()].join(", ")}.`);
    }
    const parentModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
    const model = resolveModel(params.model ?? def?.model, this.settings, readSheet(this.settings.agentDir), parentModel);

    const id = `a${randomBytes(8).toString("hex")}`;
    const state = stateDir(this.settings, ctx.sessionManager.getSessionId());
    const sessionDir = join(state, "agents");
    mkdirSync(sessionDir, { recursive: true });
    let systemPromptFile: string | undefined;
    if (def?.body) {
      mkdirSync(join(state, "prompts"), { recursive: true });
      systemPromptFile = join(state, "prompts", `${id}.md`);
      writeFileSync(systemPromptFile, def.body, { mode: 0o600 });
    }

    let worktree: Worktree | undefined;
    if (params.isolation === "worktree") {
      const repo = git(ctx.cwd, ["rev-parse", "--show-toplevel"]);
      worktree = {
        repo,
        path: join(repo, ".claude", "worktrees", `agent-${id}`),
        branch: `worktree-agent-${id}`,
        base: git(repo, ["rev-parse", "HEAD"]),
      };
    }

    const record: AgentRecord = {
      id,
      description: params.description,
      subagentType: type,
      model,
      // Claude Code subagents without an effort run at the session's effort.
      thinking: def?.effort ?? this.pi.getThinkingLevel(),
      readonly: params.readonly || undefined,
      sessionId: randomUUID(),
      sessionDir,
      systemPromptFile,
      cwd: worktree?.path ?? ctx.cwd,
      worktree,
      status: "running",
      startedAt: new Date().toISOString(),
    };
    this.records.set(id, record);
    this.launch(record, params.prompt, params.run_in_background === true);
    return record;
  }

  // Creates the worktree on first use and re-creates it for a resume after a
  // clean finish removed it.
  private ensureWorktree(wt: Worktree): void {
    if (existsSync(wt.path)) return;
    const branchExists = spawnSync("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${wt.branch}`], {
      cwd: wt.repo,
    }).status === 0;
    git(wt.repo, branchExists ? ["worktree", "add", wt.path, wt.branch] : ["worktree", "add", wt.path, "-b", wt.branch, wt.base]);
    wt.kept = undefined;
  }

  private settleWorktree(wt: Worktree): void {
    if (!existsSync(wt.path)) return;
    const dirty = git(wt.path, ["status", "--porcelain"]) !== "";
    const ahead = git(wt.path, ["rev-list", "--count", `${wt.base}..HEAD`]) !== "0";
    if (dirty || ahead) {
      wt.kept = true;
      return;
    }
    git(wt.repo, ["worktree", "remove", wt.path]);
    git(wt.repo, ["branch", "-D", wt.branch]);
    wt.kept = false;
  }

  private launch(record: AgentRecord, prompt: string, background: boolean): Run {
    try {
      if (record.worktree) this.ensureWorktree(record.worktree);
    } catch (e) {
      record.status = "failed";
      record.finalText = (e as Error).message;
      record.endedAt = new Date().toISOString();
      this.persist(record);
      throw e;
    }
    const args = ["--mode", "json", "-p", "--session-id", record.sessionId, "--session-dir", record.sessionDir];
    if (record.model) args.push("--model", record.model);
    if (record.thinking) args.push("--thinking", record.thinking);
    if (record.systemPromptFile) args.push("--append-system-prompt", record.systemPromptFile);
    const excluded = [...(record.readonly ? ["edit", "write"] : []), ...(this.settings.depth + 1 >= MAX_SPAWN_DEPTH ? ["agent"] : [])];
    if (excluded.length) args.push("--exclude-tools", excluded.join(","));

    const child = spawn(this.settings.pi.command, [...this.settings.pi.args, ...args], {
      cwd: record.cwd,
      env: { ...this.settings.childEnv, PSTACK_PI_INBOX: inboxDir(record) },
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    // The prompt goes in on stdin: argv would cap it at 128 KiB and expand a leading @ as a file.
    child.stdin!.on("error", () => {});
    child.stdin!.end(prompt);
    Object.assign(record, {
      status: "running",
      pid: child.pid,
      exitCode: undefined,
      endedAt: undefined,
      finalText: undefined,
      outputFile: undefined,
    });

    let finalText = "";
    let errorMessage = "";
    let stderr = "";
    let pending = "";
    const decoder = new StringDecoder("utf8");
    const onLine = (line: string) => {
      if (!line.trim()) return;
      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (event.type !== "message_end" || event.message?.role !== "assistant") return;
      const text = assistantText(event.message);
      if (text) finalText = text;
      if (event.message.errorMessage) errorMessage = event.message.errorMessage;
    };
    const feed = (chunk: string) => {
      pending += chunk;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) onLine(line.replace(/\r$/, ""));
    };
    child.stdout!.on("data", (b: Buffer) => feed(decoder.write(b)));
    child.stderr!.on("data", (b: Buffer) => {
      stderr = (stderr + b.toString("utf8")).slice(-STDERR_CAP);
    });

    let resolveDone!: () => void;
    const run: Run = { child, stopRequested: false, silent: false, done: new Promise((r) => (resolveDone = r)) };
    this.runs.set(record.id, run);
    this.persist(record);

    let finished = false;
    let exitCode: number | null = null;
    const finish = (spawnError?: Error) => {
      if (finished) return;
      finished = true;
      feed(decoder.end());
      if (pending) onLine(pending);
      this.runs.delete(record.id);
      record.exitCode = spawnError ? null : exitCode;
      record.endedAt = new Date().toISOString();
      record.status = run.stopRequested ? "stopped" : exitCode === 0 && finalText && !spawnError ? "completed" : "failed";
      // Stderr diagnoses a failure. A stopped child's stderr is not its output:
      // pi warns there on every first run of a --session-id.
      const diagnostics = errorMessage || spawnError?.message || stderr.trim();
      if (record.status === "stopped") record.finalText = finalText || "(stopped before it replied)";
      else if (record.status === "failed" && finalText && diagnostics) record.finalText = `${finalText}\n\n${diagnostics}`;
      else record.finalText = finalText || diagnostics || "(no output)";
      if (record.worktree) {
        try {
          this.settleWorktree(record.worktree);
        } catch (e) {
          record.worktree.kept = true;
          record.finalText += `\n\n(worktree cleanup failed: ${(e as Error).message})`;
        }
      }
      this.spill(record);
      this.persist(record);
      // The model that called stop_agent already has the result, so a stop's
      // notice joins the context without starting another turn.
      if (background && !run.silent) this.notify(record, record.status !== "stopped");
      resolveDone();
      // Messages the run never took resume the agent; a stop discards them.
      const untaken = take(inboxDir(record));
      if (untaken.length && record.status !== "stopped") {
        try {
          this.launch(record, untaken.join("\n\n"), true);
        } catch {
          this.notify(record, true);
        }
      }
    };
    child.on("error", (e) => finish(e));
    child.on("exit", (code) => {
      exitCode = code;
      // A grandchild holding the pipes open must not keep the agent running.
      setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish();
      }, CLOSE_AFTER_EXIT_MS).unref();
    });
    child.on("close", (code) => {
      exitCode = code ?? exitCode;
      finish();
    });
    return run;
  }

  // Writes a final text over the cap to disk, so the record can carry its path.
  private spill(record: AgentRecord): void {
    const text = record.finalText ?? "";
    if (Buffer.byteLength(text, "utf8") <= OUTPUT_CAP_BYTES) return;
    record.outputFile = join(record.sessionDir, `${record.id}.out.md`);
    writeFileSync(record.outputFile, text);
  }

  // Text for the model: the final text, cut to the cap with the full copy on disk.
  report(record: AgentRecord): string {
    const text = record.finalText ?? "";
    if (!record.outputFile) return text;
    return `${truncateUtf8(text, OUTPUT_CAP_BYTES)}\n\n[Output truncated at 50 KB. Full output: ${record.outputFile}]`;
  }

  private header(record: AgentRecord): string {
    const lines = [`agentId: ${record.id}`, `description: ${record.description}`, `status: ${record.status}`];
    if (record.exitCode !== undefined) lines.push(`exit code: ${record.exitCode}`);
    if (record.worktree) {
      const wt = record.worktree;
      lines.push(
        wt.kept === false
          ? `worktree: ${wt.path} (no changes; removed)`
          : `worktree: ${wt.path} (branch ${wt.branch})`,
      );
    }
    return lines.join("\n");
  }

  private notify(record: AgentRecord, triggerTurn: boolean): void {
    const body = this.report(record);
    this.pi.sendMessage(
      {
        customType: NOTICE_TYPE,
        content: `pstack agent finished.\n${this.header(record)}${record.outputFile ? `\nfull output: ${record.outputFile}` : ""}\n\n${body}`,
        display: true,
        details: { agentId: record.id, status: record.status, exitCode: record.exitCode, outputFile: record.outputFile },
      },
      triggerTurn ? { triggerTurn: true, deliverAs: "steer" } : { triggerTurn: false },
    );
  }

  resultText(record: AgentRecord): string {
    return `${this.header(record)}\n\n${this.report(record)}`;
  }

  async wait(id: string): Promise<void> {
    await this.runs.get(id)?.done;
  }

  // Resolves once the first running agent exits, at once when none is running.
  async nextExit(): Promise<void> {
    if (this.runs.size) await Promise.race([...this.runs.values()].map((run) => run.done));
  }

  find(to: string): AgentRecord {
    const byId = this.records.get(to);
    if (byId) return byId;
    const matches = [...this.records.values()].filter((r) => r.description === to);
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      throw new Error(`"${to}" matches several agents (${matches.map((r) => r.id).join(", ")}); pass an agentId.`);
    }
    const known = [...this.records.values()].map((r) => `${r.id} (${r.description})`);
    throw new Error(`No agent "${to}". Known agents: ${known.join(", ") || "none"}.`);
  }

  // A running agent takes the message mid-run; a finished one resumes with it.
  send(to: string, message: string): { record: AgentRecord; running: boolean } {
    const record = this.find(to);
    if (this.runs.has(record.id)) {
      post(inboxDir(record), message);
      return { record, running: true };
    }
    this.launch(record, message, true);
    return { record, running: false };
  }

  async stop(id: string, silent = false): Promise<AgentRecord> {
    const record = this.find(id);
    const run = this.runs.get(record.id);
    if (!run) return record;
    run.stopRequested = true;
    run.silent ||= silent;
    const pid = run.child.pid!;
    signalGroup(pid, "SIGTERM");
    const deadline = Date.now() + this.settings.killGraceMs;
    while (groupAlive(pid) && Date.now() < deadline) await sleep(25);
    if (groupAlive(pid)) signalGroup(pid, "SIGKILL");
    await run.done;
    return record;
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.runs.keys()].map((id) => this.stop(id, true)));
  }

  // For an exit that cannot wait: SIGTERM lets each child pi stop its own agents.
  signalAll(): void {
    for (const run of this.runs.values()) {
      run.silent = true;
      if (run.child.pid) signalGroup(run.child.pid, "SIGTERM");
    }
  }

  list(): object[] {
    return [...this.records.values()].map((r) => ({
      id: r.id,
      description: r.description,
      subagent_type: r.subagentType,
      model: r.model ?? "(pi default)",
      status: r.status,
      pid: r.pid,
      startedAt: r.startedAt,
      endedAt: r.endedAt,
      worktree: r.worktree?.path,
    }));
  }

  private persist(record: AgentRecord): void {
    this.pi.appendEntry(ENTRY_TYPE, {
      ...record,
      finalText: record.finalText && truncateUtf8(record.finalText, OUTPUT_CAP_BYTES),
      worktree: record.worktree && { ...record.worktree },
    });
  }

  // Folds persisted snapshots, last write per id wins. A snapshot still marked
  // running belongs to an earlier runtime; a crash can leave its process alive,
  // so that process is stopped too.
  restore(entries: readonly any[]): void {
    for (const entry of entries) {
      if (entry?.type !== "custom" || entry.customType !== ENTRY_TYPE || !entry.data?.id) continue;
      if (this.runs.has(entry.data.id)) continue;
      this.records.set(entry.data.id, { ...entry.data });
    }
    for (const record of this.records.values()) {
      if (record.status !== "running" || this.runs.has(record.id)) continue;
      record.status = "stopped";
      const pid = record.pid;
      if (!pid || !groupAlive(pid) || !runsSession(pid, record.sessionId)) continue;
      signalGroup(pid, "SIGTERM");
      setTimeout(() => {
        if (groupAlive(pid) && runsSession(pid, record.sessionId)) signalGroup(pid, "SIGKILL");
      }, this.settings.killGraceMs).unref();
    }
  }
}

const agentSchema = {
  type: "object",
  properties: {
    description: { type: "string", description: "A short (3-5 word) description of the task" },
    prompt: { type: "string", description: "The task for the agent to perform" },
    subagent_type: {
      type: "string",
      description:
        "Agent definition to run: general-purpose (default), pstack:poteto-agent, pstack:comment-sicko, pstack:poteto-agent-<level>, or pstack:effort-<level>.",
    },
    model: {
      type: "string",
      description:
        "Optional model for this agent: a family name (opus, fable, sonnet, haiku) or a full provider/id. If omitted, the agent runs on the parent's model.",
    },
    run_in_background: { type: "boolean", description: "Return at once; a completion notice arrives when the agent exits." },
    isolation: { type: "string", enum: ["worktree"], description: "Run the agent in its own git worktree." },
    readonly: { type: "boolean", description: "Run the agent without the edit and write tools." },
  },
  required: ["description", "prompt"],
  additionalProperties: false,
};

export function registerAgentTools(pi: ExtensionAPI, runner: AgentRunner): void {
  pi.registerTool({
    name: "agent",
    label: "Agent",
    description:
      "Launch a subagent: a separate pi process with its own context. Foreground (default) waits and returns its final text; run_in_background returns an agentId at once and a completion notice arrives when it exits. Use send_message to steer a running agent or continue a finished one, stop_agent to stop one, list_agents to see them.",
    promptSnippet: "Launch a subagent (foreground or background, optional worktree isolation)",
    parameters: agentSchema as any,
    async execute(_id, params: AgentParams, signal, _onUpdate, ctx) {
      const record = await runner.start(params, ctx);
      if (params.run_in_background) {
        return {
          content: [{ type: "text", text: JSON.stringify({ agentId: record.id, status: "running" }) }],
          details: { agentId: record.id, status: "running" },
        };
      }
      const onAbort = () => void runner.stop(record.id);
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        await runner.wait(record.id);
      } finally {
        signal?.removeEventListener("abort", onAbort);
      }
      return {
        content: [{ type: "text", text: runner.resultText(record) }],
        details: { agentId: record.id, status: record.status },
        isError: record.status !== "completed",
      };
    },
  });

  pi.registerTool({
    name: "send_message",
    label: "Send message",
    description:
      "Send a message to an agent this session started, by agentId or description. A running agent reads it after its current tool calls and carries on in the same run, so one completion notice follows. A finished agent resumes in the background with its earlier context and sends a completion notice.",
    parameters: {
      type: "object",
      properties: {
        to: { type: "string", description: "agentId or the agent's description" },
        message: { type: "string", description: "The message to send" },
      },
      required: ["to", "message"],
      additionalProperties: false,
    } as any,
    async execute(_id, params: { to: string; message: string }) {
      const { record, running } = runner.send(params.to, params.message);
      const text = running
        ? `Agent ${record.id} is running; it reads the message after its current tool calls. If its run ends before then, it resumes with the message and sends a second notice.`
        : JSON.stringify({ agentId: record.id, status: "running" });
      return { content: [{ type: "text", text }], details: { agentId: record.id, running } };
    },
  });

  pi.registerTool({
    name: "list_agents",
    label: "List agents",
    description:
      "List every agent this session started with its status. running means the process is alive; completed, failed, and stopped are reported only after the process exited.",
    parameters: { type: "object", properties: {}, additionalProperties: false } as any,
    async execute() {
      const agents = runner.list();
      return { content: [{ type: "text", text: JSON.stringify(agents, null, 2) }], details: { agents } };
    },
  });

  pi.registerTool({
    name: "stop_agent",
    label: "Stop agent",
    description:
      "Stop a running agent: terminates its whole process tree and returns once the process has exited. Stopping a finished agent reports its final status unchanged.",
    parameters: {
      type: "object",
      properties: { id: { type: "string", description: "agentId (or description) of the agent to stop" } },
      required: ["id"],
      additionalProperties: false,
    } as any,
    async execute(_id, params: { id: string }) {
      const record = await runner.stop(params.id);
      return {
        content: [{ type: "text", text: JSON.stringify({ agentId: record.id, status: record.status, exitCode: record.exitCode }) }],
        details: { agentId: record.id, status: record.status },
      };
    },
  });
}
