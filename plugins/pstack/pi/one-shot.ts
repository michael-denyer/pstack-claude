import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { AgentRunner } from "./agents.ts";
import type { Settings } from "./config.ts";

const PENDING_POLL_MS = 50;

export interface OneShot {
  exits(ctx: Pick<ExtensionContext, "mode">): boolean;
  untilSettled(): Promise<void>;
  dispose(): void;
}

// Resolves once Pi has a queued message, which is the same condition Pi checks
// after agent_before_settle returns to decide whether the run continues.
function pendingMessage(ctx: ExtensionContext, signal: { done: boolean }): Promise<void> {
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      if (!signal.done && !ctx.hasPendingMessages()) return;
      clearInterval(timer);
      resolve();
    }, PENDING_POLL_MS);
    timer.unref();
  });
}

// Everything that follows from "this process ends when the run settles":
// a background agent's notice would be lost, so the settle is held until one
// exits or a message arrives; /loop must wait for the run it started; a wakeup
// could never fire; Ctrl-C must take the children along, since pi leaves SIGINT
// at its default in print mode.
export function registerOneShot(pi: ExtensionAPI, settings: Settings, runner: Pick<AgentRunner, "nextExit">): OneShot {
  // Print and json runs exit once the agent settles. A pstack child is an rpc
  // process whose parent closes its stdin at the same moment, so it is one-shot too.
  const exits = (ctx: Pick<ExtensionContext, "mode">) => ctx.mode === "print" || ctx.mode === "json" || settings.depth > 0;
  const settleWaiters: (() => void)[] = [];
  const settle = () => {
    for (const resolve of settleWaiters.splice(0)) resolve();
  };
  // The exit hook in index.ts signals the children.
  const onSigint = () => process.exit(130);
  pi.on("session_start", (_event, ctx) => {
    if (exits(ctx) && process.listenerCount("SIGINT") === 0) process.on("SIGINT", onSigint);
  });
  pi.on("agent_before_settle", async (_event, ctx) => {
    if (!exits(ctx) || ctx.hasPendingMessages()) return;
    const signal = { done: false };
    await Promise.race([runner.nextExit(), pendingMessage(ctx, signal)]);
    signal.done = true;
  });
  pi.on("agent_settled", settle);
  return {
    exits,
    untilSettled: () => new Promise<void>((resolve) => settleWaiters.push(resolve)),
    dispose: () => {
      process.off("SIGINT", onSigint);
      settle();
    },
  };
}
