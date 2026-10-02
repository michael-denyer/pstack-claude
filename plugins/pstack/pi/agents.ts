import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

import { noticeOf, OUTPUT_CAP_BYTES, truncateUtf8 } from "./agent-text.ts";
import type { AgentParams } from "./agent-tools.ts";
import { alive, type ChildExit, PiChild, signalGroup } from "./child.ts";
import { loadAgentTypes, readSheet, resolveModel, type Settings, stateDir } from "./config.ts";
import { ensureWorktree, planWorktree, settleWorktree, worktreeSchema } from "./worktree.ts";

const ENTRY_TYPE = "pstack-agents";
// Claude Code lets agents nest three layers below the main session and withholds
// the Agent tool at the third.
const MAX_SPAWN_DEPTH = 3;

const endedStatus = Type.Union([Type.Literal("completed"), Type.Literal("failed"), Type.Literal("stopped")]);
type EndedStatus = Static<typeof endedStatus>;

// Fixed when the agent starts and reused by every launch of it, so a resume
// runs the same session, model, thinking, system prompt, and worktree. This is
// the one list of those fields: the type, the copy a resume takes from an ended
// record, and the check on a restored record all come from it.
const identityFields = {
  id: Type.String(),
  description: Type.String(),
  subagentType: Type.String(),
  model: Type.Optional(Type.String()),
  thinking: Type.Optional(Type.String()),
  readonly: Type.Optional(Type.Literal(true)),
  // Pi's own rule for a session id (assertValidSessionId): the reaper matches
  // it against a process's arguments, so an empty or odd value must not load.
  sessionId: Type.String({ pattern: "^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$" }),
  sessionDir: Type.String(),
  systemPromptFile: Type.Optional(Type.String()),
  cwd: Type.String(),
  worktree: Type.Optional(worktreeSchema),
  startedAt: Type.String(),
};
const identitySchema = Type.Object(identityFields);
const runningSchema = Type.Object({
  ...identityFields,
  status: Type.Literal("running"),
  pid: Type.Optional(Type.Number()),
  // The pi process that launched it. Only that process may reap it.
  parentPid: Type.Number(),
});
const endedSchema = Type.Object({
  ...identityFields,
  status: endedStatus,
  pid: Type.Optional(Type.Number()),
  exitCode: Type.Union([Type.Number(), Type.Null()]),
  endedAt: Type.String(),
  finalText: Type.String(),
  outputFile: Type.Optional(Type.String()),
  worktreeKept: Type.Optional(Type.Boolean()),
});
// Persisted as a session entry, last write per id wins.
const recordSchema = Type.Union([runningSchema, endedSchema]);

type AgentIdentity = Static<typeof identitySchema>;
type RunningRecord = Static<typeof runningSchema>;
export type EndedRecord = Static<typeof endedSchema>;
export type AgentRecord = Static<typeof recordSchema>;

const IDENTITY_KEYS = Object.keys(identityFields) as (keyof AgentIdentity)[];

function identityOf(record: AgentRecord): AgentIdentity {
  return Object.fromEntries(IDENTITY_KEYS.filter((key) => record[key] !== undefined).map((key) => [key, record[key]])) as AgentIdentity;
}

interface Run {
  child: PiChild;
  background: boolean;
  // Set by stop(): the exit code no longer decides the status. silent means the
  // session is being torn down, so no notice.
  stop?: { silent: boolean };
  done: Promise<EndedRecord>;
}

// How a run ended, from what its process left behind. A run that settled on a
// reply completed, whatever the exit code of the shutdown after it. Stderr
// diagnoses a failure; a stopped child's stderr is not its output (pi warns
// there on every first run of a --session-id).
function outcomeOf(exit: ChildExit, stopped: boolean): { status: EndedStatus; finalText: string } {
  if (stopped) return { status: "stopped", finalText: exit.finalText || "(stopped before it replied)" };
  if (exit.settled && exit.finalText && !exit.errorMessage) return { status: "completed", finalText: exit.finalText };
  const diagnostics = exit.errorMessage || exit.stderr.trim();
  const finalText = exit.finalText && diagnostics ? `${exit.finalText}\n\n${diagnostics}` : exit.finalText || diagnostics || "(no output)";
  return { status: "failed", finalText };
}

function childArgs(identity: AgentIdentity, depth: number): string[] {
  const args = ["--mode", "rpc", "--session-id", identity.sessionId, "--session-dir", identity.sessionDir];
  if (identity.model) args.push("--model", identity.model);
  if (identity.thinking) args.push("--thinking", identity.thinking);
  if (identity.systemPromptFile) args.push("--append-system-prompt", identity.systemPromptFile);
  const excluded = [...(identity.readonly ? ["edit", "write"] : []), ...(depth + 1 >= MAX_SPAWN_DEPTH ? ["agent"] : [])];
  if (excluded.length) args.push("--exclude-tools", excluded.join(","));
  return args;
}

// A persisted pid may have been reused; only a process whose arguments carry
// `--session-id <this agent's session>` as a pair is ours to kill.
function runsSession(pid: number, sessionId: string): boolean {
  const r = spawnSync("ps", ["-o", "args=", "-p", String(pid)], { encoding: "utf8" });
  if (r.status !== 0) return false;
  const args = r.stdout.trim().split(/\s+/);
  return args.some((arg, i) => arg === "--session-id" && args[i + 1] === sessionId);
}

// Stops the pi process of a record still marked running, by its group so the
// bash command it has running goes too. Only a pid still running this agent's
// session is signalled: without that identity check a reused pid would be hit.
function reapOrphan(record: RunningRecord, killGraceMs: number): void {
  const pid = record.pid;
  if (pid === undefined) return;
  const ours = () => alive(pid) && runsSession(pid, record.sessionId);
  if (!ours()) return;
  signalGroup(pid, "SIGTERM");
  setTimeout(() => ours() && signalGroup(pid, "SIGKILL"), killGraceMs).unref();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString();

export class AgentRunner {
  private readonly records = new Map<string, AgentRecord>();
  private readonly runs = new Map<string, Run>();
  // Set once the session tears its agents down; a launch after that would
  // start a child nothing stops.
  private closed = false;

  constructor(
    private readonly pi: ExtensionAPI,
    private readonly settings: Settings,
  ) {}

  start(params: AgentParams, ctx: ExtensionContext): RunningRecord {
    const type = params.subagent_type || "general-purpose";
    const types = loadAgentTypes(this.settings.pluginRoot);
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
    const worktree = params.isolation === "worktree" ? planWorktree(ctx.cwd, id) : undefined;
    const identity: AgentIdentity = {
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
      startedAt: now(),
    };
    return this.launch(identity, params.prompt, params.run_in_background === true);
  }

  private launch(identity: AgentIdentity, prompt: string, background: boolean): RunningRecord {
    if (this.closed) throw new Error("This session is shutting down; no agent can start.");
    try {
      if (identity.worktree) ensureWorktree(identity.worktree);
    } catch (e) {
      const failed: EndedRecord = { ...identity, status: "failed", exitCode: null, endedAt: now(), finalText: (e as Error).message };
      this.records.set(identity.id, failed);
      this.persist(failed);
      throw e;
    }
    const { command, args } = this.settings.pi;
    const child = new PiChild(
      command,
      [...args, ...childArgs(identity, this.settings.depth)],
      { cwd: identity.cwd, env: this.settings.childEnv, exitGraceMs: this.settings.exitGraceMs },
      prompt,
    );
    const record: RunningRecord = { ...identity, status: "running", pid: child.pid, parentPid: process.pid };
    this.records.set(identity.id, record);
    this.persist(record);
    const run: Run = { child, background, done: child.exited.then((exit) => this.finish(identity, run, exit)) };
    this.runs.set(identity.id, run);
    return record;
  }

  private finish(identity: AgentIdentity, run: Run, exit: ChildExit): EndedRecord {
    this.runs.delete(identity.id);
    const { status, finalText } = outcomeOf(exit, run.stop !== undefined);
    const record: EndedRecord = { ...identity, status, pid: run.child.pid, exitCode: exit.exitCode, endedAt: now(), finalText };
    if (identity.worktree) {
      try {
        record.worktreeKept = settleWorktree(identity.worktree);
      } catch (e) {
        record.worktreeKept = true;
        record.finalText += `\n\n(worktree cleanup failed: ${(e as Error).message})`;
      }
    }
    if (Buffer.byteLength(record.finalText, "utf8") > OUTPUT_CAP_BYTES) {
      record.outputFile = join(identity.sessionDir, `${identity.id}.out.md`);
      writeFileSync(record.outputFile, record.finalText);
    }
    this.records.set(identity.id, record);
    this.persist(record);
    // The model that called stop_agent already has the result, so a stop's
    // notice joins the context without starting another turn.
    if (run.background && !run.stop?.silent) {
      this.pi.sendMessage(noticeOf(record), status !== "stopped" ? { triggerTurn: true, deliverAs: "steer" } : { triggerTurn: false });
    }
    return record;
  }

  async wait(id: string): Promise<AgentRecord> {
    await this.runs.get(id)?.done;
    return this.find(id);
  }

  get busy(): boolean {
    return this.runs.size > 0;
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

  // A record still running without a run here belongs to the live pi process
  // restore left it to; only that process holds its stdin and can stop it.
  private findOwned(to: string): AgentRecord {
    const record = this.find(to);
    if (record.status === "running" && !this.runs.has(record.id)) {
      throw new Error(`Agent ${record.id} is running under another pi process (pid ${record.parentPid}); only that process can message or stop it.`);
    }
    return record;
  }

  // A running agent takes the message as a steer, after its current tool calls.
  // A finished one, or one that has settled and is exiting, resumes with it,
  // including one that settled just before the steer reached it.
  async send(to: string, message: string): Promise<{ record: AgentRecord; running: boolean }> {
    const { id } = this.findOwned(to);
    // Another send may have launched a run while this one awaited, so the run
    // table is read again after every wait and the launch follows the last read.
    for (let run = this.runs.get(id); run; run = this.runs.get(id)) {
      const response = await run.child.command({ type: "steer", message });
      if (response?.success && !run.child.settled) return { record: this.find(id), running: true };
      if (response && !response.success) throw new Error(`Agent ${id} did not take the message: ${response.error}`);
      await run.done;
      if (run.stop) throw new Error(`Agent ${id} was stopped before it read the message; it was not delivered.`);
    }
    return { record: this.launch(identityOf(this.find(id)), message, true), running: false };
  }

  async stop(to: string, silent = false): Promise<AgentRecord> {
    const record = this.findOwned(to);
    const run = this.runs.get(record.id);
    if (!run) return record;
    run.stop = { silent: silent || run.stop?.silent === true };
    void run.child.command({ type: "abort" });
    run.child.close();
    run.child.signal("SIGTERM");
    const deadline = Date.now() + this.settings.killGraceMs;
    while (run.child.groupAlive() && Date.now() < deadline) await sleep(25);
    if (run.child.groupAlive()) run.child.signal("SIGKILL");
    return run.done;
  }

  async stopAll(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.runs.keys()].map((id) => this.stop(id, true)));
  }

  // For an exit that cannot wait: SIGTERM lets each child pi stop its own agents.
  signalAll(): void {
    this.closed = true;
    for (const run of this.runs.values()) {
      run.stop = { silent: true };
      run.child.signal("SIGTERM");
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
      endedAt: r.status === "running" ? undefined : r.endedAt,
      worktree: r.worktree?.path,
    }));
  }

  private persist(record: AgentRecord): void {
    this.pi.appendEntry(ENTRY_TYPE, record.status === "running" ? record : { ...record, finalText: truncateUtf8(record.finalText, OUTPUT_CAP_BYTES) });
  }

  // Folds persisted snapshots. A snapshot still marked running whose launching
  // process is gone is an orphan: its process, if it survived, is stopped. One
  // whose launching process is alive belongs to that process and is left alone.
  restore(entries: readonly SessionEntry[]): void {
    for (const entry of entries) {
      if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE || !Value.Check(recordSchema, entry.data)) continue;
      if (!this.runs.has(entry.data.id)) this.records.set(entry.data.id, entry.data);
    }
    for (const record of this.records.values()) {
      if (record.status !== "running" || this.runs.has(record.id)) continue;
      if (record.parentPid !== process.pid && alive(record.parentPid)) continue;
      const stopped: EndedRecord = {
        ...identityOf(record),
        status: "stopped",
        pid: record.pid,
        exitCode: null,
        endedAt: now(),
        finalText: "(interrupted: the session that started it ended)",
      };
      this.records.set(record.id, stopped);
      this.persist(stopped);
      reapOrphan(record, this.settings.killGraceMs);
    }
  }
}
