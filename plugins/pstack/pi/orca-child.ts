import { execFile } from "node:child_process";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { type Static, type TSchema, Type } from "typebox";
import { Value } from "typebox/value";

import { AGENTS_ENTRY, NOTICE_TYPE } from "./agent-text.ts";
import { alive, type ChildExit, signalGroup, terminateGroup } from "./child.ts";
import { envScript, jsonLines, replyOf, sizeOf } from "./hc-child.ts";

const execOrca = promisify(execFile);
export const SETTLE_POLL_MS = 500;
const CLOSE_POLL_MS = 200;
const CALL_TIMEOUT_MS = 10_000;

const createResult = Type.Object({ result: Type.Object({ terminal: Type.Object({ handle: Type.String(), processId: Type.Number() }) }) });
const sendResult = Type.Object({ result: Type.Object({ send: Type.Object({ accepted: Type.Boolean() }) }) });
const readResult = Type.Object({ result: Type.Object({ terminal: Type.Object({ tail: Type.Array(Type.String()) }) }) });
const failedResult = Type.Object({ error: Type.Object({ message: Type.String() }) });
const messageEntry = Type.Object({
  type: Type.Literal("message"),
  id: Type.Optional(Type.String()),
  message: Type.Object({ role: Type.String(), stopReason: Type.Optional(Type.String()) }),
});
const droppedEntry = Type.Object({ type: Type.Literal("context_edit"), targetId: Type.String(), replacement: Type.Null() });
const agentEntry = Type.Object({ type: Type.Literal("custom"), customType: Type.Literal(AGENTS_ENTRY), data: Type.Object({ agent: Type.Object({ id: Type.String() }), status: Type.String() }) });
const noticeEntry = Type.Object({ type: Type.Literal("custom_message"), customType: Type.Literal(NOTICE_TYPE), details: Type.Object({ triggerTurn: Type.Boolean() }) });
const userMessage = (entry: unknown): boolean => Value.Check(messageEntry, entry) && entry.message.role === "user";

export interface OrcaSession {
  cli: string;
  workspace: string;
}

// Orca's macOS app sets no ORCA_CLI_COMMAND, and on Linux a bare orca is the screen reader.
export function orcaSession(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): OrcaSession | undefined {
  if (platform === "win32") return undefined;
  const handle = env.ORCA_TERMINAL_HANDLE;
  const cli = env.ORCA_CLI_COMMAND || (platform === "darwin" ? "orca" : undefined);
  const workspace = env.ORCA_WORKTREE_ID || env.ORCA_WORKSPACE_ID;
  return handle && cli && workspace ? { cli, workspace } : undefined;
}

export function settledRun(entries: unknown[], steers: number): Pick<ChildExit, "interruption"> | undefined {
  const last = entries.filter((entry) => Value.Check(messageEntry, entry) || (Value.Check(noticeEntry, entry) && entry.details.triggerTurn)).at(-1);
  if (!Value.Check(messageEntry, last) || last.message.role !== "assistant" || last.message.stopReason === "toolUse") return undefined;
  // Pi drops a failed reply it is about to retry with a context edit.
  if (entries.some((entry) => Value.Check(droppedEntry, entry) && entry.targetId === last.id)) return undefined;
  // Pi puts a steer still queued at an abort back in its editor, so it never arrives.
  if (last.message.stopReason === "aborted") return { interruption: "stopped in Orca" };
  // Counted, not matched by text: a TUI may reshape pasted text.
  const users = entries.filter(userMessage).length;
  if (users < 1 + steers) return undefined;
  const agents = new Map(entries.filter((entry) => Value.Check(agentEntry, entry)).map(({ data }) => [data.agent.id, data.status]));
  return [...agents.values()].includes("running") ? undefined : { interruption: undefined };
}

export interface OrcaOptions {
  session: OrcaSession;
  title: string;
  cwd: string;
  env: Record<string, string | undefined>;
  files: string;
  graceMs: number;
  transcript: () => string | undefined;
  onStart: (pid: number) => void;
}

export class OrcaChild {
  readonly pid = undefined;
  readonly activity = undefined;
  readonly exited: Promise<ChildExit>;
  private readonly cli: string;
  private begin!: () => void;
  private readonly begun = new Promise<void>((resolve) => {
    this.begin = resolve;
  });
  private readonly files: Record<string, string>;
  private handle?: string;
  private terminalPid?: number;
  private steers = 0;
  private settled = false;
  private ending = false;

  constructor(command: string, args: string[], opts: OrcaOptions, prompt: string) {
    this.cli = opts.session.cli;
    const files = { env: `${opts.files}.env`, prompt: `${opts.files}.prompt`, script: `${opts.files}.sh`, err: `${opts.files}.err` };
    this.files = files;
    writeFileSync(files.env, envScript({ ...process.env, ...opts.env }, "ORCA_"), { mode: 0o600 });
    // Pi reads an argument that starts with @ as a file, even after --, and one that starts with / as a command.
    writeFileSync(files.prompt, /^[@/]/.test(prompt) ? ` ${prompt}` : prompt, { mode: 0o600 });
    const launch = `. ${quote(files.env)} && rm -- ${quote(files.env)} && p=$(cat ${quote(files.prompt)}; printf x) && p=\${p%x} && rm -- ${quote(files.prompt)} && cd ${quote(opts.cwd)} && exec ${[command, ...args].map(quote).join(" ")} -- "$p" 2>>${quote(files.err)}\n`;
    writeFileSync(files.script, launch, { mode: 0o600 });
    const from = sizeOf(opts.transcript());
    const created = this.orca(createResult, ["terminal", "create", `--worktree=id:${opts.session.workspace}`, `--title=${opts.title}`, `--command=exec sh ${quote(files.script)}`]);
    this.exited = this.drive(created, from, opts);
  }

  async steer(message: string): Promise<{ response: { success: boolean; error?: string } | undefined; taken: boolean }> {
    if (/^\s*[!/]/.test(message)) {
      return { response: { success: false, error: "the message starts with ! or /, which pi's editor in the Orca tab would run as a shell or slash command; reword it" }, taken: false };
    }
    if (!message.trim()) return { response: { success: false, error: "the message is empty once pi's editor trims it, so pi would drop it" }, taken: false };
    if (!this.settled) {
      // Counted before the send, so the run cannot settle while the message is on its way.
      this.steers++;
      // Pi keeps text typed into the tab before it has started in its editor, unsubmitted.
      const begun = await Promise.race([this.begun.then(() => true), this.exited.then(() => false)]);
      const handle = begun && !this.settled ? this.handle : undefined;
      let tooLong = false;
      try {
        const sent = handle && (await this.orca(sendResult, ["terminal", "send", `--terminal=${handle}`, `--text=${message}`, "--enter"]));
        if (sent && sent.result.send.accepted) return { response: { success: true }, taken: true };
      } catch (e) {
        tooLong = (e as NodeJS.ErrnoException).code === "E2BIG";
      }
      this.steers--;
      if (tooLong) return { response: { success: false, error: "the message is longer than one command-line argument can be; put it in a file and name the file" }, taken: false };
    }
    return { response: undefined, taken: false };
  }

  end(graceMs: number): void {
    this.ending = true;
    this.stop(graceMs);
  }

  signal(signal: NodeJS.Signals): void {
    if (this.terminalPid !== undefined) signalGroup(this.terminalPid, signal);
    else this.removeFiles();
  }

  private async drive(created: Promise<Static<typeof createResult>>, from: number, opts: OrcaOptions): Promise<ChildExit> {
    const written = () => {
      const file = opts.transcript();
      return file ? jsonLines(readFileSync(file).subarray(from).toString("utf8")) : [];
    };
    try {
      const { handle, processId } = (await created).result.terminal;
      this.handle = handle;
      this.terminalPid = processId;
      opts.onStart(processId);
      if (this.ending) this.stop(opts.graceMs);
      let run: Pick<ChildExit, "interruption"> | undefined;
      // Pi writes a failed reply before the context edit that drops it for a retry.
      let seen = -1;
      while (!run && alive(processId)) {
        await sleep(SETTLE_POLL_MS);
        if (!alive(processId)) break;
        const entries = written();
        if (entries.some(userMessage)) this.begin();
        const ready = settledRun(entries, this.steers);
        run = ready && entries.length === seen ? ready : undefined;
        seen = ready ? entries.length : -1;
      }
      this.settled = run !== undefined;
      const entries = written();
      const stderr = this.settled || this.ending ? "" : readText(this.files.err) || (await this.screen());
      await this.close(opts.graceMs);
      return { exitCode: null, settled: this.settled, ...replyOf(entries), interruption: run?.interruption, stderr };
    } catch (e) {
      await this.close(opts.graceMs);
      return { exitCode: null, settled: false, finalText: replyOf(written()).finalText, errorMessage: orcaError(e), stderr: "" };
    } finally {
      this.removeFiles();
    }
  }

  private removeFiles(): void {
    for (const file of Object.values(this.files)) {
      try {
        unlinkSync(file);
      } catch {}
    }
  }

  private stop(graceMs: number): void {
    const pid = this.terminalPid;
    if (pid !== undefined) void terminateGroup(pid, () => alive(pid), graceMs);
  }

  private async close(graceMs: number): Promise<void> {
    this.stop(graceMs);
    while (this.terminalPid !== undefined && alive(this.terminalPid)) await sleep(CLOSE_POLL_MS);
    // Orca usually removes the tab itself once pi is gone, and then there is nothing to close.
    if (this.handle !== undefined) await this.orca(Type.Unknown(), ["terminal", "close", `--terminal=${this.handle}`]).catch(() => undefined);
  }

  private screen(): Promise<string> {
    return this.orca(readResult, ["terminal", "read", `--terminal=${this.handle}`, "--screen"]).then(
      ({ result }) => result.terminal.tail.join("\n"),
      () => "",
    );
  }

  private async orca<T extends TSchema>(schema: T, args: string[]): Promise<Static<T>> {
    const { stdout } = await execOrca(this.cli, [...args, "--json"], { timeout: CALL_TIMEOUT_MS }).catch((e: { killed?: boolean }) => {
      throw e.killed ? new Error(`orca ${args[0]} ${args[1]} did not answer within ${CALL_TIMEOUT_MS / 1000} s`) : e;
    });
    let answer: unknown;
    try {
      answer = JSON.parse(stdout);
    } catch {}
    if (!Value.Check(schema, answer)) throw new Error(`orca ${args[0]} ${args[1]} answered: ${stdout.trim().slice(0, 300)}`);
    return answer;
  }
}

function readText(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function quote(text: string): string {
  return `'${text.replaceAll("'", "'\\''")}'`;
}

// With --json the Orca CLI reports a failure on stdout.
function orcaError(e: unknown): string {
  const { stdout = "", stderr = "" } = e as { stdout?: string; stderr?: string };
  try {
    const answer: unknown = JSON.parse(stdout);
    if (Value.Check(failedResult, answer)) return answer.error.message;
  } catch {}
  return stderr.trim() || (e as Error).message;
}
