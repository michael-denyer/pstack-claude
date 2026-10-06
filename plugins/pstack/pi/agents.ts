import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

import { noticeOf, OUTPUT_CAP_BYTES, truncateUtf8 } from "./agent-text.ts";
import type { AgentParams } from "./agent-tools.ts";
import { alive, type ChildExit, PiChild, terminateGroup } from "./child.ts";
import { DEPTH_FLAG, GENERAL_PURPOSE, loadAgentTypes, PSTACK_STATE_DIR, readSheet, resolveModel, type Settings } from "./config.ts";
import { ensureWorktree, planWorktree, settleWorktree, type Worktree, worktreeSchema } from "./worktree.ts";

const ENTRY_TYPE = "pstack-agents";
// Claude Code lets agents nest three layers below the main session and withholds
// the Agent tool at the third.
const MAX_SPAWN_DEPTH = 3;

const endedStatus = Type.Union([Type.Literal("completed"), Type.Literal("failed"), Type.Literal("stopped")]);
type EndedStatus = Static<typeof endedStatus>;

// Fixed when the agent starts and reused by every launch of it, so a resume
// runs the same session, model, thinking, system prompt, and worktree.
const identitySchema = Type.Object({
  id: Type.String(),
  description: Type.String(),
  subagentType: Type.String(),
  model: Type.Optional(Type.String()),
  thinking: Type.Optional(Type.String()),
  readonly: Type.Optional(Type.Literal(true)),
  // Pi's own rule for a session id (assertValidSessionId): a resume passes it
  // to pi as an argument, so an empty or odd value must not load.
  sessionId: Type.String({ pattern: "^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$" }),
  sessionDir: Type.String(),
  systemPromptFile: Type.Optional(Type.String()),
  cwd: Type.String(),
  worktree: Type.Optional(worktreeSchema),
  startedAt: Type.String(),
});
const runningSchema = Type.Object({
  agent: identitySchema,
  status: Type.Literal("running"),
  pid: Type.Optional(Type.Number()),
  // When that pid started, as the system reports it. A pid can be reused; a
  // pid with its start time names one process. Absent when it could not be
  // read, and on a record an earlier version wrote.
  pidStart: Type.Optional(Type.String()),
  // The pi process that launched it. Only that process may reap it.
  parentPid: Type.Number(),
});
const endedSchema = Type.Object({
  agent: identitySchema,
  status: endedStatus,
  pid: Type.Optional(Type.Number()),
  exitCode: Type.Union([Type.Number(), Type.Null()]),
  endedAt: Type.String(),
  finalText: Type.String(),
  outputFile: Type.Optional(Type.String()),
  worktreeKept: Type.Optional(Type.Boolean()),
});
// Persisted as a session entry, last write per agent id wins.
const recordSchema = Type.Union([runningSchema, endedSchema]);

type AgentIdentity = Static<typeof identitySchema>;
type RunningRecord = Static<typeof runningSchema>;
export type EndedRecord = Static<typeof endedSchema>;
export type AgentRecord = Static<typeof recordSchema>;

interface Run {
  child: PiChild;
  background: boolean;
  // Set once the run is told to end: the exit code no longer decides the
  // status. teardown means the session is going away, so no notice follows.
  ending?: "stopped" | "teardown";
  done: Promise<EndedRecord>;
}

// A remote agent runs under the live pi process that restore left it to.
type LocalAgent = { kind: "local"; record: RunningRecord; run: Run };
type AgentState = LocalAgent | { kind: "remote"; record: RunningRecord } | { kind: "ended"; record: EndedRecord };

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

// The text a record keeps: capped, with the full copy on disk when it was cut.
function saveOutput(identity: AgentIdentity, text: string): Pick<EndedRecord, "finalText" | "outputFile"> {
  const capped = truncateUtf8(text, OUTPUT_CAP_BYTES);
  if (capped === text) return { finalText: text };
  const outputFile = join(identity.sessionDir, `${identity.id}.${Date.now()}.out.md`);
  try {
    writeFileSync(outputFile, text);
    return { finalText: capped, outputFile };
  } catch (e) {
    return { finalText: `${capped}\n\n(full output not saved: ${(e as Error).message})` };
  }
}

function settle(worktree: Worktree): { kept: boolean; note: string } {
  try {
    return { kept: settleWorktree(worktree), note: "" };
  } catch (e) {
    return { kept: true, note: `\n\n(worktree cleanup failed: ${(e as Error).message})` };
  }
}

function childArgs(identity: AgentIdentity, depth: number): string[] {
  const args = ["--mode", "rpc", "--session-id", identity.sessionId, "--session-dir", identity.sessionDir];
  if (identity.model) args.push("--model", identity.model);
  if (identity.thinking) args.push("--thinking", identity.thinking);
  if (identity.systemPromptFile) args.push("--append-system-prompt", identity.systemPromptFile);
  args.push(`--${DEPTH_FLAG}`, String(depth + 1));
  const excluded = [...(identity.readonly ? ["edit", "write"] : []), ...(depth + 1 >= MAX_SPAWN_DEPTH ? ["agent"] : [])];
  if (excluded.length) args.push("--exclude-tools", excluded.join(","));
  return args;
}

// What the system records about a live process, or undefined when it cannot
// say. Neither value is the process's to change, unlike its arguments: pi sets
// its title, and ps then shows that in their place. Linux keeps both in /proc,
// the start as clock ticks since boot. ps works its start time out from the
// wall clock there, so a clock change moves it, and ps is asked only where
// /proc is missing, with the locale and time zone pinned so the text is the
// same on every read.
function inspect(pid: number): { parentPid: number; start: string } | undefined {
  let stat = "";
  try {
    stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {}
  // State, parent pid, and 17 more fields up to the start time. They follow
  // the command name, which is in parentheses and may hold any character.
  const proc = /^ \S (\d+)(?: \S+){17} (\d+) /.exec(stat.slice(stat.lastIndexOf(")") + 1));
  if (proc) return { parentPid: Number(proc[1]), start: proc[2] };
  const ps = spawnSync("ps", ["-o", "ppid=", "-o", "lstart=", "-p", String(pid)], { encoding: "utf8", env: { ...process.env, LC_ALL: "C", TZ: "UTC" } });
  const m = ps.status === 0 ? /^\s*(\d+)\s+(\S.*\S)\s*$/.exec(ps.stdout) : null;
  return m ? { parentPid: Number(m[1]), start: m[2] } : undefined;
}

// What became of the process a running record names:
// - kept: it is still a child of the live pi process that launched it;
// - orphan: it is the process the record was written for, its launcher gone;
// - unknown: a process is there, and nothing says whether it is the agent's;
// - gone: no process is there, or another one is.
type Fate = "kept" | "orphan" | "unknown" | "gone";

function fateOf(record: RunningRecord): Fate {
  const { pid, pidStart, parentPid } = record;
  if (pid === undefined || !alive(pid)) return "gone";
  const info = inspect(pid);
  if (info && pidStart !== undefined && info.start !== pidStart) return "gone";
  // With no word from the system, two live pids keep the record: calling a
  // live agent stopped would let a message start a second process on its session.
  const launcherHasIt = info ? info.parentPid === parentPid : alive(parentPid);
  if (parentPid !== process.pid && launcherHasIt) return "kept";
  return info && info.start === pidStart ? "orphan" : "unknown";
}

// Stops an orphan, by its group so the bash command it has running goes too.
// No other fate is signalled: a pid that may have been reused is not ours to hit.
function reapOrphan(record: RunningRecord, killGraceMs: number): void {
  if (record.pid !== undefined) terminateGroup(record.pid, () => fateOf(record) === "orphan", killGraceMs);
}

const now = () => new Date().toISOString();

export class AgentRunner {
  private readonly agents = new Map<string, AgentState>();
  // Set once the session tears its agents down; a launch after that would
  // start a child nothing stops.
  private closed = false;

  constructor(
    private readonly pi: ExtensionAPI,
    private readonly settings: Settings,
  ) {}

  start(params: AgentParams, ctx: ExtensionContext): RunningRecord {
    const type = params.subagent_type || GENERAL_PURPOSE;
    const types = loadAgentTypes(this.settings);
    const def = types.get(type);
    if (!def) throw new Error(`Unknown subagent_type "${type}". Valid types: ${[...types.keys()].join(", ")}.`);
    const parentModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
    const model = resolveModel(params.model ?? def.model, this.settings, readSheet(this.settings.agentDir), parentModel);

    const id = `a${randomBytes(8).toString("hex")}`;
    const state = join(this.settings.agentDir, PSTACK_STATE_DIR, ctx.sessionManager.getSessionId());
    const sessionDir = join(state, "agents");
    mkdirSync(sessionDir, { recursive: true });
    const systemPromptFile = def.body ? join(state, "prompts", `${id}.md`) : undefined;
    const worktree = params.isolation === "worktree" ? planWorktree(ctx.cwd, id) : undefined;
    const identity: AgentIdentity = {
      id,
      description: params.description,
      subagentType: type,
      model,
      // Claude Code subagents without an effort run at the session's effort.
      thinking: def.effort ?? this.pi.getThinkingLevel(),
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
      // First, so a failure here leaves no worktree or branch behind.
      this.ensureSystemPrompt(identity);
      if (identity.worktree) ensureWorktree(identity.worktree);
    } catch (e) {
      const failed: EndedRecord = { agent: identity, status: "failed", exitCode: null, endedAt: now(), finalText: (e as Error).message };
      this.agents.set(identity.id, { kind: "ended", record: failed });
      this.persist(failed);
      throw e;
    }
    const { command, args } = this.settings.pi;
    const child = new PiChild(
      command,
      [...args, "--extension", join(this.settings.pluginRoot, "pi", "index.ts"), "--skill", join(this.settings.pluginRoot, "skills"), ...childArgs(identity, this.settings.depth)],
      { cwd: identity.cwd, exitGraceMs: this.settings.exitGraceMs },
      prompt,
    );
    const pidStart = child.pid === undefined ? undefined : inspect(child.pid)?.start;
    const record: RunningRecord = { agent: identity, status: "running", pid: child.pid, pidStart, parentPid: process.pid };
    const run: Run = { child, background, done: child.exited.then((exit) => this.finish(identity, run, exit)) };
    this.agents.set(identity.id, { kind: "local", record, run });
    this.persist(record);
    return record;
  }

  // Pi appends a path it cannot find as the prompt text itself.
  private ensureSystemPrompt(identity: AgentIdentity): void {
    const file = identity.systemPromptFile;
    if (!file || existsSync(file)) return;
    const body = loadAgentTypes(this.settings).get(identity.subagentType)?.body;
    if (!body) throw new Error(`Agent ${identity.id} has lost its system prompt file, and its type "${identity.subagentType}" no longer provides one.`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, body, { mode: 0o600 });
  }

  private finish(identity: AgentIdentity, run: Run, exit: ChildExit): EndedRecord {
    const { status, finalText } = outcomeOf(exit, run.ending !== undefined);
    const worktree = identity.worktree && settle(identity.worktree);
    const record: EndedRecord = {
      agent: identity,
      status,
      pid: run.child.pid,
      exitCode: exit.exitCode,
      endedAt: now(),
      worktreeKept: worktree?.kept,
      ...saveOutput(identity, finalText + (worktree?.note ?? "")),
    };
    this.agents.set(identity.id, { kind: "ended", record });
    this.persist(record);
    // The model that called stop_agent already has the result, so a stop's
    // notice joins the context without starting another turn.
    if (run.background && run.ending !== "teardown") {
      this.pi.sendMessage(noticeOf(record), status !== "stopped" ? { triggerTurn: true, deliverAs: "steer" } : { triggerTurn: false });
    }
    return record;
  }

  // The end of the agent's run in flight, or its record when it has ended.
  async wait(id: string): Promise<EndedRecord> {
    const state = this.owned(id);
    return state.kind === "local" ? state.run.done : state.record;
  }

  private locals(): LocalAgent[] {
    return [...this.agents.values()].filter((state): state is LocalAgent => state.kind === "local");
  }

  get busy(): boolean {
    return this.locals().length > 0;
  }

  // Resolves once the first running agent exits, at once when none is running.
  async nextExit(): Promise<void> {
    const locals = this.locals();
    if (locals.length) await Promise.race(locals.map((state) => state.run.done));
  }

  private find(to: string): AgentState {
    const byId = this.agents.get(to);
    if (byId) return byId;
    const states = [...this.agents.values()];
    const matches = states.filter((state) => state.record.agent.description === to);
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      throw new Error(`"${to}" matches several agents (${matches.map((state) => state.record.agent.id).join(", ")}); pass an agentId.`);
    }
    const known = states.map(({ record }) => `${record.agent.id} (${record.agent.description})`);
    throw new Error(`No agent "${to}". Known agents: ${known.join(", ") || "none"}.`);
  }

  // An agent this process can act on. One running under another pi process is
  // not: only that process holds its stdin and can message or stop it.
  private owned(to: string): Exclude<AgentState, { kind: "remote" }> {
    const state = this.find(to);
    if (state.kind === "remote") {
      throw new Error(`Agent ${state.record.agent.id} is running under another pi process (pid ${state.record.parentPid}); only that process can message or stop it.`);
    }
    return state;
  }

  // A running agent takes the message as a steer, after its current tool calls.
  // A finished one, or one that has settled and is exiting, resumes with it,
  // including one that settled just before the steer reached it.
  async send(to: string, message: string): Promise<{ record: AgentRecord; running: boolean }> {
    const { id } = this.owned(to).record.agent;
    // Another send may have launched a run while this one awaited, so the state
    // is read again after every wait and the launch follows the last read.
    for (let state = this.agents.get(id); state?.kind === "local"; state = this.agents.get(id)) {
      const { run } = state;
      const { response, taken } = await run.child.steer(message);
      if (taken) return { record: this.find(id).record, running: true };
      if (response && !response.success) throw new Error(`Agent ${id} did not take the message: ${response.error}`);
      await run.done;
      if (run.ending) throw new Error(`Agent ${id} was stopped before it read the message; it was not delivered.`);
    }
    return { record: this.launch(this.find(id).record.agent, message, true), running: false };
  }

  async stop(to: string, ending: NonNullable<Run["ending"]> = "stopped"): Promise<EndedRecord> {
    const state = this.owned(to);
    if (state.kind === "ended") return state.record;
    const { run } = state;
    if (run.ending !== "teardown") run.ending = ending;
    void run.child.command({ type: "abort" });
    run.child.end(this.settings.killGraceMs);
    return run.done;
  }

  async stopAll(): Promise<void> {
    this.closed = true;
    await Promise.all(this.locals().map((state) => this.stop(state.record.agent.id, "teardown")));
  }

  // For an exit that cannot wait: SIGTERM lets each child pi stop its own agents.
  signalAll(): void {
    this.closed = true;
    for (const { run } of this.locals()) {
      run.ending = "teardown";
      run.child.signal("SIGTERM");
    }
  }

  list(): AgentRecord[] {
    return [...this.agents.values()].map((state) => state.record);
  }

  private persist(record: AgentRecord): void {
    this.pi.appendEntry(ENTRY_TYPE, record);
  }

  // Folds persisted snapshots. A snapshot still marked running is left to the
  // live pi process that launched it while its process is still that one's
  // child: a live parent pid alone may be a reused one. Any other running
  // snapshot ends here, and its process is stopped when it is known to be the
  // agent's.
  restore(entries: readonly SessionEntry[]): void {
    for (const entry of entries) {
      if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE || !Value.Check(recordSchema, entry.data)) continue;
      const { id } = entry.data.agent;
      if (this.agents.get(id)?.kind === "local") continue;
      this.agents.set(id, entry.data.status === "running" ? { kind: "remote", record: entry.data } : { kind: "ended", record: entry.data });
    }
    for (const [id, state] of this.agents) {
      if (state.kind !== "remote") continue;
      const { record } = state;
      if (fateOf(record) === "kept") continue;
      const stopped: EndedRecord = {
        agent: record.agent,
        status: "stopped",
        pid: record.pid,
        exitCode: null,
        endedAt: now(),
        finalText: "(interrupted: the session that started it ended)",
      };
      this.agents.set(id, { kind: "ended", record: stopped });
      this.persist(stopped);
      reapOrphan(record, this.settings.killGraceMs);
    }
  }
}
