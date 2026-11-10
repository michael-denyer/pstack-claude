import { execFile, spawn } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { promisify } from "node:util";
import { type Static, type TSchema, Type } from "typebox";
import { Value } from "typebox/value";

import { assistantText, type ChildExit } from "./child.ts";

const execHc = promisify(execFile);
const SCREEN_LINES = "30";

const waitResult = Type.Object({
  reason: Type.String(),
  status: Type.Union([Type.String(), Type.Null()]),
  exit_code: Type.Union([Type.Number(), Type.Null()]),
});
type WaitResult = Static<typeof waitResult>;
const runResult = Type.Object({ address: Type.String() });
const sendResult = Type.Object({ wait: Type.Optional(waitResult) });
const transcriptReply = Type.Object({
  type: Type.Literal("message"),
  message: Type.Object({
    role: Type.Literal("assistant"),
    content: Type.Array(Type.Unknown()),
    stopReason: Type.Optional(Type.Unknown()),
    errorMessage: Type.Optional(Type.String()),
  }),
});

export class HcChild {
  readonly pid = undefined;
  readonly activity = undefined;
  readonly exited: Promise<ChildExit>;
  private settled = false;
  private ending = false;

  constructor(
    private readonly name: string,
    command: string,
    args: string[],
    opts: { cwd: string; env: Record<string, string | undefined>; transcript: () => string | undefined },
    prompt: string,
  ) {
    const env = Object.entries(opts.env).flatMap(([key, value]) => (value === undefined ? [] : [`${key}=${value}`]));
    const run = ["run", "--json", "--bg", "--no-notify", "--name", name, "--cwd", opts.cwd, "env", ...env, command, ...args];
    this.exited = this.drive(run, opts.transcript, prompt);
  }

  async steer(message: string): Promise<{ response: { success: boolean } | undefined; taken: boolean }> {
    if (this.settled) return { response: undefined, taken: false };
    try {
      await execHc("hc", ["send", "--json", "--if", "working", this.name, message]);
    } catch {
      return { response: undefined, taken: false };
    }
    return { response: { success: true }, taken: !this.settled };
  }

  end(): void {
    this.ending = true;
    void quiet(["kill", this.name]);
  }

  signal(): void {
    spawn("hc", ["kill", this.name], { detached: true, stdio: "ignore" }).unref();
  }

  private async drive(run: string[], transcript: () => string | undefined, prompt: string): Promise<ChildExit> {
    const from = sizeOf(transcript());
    try {
      await hc(runResult, run);
      const last = await this.turn(prompt);
      this.settled = last.status === "done";
      const stderr = this.settled || this.ending ? "" : await this.screen();
      const exit = last.reason === "exit" ? last : await this.close();
      return { exitCode: exit.exit_code, settled: this.settled, ...replyIn(transcript(), from), stderr };
    } catch (e) {
      await this.close().catch(() => undefined);
      return { exitCode: null, settled: false, finalText: replyIn(transcript(), from).finalText, errorMessage: hcError(e), stderr: "" };
    } finally {
      await quiet(["rm", this.name]);
    }
  }

  private async turn(prompt: string): Promise<WaitResult> {
    const ready = await this.wait();
    if (ready.status !== "idle" || this.ending) return ready;
    const { wait } = await hc(sendResult, ["send", "--json", "--wait", this.name, prompt]);
    return wait && wait.reason !== "timeout" ? wait : this.wait();
  }

  private async wait(): Promise<WaitResult> {
    for (;;) {
      const state = await hc(waitResult, ["wait", "--json", this.name]);
      if (state.reason !== "timeout") return state;
    }
  }

  private async close(): Promise<WaitResult> {
    await quiet(["kill", this.name]);
    return this.wait();
  }

  private screen(): Promise<string> {
    return execHc("hc", ["read", "--lines", SCREEN_LINES, this.name]).then(
      ({ stdout }) => stdout,
      () => "",
    );
  }
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
