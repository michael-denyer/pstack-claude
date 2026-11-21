import { execFile, spawn } from "node:child_process";
import { readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { type Static, type TSchema, Type } from "typebox";
import { Value } from "typebox/value";

import { alive, assistantText, type ChildExit, signalGroup, terminateGroup } from "./child.ts";

const execHc = promisify(execFile);
const SCREEN_LINES = "30";
const CLOSE_POLL_MS = 200;
const STARTUP_POLL_MS = 500;
const NOT_THE_CHILD = new Set(["timeout", "message"]);
const TERMINAL_VARS = new Set(["COLORTERM", "TERM", "TERM_PROGRAM", "PWD", "OLDPWD", "SHLVL", "_"]);
const LOAD_ENV = '. "$1" && rm -- "$1" && shift && exec "$@"';

const waitResult = Type.Object({
  reason: Type.String(),
  status: Type.Union([Type.String(), Type.Null()]),
  exit_code: Type.Union([Type.Number(), Type.Null()]),
});
type WaitResult = Static<typeof waitResult>;
const runResult = Type.Object({ address: Type.String() });
const getResult = Type.Object({
  pid: Type.Union([Type.Number(), Type.Null()]),
  status: Type.Union([Type.Object({ state: Type.String() }), Type.Null()]),
  turn: Type.Number(),
});
const sendResult = Type.Object({ started: Type.Optional(Type.Boolean()), wait: Type.Optional(waitResult) });
const transcriptReply = Type.Object({
  type: Type.Literal("message"),
  message: Type.Object({
    role: Type.Literal("assistant"),
    content: Type.Array(Type.Unknown()),
    stopReason: Type.Optional(Type.Unknown()),
    errorMessage: Type.Optional(Type.String()),
  }),
});

export interface HcOptions {
  cwd: string;
  env: Record<string, string | undefined>;
  envFile: string;
  graceMs: number;
  transcript: () => string | undefined;
  onStart: (pid: number) => void;
}

export class HcChild {
  readonly pid = undefined;
  readonly activity = undefined;
  readonly exited: Promise<ChildExit>;
  private terminalPid?: number;
  private settled = false;
  private ending = false;

  constructor(
    private readonly name: string,
    command: string,
    args: string[],
    opts: HcOptions,
    prompt: string,
  ) {
    writeFileSync(opts.envFile, envScript({ ...process.env, ...opts.env }), { mode: 0o600 });
    const run = ["run", "--json", "--bg", "--no-notify", "--name", name, "--cwd", opts.cwd, "--", "sh", "-c", LOAD_ENV, "pstack-env", opts.envFile, command, ...args];
    this.exited = this.drive(run, opts, prompt);
  }

  async steer(message: string): Promise<{ response: { success: boolean } | undefined; taken: boolean }> {
    if (this.settled) return { response: undefined, taken: false };
    try {
      await execHc("hc", ["send", "--json", "--if", "working", "--", this.name, message]);
    } catch {
      return { response: undefined, taken: false };
    }
    return { response: { success: true }, taken: !this.settled };
  }

  end(graceMs: number): void {
    this.ending = true;
    this.stop(graceMs);
  }

  signal(signal: NodeJS.Signals): void {
    if (this.terminalPid === undefined) spawn("hc", ["kill", this.name], { detached: true, stdio: "ignore" }).unref();
    else signalGroup(this.terminalPid, signal);
  }

  private async drive(run: string[], opts: HcOptions, prompt: string): Promise<ChildExit> {
    const from = sizeOf(opts.transcript());
    try {
      await hc(runResult, run);
      const { pid } = await hc(getResult, ["get", "--json", this.name]);
      if (pid !== null) {
        this.terminalPid = pid;
        opts.onStart(pid);
      }
      const last = await this.turn(prompt);
      this.settled = last.status === "done";
      const stderr = this.settled || this.ending ? "" : await this.screen();
      const exit = last.reason === "exit" ? last : await this.close(opts.graceMs);
      return { exitCode: exit.exit_code, settled: this.settled, ...replyIn(opts.transcript(), from), stderr };
    } catch (e) {
      await this.close(opts.graceMs).catch(() => undefined);
      return { exitCode: null, settled: false, finalText: replyIn(opts.transcript(), from).finalText, errorMessage: hcError(e), stderr: "" };
    } finally {
      await quiet(["rm", this.name]);
      try {
        unlinkSync(opts.envFile);
      } catch {}
    }
  }

  private stop(graceMs: number): void {
    const pid = this.terminalPid;
    if (pid === undefined) void quiet(["kill", this.name]);
    else void terminateGroup(pid, () => alive(pid), graceMs);
  }

  private async turn(prompt: string): Promise<WaitResult> {
    const ready = await this.wait();
    if (ready.status !== "idle" || this.ending) return ready;
    const { started, wait } = await hc(sendResult, ["send", "--json", "--wait", "--", this.name, prompt]);
    if (started === false) return this.submitAfterStartup();
    return wait && !NOT_THE_CHILD.has(wait.reason) ? wait : this.wait();
  }

  // Pi reports idle before its startup ends, and an Enter before then leaves the prompt in its editor.
  private async submitAfterStartup(): Promise<WaitResult> {
    for (;;) {
      await sleep(STARTUP_POLL_MS);
      const { status, turn } = await hc(getResult, ["get", "--json", this.name]);
      if (status?.state !== "idle" || turn > 0 || this.ending) return this.wait();
      await execHc("hc", ["keys", "--", this.name, "enter"]);
    }
  }

  private async wait(): Promise<WaitResult> {
    for (;;) {
      const state = await hc(waitResult, ["wait", "--json", this.name]);
      if (!NOT_THE_CHILD.has(state.reason)) return state;
    }
  }

  private async close(graceMs: number): Promise<WaitResult> {
    this.stop(graceMs);
    for (;;) {
      const state = await this.wait();
      if (state.reason === "exit") return state;
      await sleep(CLOSE_POLL_MS);
    }
  }

  private screen(): Promise<string> {
    return execHc("hc", ["read", "--lines", SCREEN_LINES, this.name]).then(
      ({ stdout }) => stdout,
      () => "",
    );
  }
}

export function envScript(env: NodeJS.ProcessEnv): string {
  return Object.entries(env)
    .filter(([name, value]) => value !== undefined && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !name.startsWith("HC_") && !TERMINAL_VARS.has(name))
    .map(([name, value]) => `export ${name}='${(value ?? "").replaceAll("'", "'\\''")}'\n`)
    .join("");
}

export function replyIn(file: string | undefined, from: number): Pick<ChildExit, "finalText" | "errorMessage"> {
  const reply = { finalText: "", errorMessage: "" };
  if (!file) return reply;
  for (const entry of jsonLines(readFileSync(file).subarray(from).toString("utf8"))) {
    if (!Value.Check(transcriptReply, entry)) continue;
    const { message } = entry;
    const text = assistantText(message.content);
    if (text) reply.finalText = text;
    reply.errorMessage = message.errorMessage ?? (text ? "" : `(the last assistant message had no text; stop reason: ${String(message.stopReason)})`);
  }
  return reply;
}

async function hc<T extends TSchema>(schema: T, args: string[]): Promise<Static<T>> {
  const { stdout } = await execHc("hc", args);
  const result: unknown = JSON.parse(stdout.trim().split("\n").at(-1) ?? "");
  if (!Value.Check(schema, result)) throw new Error(`hc ${args[0]} answered: ${stdout.trim().slice(0, 300)}`);
  return result;
}

function quiet(args: string[]): Promise<unknown> {
  return execHc("hc", args).catch(() => undefined);
}

function hcError(e: unknown): string {
  return (e as { stderr?: string }).stderr?.trim() || (e as Error).message;
}

function sizeOf(file: string | undefined): number {
  return file ? statSync(file).size : 0;
}

function jsonLines(text: string): unknown[] {
  return text.split("\n").flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}
