import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { AgentRunner, registerAgentTools } from "./agents.ts";
import { defaultSettings, type Settings } from "./config.ts";
import { registerLifecycle } from "./lifecycle.ts";

export function install(pi: ExtensionAPI, settings: Settings): AgentRunner {
  const runner = new AgentRunner(pi, settings);
  registerAgentTools(pi, runner);
  pi.on("session_start", (_event, ctx) => {
    runner.restore(ctx.sessionManager.getEntries());
  });
  registerLifecycle(pi, settings, () => runner.stopAll());
  return runner;
}

export default function pstack(pi: ExtensionAPI): void {
  install(pi, defaultSettings());
}
