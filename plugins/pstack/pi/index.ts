import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { AgentRunner, registerAgentTools } from "./agents.ts";
import { defaultSettings, type Settings } from "./config.ts";
import { registerInteraction, Scheduler } from "./interaction.ts";
import { registerLifecycle } from "./lifecycle.ts";

export function install(pi: ExtensionAPI, settings: Settings): void {
  const runner = new AgentRunner(pi, settings);
  const scheduler = new Scheduler(pi);
  registerAgentTools(pi, runner);
  registerInteraction(pi, scheduler);
  pi.on("session_start", (_event, ctx) => {
    runner.restore(ctx.sessionManager.getEntries());
  });
  // Print and json runs exit once the agent settles, which would drop a
  // background agent's notice. Holding the settle until one exits queues its
  // notice as a follow-up, so Pi runs another turn and settles again.
  pi.on("agent_before_settle", async (_event, ctx) => {
    if (ctx.mode === "print" || ctx.mode === "json") await runner.nextExit();
  });
  registerLifecycle(pi, settings, async () => {
    scheduler.stopAll();
    await runner.stopAll();
  });
}

export default function pstack(pi: ExtensionAPI): void {
  install(pi, defaultSettings());
}
