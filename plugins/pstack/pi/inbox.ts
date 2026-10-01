import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const POLL_MS = 200;
const QUEUE_WAIT_MS = 2000;

// An agent's mailbox: a directory with one file per message, named so a sort
// is send order. Whoever renames a message out of it first owns it: the
// running child, which steers its own run with it, or the parent after the
// child exited, which resumes the agent with it. Each message lands once.
export function post(dir: string, text: string): void {
  mkdirSync(dir, { recursive: true });
  const name = String(process.hrtime.bigint()).padStart(24, "0");
  writeFileSync(join(dir, `${name}.tmp`), text);
  renameSync(join(dir, `${name}.tmp`), join(dir, `${name}.msg`));
}

export function take(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const texts: string[] = [];
  for (const name of readdirSync(dir).filter((n) => n.endsWith(".msg")).sort()) {
    const claimed = join(dir, `${name}.${process.pid}`);
    try {
      renameSync(join(dir, name), claimed);
    } catch {
      continue;
    }
    texts.push(readFileSync(claimed, "utf8"));
    rmSync(claimed);
  }
  return texts;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The child's half. While a run streams, each message becomes a steer, which
// Pi delivers after the current tool calls and before the next model request.
// An idle session takes nothing, so a message that arrives after the run
// settled stays for the parent.
export class Inbox {
  private readonly pi: ExtensionAPI;
  private readonly dir: string;
  private ctx?: ExtensionContext;
  private timer?: ReturnType<typeof setInterval>;
  private arrived = Promise.withResolvers<void>();

  // No parameter properties: the fake pi in tests/pi imports this file
  // through Node's type stripping, which rejects them.
  constructor(pi: ExtensionAPI, dir: string) {
    this.pi = pi;
    this.dir = dir;
  }

  start(ctx: ExtensionContext): void {
    this.ctx = ctx;
    this.timer ??= setInterval(() => void (this.ctx && this.deliver(this.ctx)), POLL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  // Resolves true once every taken message is in Pi's steering queue, so a
  // settle boundary that returns afterwards sees it and continues the run.
  async deliver(ctx: ExtensionContext): Promise<boolean> {
    if (ctx.isIdle()) return false;
    const texts = take(this.dir);
    if (!texts.length) return false;
    for (const text of texts) this.pi.sendUserMessage(text, { deliverAs: "steer" });
    const deadline = Date.now() + QUEUE_WAIT_MS;
    while (!ctx.hasPendingMessages() && Date.now() < deadline) await sleep(5);
    this.arrived.resolve();
    this.arrived = Promise.withResolvers<void>();
    return true;
  }

  // Resolves when the poll next delivers a message.
  arrival(): Promise<void> {
    return this.arrived.promise;
  }
}
