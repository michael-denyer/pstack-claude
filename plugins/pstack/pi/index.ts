import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerAgentTools } from "./agent-tools.ts";
import { AgentRunner } from "./agents.ts";
import { defaultSettings, type Settings } from "./config.ts";
import { registerInteraction, Scheduler } from "./interaction.ts";
import { registerOneShot } from "./one-shot.ts";
import { registerPathSkills } from "./path-skills.ts";
import { registerPromptSections } from "./prompt.ts";

export function install(pi: ExtensionAPI, settings: Settings): void {
  const runner = new AgentRunner(pi, settings);
  const scheduler = new Scheduler(pi);
  const oneShot = registerOneShot(pi, settings, runner);
  registerAgentTools(pi, runner);
  registerInteraction(pi, scheduler, oneShot);
  registerPromptSections(pi, settings);
  registerPathSkills(pi, settings);
  // Children run detached, in their own process group, so a parent that exits
  // without session_shutdown would leave them running: this exit hook signals
  // them, and each child pi then ends the bash command it has running.
  const onExit = () => runner.signalAll();
  process.on("exit", onExit);
  // Every entry, not the active branch: an agent started on a branch the user
  // later left is still a process, and its record is the only handle on it.
  pi.on("session_start", (_event, ctx) => runner.restore(ctx.sessionManager.getEntries()));
  pi.on("session_shutdown", async () => {
    process.off("exit", onExit);
    oneShot.dispose();
    scheduler.stopAll();
    await runner.stopAll();
  });
}

export default function pstack(pi: ExtensionAPI): void {
  install(pi, defaultSettings());
}
