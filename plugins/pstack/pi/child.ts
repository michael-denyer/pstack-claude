import { type ChildProcessByStdio, spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import type { RpcCommand, RpcResponse } from "@earendil-works/pi-coding-agent";

const STDERR_CAP = 8 * 1024;
const CLOSE_AFTER_EXIT_MS = 2000;
// Dialogs block the child until the client answers; a notify or status needs none.
const DIALOGS = new Set(["select", "confirm", "input", "editor"]);

export interface ChildExit {
  exitCode: number | null;
  // Whether the run reached agent_settled, which is when its work was done.
  settled: boolean;
  finalText: string;
  // "" when the run ended cleanly.
  errorMessage: string;
  stderr: string;
}

type Shape = Record<string, unknown>;
const isShape = (value: unknown): value is Shape => typeof value === "object" && value !== null;

// The text parts of an assistant message's content, read defensively: the
// stream is pi's, but a line that lacks a field must not end the agent.
function assistantText(content: unknown[]): string {
  return content
    .filter((p): p is Shape => isShape(p) && p.type === "text" && typeof p.text === "string")
    .map((p) => p.text as string)
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
  private readonly pending = new Map<string, (response: RpcResponse | undefined) => void>();
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
      else if (response.command === "prompt" && response.data?.disposition === "handled") {
        this.errorMessage = "pi consumed the prompt as an extension command, so no agent run started. Send the task as plain text.";
      } else return;
      this.close();
    });
  }

  // Resolves with pi's response, or undefined when stdin is closed or the
  // process exits first.
  command(command: RpcCommand): Promise<RpcResponse | undefined> {
    return new Promise((resolve) => this.send(command, resolve));
  }

  // Pi answers a steer it reads after settling with "queued" and never runs
  // it, since it exits on EOF. So a steer was taken into the run only when the
  // run had not settled as its response was read, which is when `taken` is
  // decided: the settle can follow in the same chunk of output.
  steer(message: string): Promise<{ response: RpcResponse | undefined; taken: boolean }> {
    return new Promise((resolve) =>
      this.send({ type: "steer", message }, (response) => resolve({ response, taken: response?.success === true && !this.settled })),
    );
  }

  private send(command: RpcCommand, onResponse: (response: RpcResponse | undefined) => void): void {
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
    if (!line.trim()) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    if (!isShape(parsed)) return;
    switch (parsed.type) {
      case "response": {
        if (typeof parsed.id !== "string") return;
        // A response that is not pi's shape still answers its command, as a failure.
        const response = typeof parsed.success === "boolean" ? parsed : { ...parsed, success: false, error: `malformed response: ${JSON.stringify(parsed).slice(0, 200)}` };
        this.pending.get(parsed.id)?.(response as RpcResponse);
        this.pending.delete(parsed.id);
        return;
      }
      case "message_end": {
        const message = parsed.message;
        if (!isShape(message) || message.role !== "assistant" || !Array.isArray(message.content)) return;
        // A tool-call-only message is normal mid-run and the next text clears
        // the note; a run that ends on one has no answer, only earlier text.
        const text = assistantText(message.content);
        if (text) this.finalText = text;
        const error = typeof message.errorMessage === "string" ? message.errorMessage : undefined;
        this.errorMessage = error ?? (text ? "" : `(the last assistant message had no text; stop reason: ${String(message.stopReason)})`);
        return;
      }
      case "agent_settled":
        this.settled = true;
        this.close();
        return;
      case "extension_ui_request":
        if (typeof parsed.id === "string" && typeof parsed.method === "string" && DIALOGS.has(parsed.method)) {
          this.proc.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: parsed.id, cancelled: true })}\n`);
        }
        return;
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
