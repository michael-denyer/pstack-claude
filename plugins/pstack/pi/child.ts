import { type ChildProcessByStdio, spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import type { RpcCommand } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

const STDERR_CAP = 8 * 1024;
const CLOSE_AFTER_EXIT_MS = 2000;

// What this reader takes from pi's stdout. The stream is pi's, but a line, or
// the part of one a field comes from, is checked against these before the
// field is read, and a line that fits none is skipped: one that lacks a field
// must not end the agent.
const answerLine = Type.Object({ type: Type.Literal("response"), id: Type.String() });
const responseSchema = Type.Object({ success: Type.Boolean(), error: Type.Optional(Type.String()) });
type Answer = Static<typeof responseSchema>;
const handledPrompt = Type.Object({ command: Type.Literal("prompt"), data: Type.Object({ disposition: Type.Literal("handled") }) });
const assistantEndLine = Type.Object({
  type: Type.Literal("message_end"),
  message: Type.Object({ role: Type.Literal("assistant"), content: Type.Array(Type.Unknown()), stopReason: Type.Optional(Type.Unknown()) }),
});
const textPart = Type.Object({ type: Type.Literal("text"), text: Type.String() });
const failedMessage = Type.Object({ errorMessage: Type.String() });
const settledLine = Type.Object({ type: Type.Literal("agent_settled") });
// Dialogs block the child until the client answers; a notify or status needs none.
const dialogLine = Type.Object({
  type: Type.Literal("extension_ui_request"),
  id: Type.String(),
  method: Type.Union([Type.Literal("select"), Type.Literal("confirm"), Type.Literal("input"), Type.Literal("editor")]),
});

export interface ChildExit {
  exitCode: number | null;
  // Whether the run reached agent_settled, which is when its work was done.
  settled: boolean;
  finalText: string;
  // "" when the run ended cleanly.
  errorMessage: string;
  stderr: string;
}

function assistantText(content: unknown[]): string {
  return content
    .filter((part) => Value.Check(textPart, part))
    .map((part) => part.text)
    .join("\n")
    .trim();
}

// One `pi --mode rpc` process: the parent's only handle on its stdin and the
// only reader of its stdout. The prompt goes in as a command, so argv never
// caps it and a leading @ is never a file. A rejected prompt, or one an
// extension command consumed, starts no run and so brings no agent_settled;
// stdin closes at once then, and otherwise at the first agent_settled, after
// which pi exits on its own.
export class PiChild {
  readonly pid: number | undefined;
  readonly exited: Promise<ChildExit>;
  private readonly proc: ChildProcessByStdio<Writable, Readable, Readable>;
  private readonly exitGraceMs: number;
  private readonly pending = new Map<string, (response: Answer | undefined) => void>();
  private nextId = 0;
  private open = true;
  private settled = false;
  private finalText = "";
  private errorMessage = "";
  private stderr = "";

  constructor(command: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; exitGraceMs: number }, prompt: string) {
    this.exitGraceMs = opts.exitGraceMs;
    this.proc = spawn(command, args, { cwd: opts.cwd, env: opts.env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    this.pid = this.proc.pid;
    this.proc.stdin.on("error", () => {});
    const decoder = new StringDecoder("utf8");
    let buffered = "";
    const feed = (chunk: string) => {
      buffered += chunk;
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) this.onLine(line);
    };
    this.proc.stdout.on("data", (b: Buffer) => feed(decoder.write(b)));
    this.proc.stderr.on("data", (b: Buffer) => {
      this.stderr = (this.stderr + b.toString("utf8")).slice(-STDERR_CAP);
    });
    this.exited = new Promise<ChildExit>((resolve) => {
      let exitCode: number | null = null;
      let done = false;
      const finish = (spawnError?: Error) => {
        if (done) return;
        done = true;
        this.open = false;
        feed(decoder.end());
        if (buffered) this.onLine(buffered);
        if (spawnError) this.errorMessage = spawnError.message;
        for (const settle of this.pending.values()) settle(undefined);
        this.pending.clear();
        resolve({ exitCode: spawnError ? null : exitCode, settled: this.settled, finalText: this.finalText, errorMessage: this.errorMessage, stderr: this.stderr });
      };
      this.proc.on("error", finish);
      // A process holding the pipes open after pi exited must not keep the
      // agent running; it is not signalled, since it is not one this runner
      // spawned.
      let pipeTimer: NodeJS.Timeout | undefined;
      this.proc.on("exit", (code) => {
        exitCode = code;
        pipeTimer = setTimeout(() => {
          this.proc.stdout.destroy();
          this.proc.stderr.destroy();
          finish();
        }, CLOSE_AFTER_EXIT_MS).unref();
      });
      this.proc.on("close", (code) => {
        clearTimeout(pipeTimer);
        exitCode = code ?? exitCode;
        finish();
      });
    });
    void this.command({ type: "prompt", message: prompt }).then((response) => {
      if (!response) return;
      if (!response.success) this.errorMessage = response.error ?? "pi rejected the prompt";
      else if (Value.Check(handledPrompt, response)) {
        this.errorMessage = "pi consumed the prompt as an extension command, so no agent run started. Send the task as plain text.";
      } else return;
      this.close();
    });
  }

  // Resolves with pi's response, or undefined when stdin is closed or the
  // process exits first.
  command(command: RpcCommand): Promise<Answer | undefined> {
    return new Promise((resolve) => this.send(command, resolve));
  }

  // Pi answers a steer it reads after settling with "queued" and never runs
  // it, since it exits on EOF. So a steer was taken into the run only when the
  // run had not settled as its response was read, which is when `taken` is
  // decided: the settle can follow in the same chunk of output.
  steer(message: string): Promise<{ response: Answer | undefined; taken: boolean }> {
    return new Promise((resolve) =>
      this.send({ type: "steer", message }, (response) => resolve({ response, taken: response?.success === true && !this.settled })),
    );
  }

  private send(command: RpcCommand, onResponse: (response: Answer | undefined) => void): void {
    if (!this.open) return onResponse(undefined);
    const id = `c${++this.nextId}`;
    this.pending.set(id, onResponse);
    this.proc.stdin.write(`${JSON.stringify({ id, ...command })}\n`);
  }

  // Pi exits on EOF once idle. One that does not is ended, since nothing else
  // would end the agent.
  close(): void {
    if (!this.open) return;
    this.open = false;
    this.proc.stdin.end();
    setTimeout(() => this.terminate(this.exitGraceMs), this.exitGraceMs).unref();
  }

  // SIGTERM now, SIGKILL if the child is still there after the grace period.
  terminate(graceMs: number): void {
    this.signal("SIGTERM");
    setTimeout(() => this.signal("SIGKILL"), graceMs).unref();
  }

  // Signals the child's group only while the child itself is alive: once it
  // has exited the group id may belong to a process this runner never spawned.
  signal(signal: NodeJS.Signals): void {
    if (this.pid && this.proc.exitCode === null && this.proc.signalCode === null) signalGroup(this.pid, signal);
  }

  private onLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    if (Value.Check(answerLine, parsed)) {
      // A response that is not pi's shape still answers its command, as a failure.
      const malformed = { success: false, error: `malformed response: ${JSON.stringify(parsed).slice(0, 200)}` };
      this.pending.get(parsed.id)?.(Value.Check(responseSchema, parsed) ? parsed : malformed);
      this.pending.delete(parsed.id);
    } else if (Value.Check(assistantEndLine, parsed)) {
      // A tool-call-only message is normal mid-run and the next text clears
      // the note; a run that ends on one has no answer, only earlier text.
      const { message } = parsed;
      const text = assistantText(message.content);
      if (text) this.finalText = text;
      if (Value.Check(failedMessage, message)) this.errorMessage = message.errorMessage;
      else this.errorMessage = text ? "" : `(the last assistant message had no text; stop reason: ${String(message.stopReason)})`;
    } else if (Value.Check(settledLine, parsed)) {
      this.settled = true;
      this.close();
    } else if (Value.Check(dialogLine, parsed)) {
      this.proc.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: parsed.id, cancelled: true })}\n`);
    }
  }
}

// A process, or with a negative pid its whole group. EPERM means it exists
// under another user.
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {}
}
