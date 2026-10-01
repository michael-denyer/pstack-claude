import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { AgentRunner, registerAgentTools } from "./agents.ts";
import { defaultSettings, type Settings } from "./config.ts";
import { Inbox } from "./inbox.ts";
import { registerInteraction, Scheduler } from "./interaction.ts";
import { registerLifecycle } from "./lifecycle.ts";

export function install(pi: ExtensionAPI, settings: Settings): void {
  const runner = new AgentRunner(pi, settings);
  const scheduler = new Scheduler(pi);
  const inbox = settings.inbox ? new Inbox(pi, settings.inbox) : undefined;
  registerAgentTools(pi, runner);
  registerInteraction(pi, scheduler);
  // Children run detached so a stop can kill their whole tree, which also means
  // they outlive a parent that exits without session_shutdown: a crash, or Ctrl-C
  // in print mode, where pi leaves SIGINT at its default.
  const onExit = () => runner.signalAll();
  const onSigint = () => {
    runner.signalAll();
    process.exit(130);
  };
  process.on("exit", onExit);
  pi.on("session_start", (_event, ctx) => {
    runner.restore(ctx.sessionManager.getEntries());
    inbox?.start(ctx);
    if ((ctx.mode === "print" || ctx.mode === "json") && process.listenerCount("SIGINT") === 0) process.on("SIGINT", onSigint);
  });
  // Print and json runs exit once the agent settles, which would drop a
  // background agent's notice. Holding the settle until one exits queues its
  // notice, so Pi runs another turn and settles again. A message from the
  // parent agent ends the hold the same way.
  pi.on("agent_before_settle", async (_event, ctx) => {
    if (await inbox?.deliver(ctx)) return;
    if (ctx.mode === "print" || ctx.mode === "json") await Promise.race([runner.nextExit(), ...(inbox ? [inbox.arrival()] : [])]);
  });
  registerLifecycle(pi, settings, async () => {
    process.off("exit", onExit);
    process.off("SIGINT", onSigint);
    inbox?.stop();
    scheduler.stopAll();
    await runner.stopAll();
  });
}

export default function pstack(pi: ExtensionAPI): void {
  const settings = defaultSettings();
  // A pi that this agent's bash tool starts must not take the agent's messages.
  delete process.env.PSTACK_PI_INBOX;
  install(pi, settings);
}
