import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { AgentRunner } from "./agents.ts";
import type { Settings } from "./config.ts";

const PENDING_POLL_MS = 50;

export interface OneShot {
  exits(ctx: Pick<ExtensionContext, "mode">): boolean;
  untilSettled(): Promise<void>;
  assertStartsRun(prompt: string, ctx: ExtensionContext): Promise<void>;
  dispose(): void;
}

// Why Pi would start no run for a prompt this extension sends, by the checks
// its prompt() makes first: an extension command runs in place, and a prompt
// without a model or credentials is refused. No settle follows either, and Pi
// reports a refusal only to its own error listeners, so a one-shot /loop
// waiting on the settle would never return. It cannot see an input handler
// that consumes the prompt.
async function noRunReason(pi: ExtensionAPI, prompt: string, ctx: ExtensionContext): Promise<string | undefined> {
  if (prompt.startsWith("/")) {
    const space = prompt.indexOf(" ");
    const name = prompt.slice(1, space === -1 ? undefined : space);
    if (pi.getCommands().some((command) => command.source === "extension" && command.name === name)) {
      return `/${name} is an extension command, not a prompt`;
    }
  }
  const model = ctx.model;
  if (!model) return "no model is selected";
  if (ctx.modelRegistry.hasConfiguredAuth(model)) return undefined;
  const available = await ctx.modelRegistry.getAvailableOfType("chat", model.provider);
  return available.length ? undefined : "the selected model has no credentials";
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
    assertStartsRun: async (prompt, ctx) => {
      const reason = await noRunReason(pi, prompt, ctx);
      if (reason === undefined) return;
      // Pi prints a command handler's throw and still exits 0.
      process.exitCode = 1;
      throw new Error(`No run would start: ${reason}`);
    },
    dispose: () => {
      process.off("SIGINT", onSigint);
      settle();
    },
  };
}
