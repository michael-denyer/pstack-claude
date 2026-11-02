import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { Type } from "typebox";

import { frontmatter } from "./config.ts";
import type { OneShot } from "./one-shot.ts";

const MIN_DELAY_S = 60;
const MAX_DELAY_S = 3600;
// setInterval treats a delay above 2^31-1 ms as 1 ms.
const MAX_LOOP_S = 24 * 86400;
const IDLE_RETRY_MS = 1000;
// Text the agent chose (a schedule_wakeup prompt, and what a loop it re-arms sends) goes in as a custom
// message, not a user message. The permission classifier reads user-role messages as what the user asked
// for, so a user message here would let the agent write its own permission.
const AGENT_PROMPT_TYPE = "pstack-wakeup";
const LOOP_COMMAND = /^\/loop(?:\s+([\s\S]*))?$/;

// Pi expands "/skill:x args" and "/template args" only inside sendUserMessage and exposes no helper for
// it, so the agent's slash text is expanded here from the files pi.getCommands() points at, the way
// AgentSession._expandSkillCommand and expandPromptTemplate do (pi 1.4.0). An extension command stays
// plain text: pi dispatches it only from a user message, and the agent must not run one as the user.
function words(line: string): string[] {
  return (line.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((w) => w.replace(/^(["'])([\s\S]*)\1$/, "$2"));
}

// $1, $@, $ARGUMENTS, ${1:-default}, ${@:N} and ${@:N:L}, as pi's substituteArgs.
function fillArgs(body: string, args: string[]): string {
  return body.replace(/\$\{(\d+|ARGUMENTS|@):-([^}]*)\}|\$\{@:(\d+)(?::(\d+))?\}|\$(ARGUMENTS|@|\d+)/g, (_m, target, dflt, from, len, simple) => {
    if (target) return (target === "@" || target === "ARGUMENTS" ? args.join(" ") : args[Number(target) - 1]) || dflt;
    if (from) return args.slice(Math.max(0, Number(from) - 1), len ? Math.max(0, Number(from) - 1) + Number(len) : undefined).join(" ");
    return simple === "@" || simple === "ARGUMENTS" ? args.join(" ") : (args[Number(simple) - 1] ?? "");
  });
}

function expandSlash(pi: ExtensionAPI, text: string): string {
  const m = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text);
  const named = m ? pi.getCommands().filter((c) => c.name === m[1]) : [];
  const command = named.find((c) => c.source !== "extension");
  if (!m || !command || named.some((c) => c.source === "extension")) return text;
  try {
    const { sourceInfo } = command;
    const body = frontmatter(readFileSync(sourceInfo.path, "utf8")).body;
    if (command.source === "prompt") return fillArgs(body, words(m[2] ?? ""));
    const args = (m[2] ?? "").trim();
    const block = `<skill name="${command.name.slice(6)}" location="${sourceInfo.path}">\nReferences are relative to ${sourceInfo.baseDir}.\n\n${body}\n</skill>`;
    return args ? `${block}\n\n${args}` : block;
  } catch {
    return text;
  }
}

const wakeupParams = Type.Object({
  delaySeconds: Type.Optional(Type.Number({ description: `Seconds until the wakeup (${MIN_DELAY_S}-${MAX_DELAY_S})` })),
  prompt: Type.Optional(Type.String({ description: "The prompt to run when the wakeup fires" })),
  reason: Type.Optional(Type.String({ description: "Why this delay, in one short sentence" })),
  noop: Type.Optional(Type.Boolean({ description: "Mark this wakeup as a routine check; it is scheduled all the same" })),
  stop: Type.Optional(Type.Boolean({ description: "Cancel the pending wakeup; no other field is needed" })),
});

// One pending wakeup, one fixed-interval loop, and one live self-paced loop per
// session. A fire delivers the prompt as a follow-up message, which runs at
// once when the agent is idle. It is a user message when the user wrote the
// prompt, and a custom message when the agent did.
export class Scheduler {
  private wakeup?: NodeJS.Timeout;
  private loop?: NodeJS.Timeout;
  // A self-paced loop has no timer of its own while its iteration runs, so
  // this is what /loop stop finds then.
  private selfPaced = false;
  // Set by a /loop command that ends or replaces the loop while a run is in
  // flight, until that run settles. A schedule_wakeup call names no loop, so
  // nothing tells that run's re-arm of the old loop from any other wakeup. It
  // is refused them all, or the loop the user just ended would come back.
  sealed = false;
  // A run is in flight: set by agent_start, cleared by agent_settled. Not
  // ctx.isIdle(), which is also false during a manual compaction.
  running = false;

  // Set by registerSchedule: runs a /loop command line on behalf of the agent. A wakeup that asks for
  // "/loop ..." used to reach the command through a user message; a custom message does not run commands.
  loopCommand?: (args: string, ctx: ExtensionContext) => Promise<void>;

  constructor(private readonly pi: ExtensionAPI) {}

  fire(prompt: string, fromAgent: boolean): void {
    if (fromAgent) {
      this.pi.sendMessage({ customType: AGENT_PROMPT_TYPE, content: expandSlash(this.pi, prompt), display: true }, { triggerTurn: true, deliverAs: "followUp" });
      return;
    }
    this.pi.sendUserMessage(prompt, { deliverAs: "followUp", expandPromptTemplates: true });
  }

  scheduleWakeup(seconds: number, prompt: string, ctx: ExtensionContext, fromAgent: boolean): void {
    this.cancelWakeup();
    const deliver = () => {
      // Pi rejects prompts during manual compaction. Keep the wakeup pending
      // until idle, including while a run or compaction is still finishing.
      if (!ctx.isIdle()) {
        this.wakeup = setTimeout(deliver, IDLE_RETRY_MS).unref();
        return;
      }
      this.wakeup = undefined;
      const loop = fromAgent ? LOOP_COMMAND.exec(prompt) : null;
      if (loop && this.loopCommand) {
        this.loopCommand(loop[1] ?? "", ctx).catch((e) => ctx.ui.notify(`/loop from a wakeup failed: ${e instanceof Error ? e.message : String(e)}`, "error"));
        return;
      }
      this.fire(prompt, fromAgent);
    };
    this.wakeup = setTimeout(deliver, seconds * 1000);
    this.wakeup.unref();
  }

  cancelWakeup(): boolean {
    const had = this.wakeup !== undefined;
    clearTimeout(this.wakeup);
    this.wakeup = undefined;
    return had;
  }

  startLoop(seconds: number, prompt: string, ctx: ExtensionContext, fromAgent: boolean): void {
    // A tick that lands mid-run is dropped, so a slow iteration cannot pile up a backlog.
    this.loop = setInterval(() => ctx.isIdle() && this.fire(prompt, fromAgent), seconds * 1000);
    this.loop.unref();
  }

  private stopLoop(): boolean {
    const had = this.loop !== undefined;
    clearInterval(this.loop);
    this.loop = undefined;
    return had;
  }

  startSelfPaced(): void {
    this.selfPaced = true;
  }

  // Ends the loop and the pending wakeup. midRun says a run is in flight,
  // which seals the wakeup slot against it.
  stopAll(midRun = false): boolean {
    const wakeup = this.cancelWakeup();
    const selfPaced = this.selfPaced;
    this.selfPaced = false;
    if (midRun) this.sealed = true;
    return this.stopLoop() || wakeup || selfPaced;
  }
}

function clampDelay(seconds: number): number {
  return Math.min(MAX_DELAY_S, Math.max(MIN_DELAY_S, Math.round(seconds)));
}

const UNIT_SECONDS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };

type LoopCommand =
  | { kind: "stop" }
  | { kind: "usage"; reason?: string }
  | { kind: "fixed"; seconds: number; prompt: string }
  | { kind: "dynamic"; prompt: string };

function parseLoop(args: string): LoopCommand {
  const text = args.trim();
  if (!text) return { kind: "usage" };
  if (text === "stop") return { kind: "stop" };
  const m = /^(\d+)([smhd])(?:\s+([\s\S]+))?$/.exec(text);
  if (m) {
    const seconds = Number(m[1]) * UNIT_SECONDS[m[2]];
    if (!m[3]) return { kind: "usage" };
    if (seconds > MAX_LOOP_S) return { kind: "usage", reason: "Intervals over 24 days are not supported." };
    return { kind: "fixed", seconds, prompt: m[3].trim() };
  }
  return { kind: "dynamic", prompt: text };
}

function dynamicPrompt(prompt: string): string {
  return (
    `${prompt}\n\n` +
    `[/loop, self-paced] When this iteration is done, call schedule_wakeup with prompt "/loop ${prompt}" ` +
    `and a delay that fits what you are waiting for (${MIN_DELAY_S} to ${MAX_DELAY_S} seconds) to run it again. ` +
    `Skip the call to end the loop.`
  );
}

// model-only exposure keeps the tool declared under codemode.mode "only".
export function registerSchedule(pi: ExtensionAPI, scheduler: Scheduler, oneShot: OneShot): void {
  pi.registerTool({
    name: "schedule_wakeup",
    label: "Schedule wakeup",
    exposure: "model-only",
    description: `Schedule this session to be re-invoked with a prompt after delaySeconds (clamped to ${MIN_DELAY_S}-${MAX_DELAY_S}), once the session is idle. One wakeup is pending at a time: a new call replaces it, and stop: true cancels it. Used by /loop's self-paced mode.`,
    parameters: wakeupParams,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (params.stop) {
        // What is pending in a sealed slot is a loop start the user asked for, not this run's.
        const had = !scheduler.sealed && scheduler.cancelWakeup();
        const text = had ? "Pending wakeup cancelled." : "No wakeup was pending.";
        return { content: [{ type: "text", text }], details: { cancelled: had } };
      }
      if (params.delaySeconds === undefined || !params.prompt) {
        throw new Error("schedule_wakeup needs delaySeconds and prompt unless stop is true.");
      }
      if (scheduler.sealed) {
        ctx.ui.notify("A wakeup this run asked for was not scheduled: /loop ended or replaced the loop while it ran.", "warning");
        return {
          content: [{ type: "text", text: "Not scheduled: the user ended or replaced the loop with a /loop command during this run. Do not schedule another wakeup in this run." }],
          details: { refused: true },
        };
      }
      if (oneShot.exits(ctx)) {
        throw new Error(`schedule_wakeup cannot fire in a ${ctx.mode} run: pi exits when this run ends. Finish the work in this run instead.`);
      }
      const seconds = clampDelay(params.delaySeconds);
      scheduler.scheduleWakeup(seconds, params.prompt, ctx, true);
      const fireAt = new Date(Date.now() + seconds * 1000).toISOString();
      const clamped = seconds !== params.delaySeconds ? ` (clamped from ${params.delaySeconds})` : "";
      return {
        content: [{ type: "text", text: `Wakeup scheduled in ${seconds}s${clamped}, at ${fireAt}. It replaces any earlier pending wakeup.` }],
        details: { delaySeconds: seconds, fireAt, noop: params.noop === true },
      };
    },
  });

  pi.on("agent_start", () => {
    scheduler.running = true;
  });
  pi.on("agent_settled", () => {
    scheduler.running = false;
    scheduler.sealed = false;
  });

  // fromAgent: the line came from a wakeup the agent scheduled, not from the user typing /loop.
  async function runLoop(args: string, ctx: ExtensionContext, fromAgent: boolean): Promise<void> {
    const cmd = parseLoop(args);
    // Also true during a manual compaction, which no run is behind: the first
    // prompt then waits for idle, but only a run in flight seals the slot.
    const midRun = !ctx.isIdle();
    // sendUserMessage only starts the run, and a one-shot run disposes the
    // session as soon as the command returns, so there the command waits it out.
    const fire = async (prompt: string) => {
      // The slot is sealed against the run in flight, so the loop's first
      // prompt takes the slot and runs once that run has settled. Its own
      // re-arm then comes from a later run and is not refused.
      if (midRun) {
        scheduler.scheduleWakeup(0, prompt, ctx, fromAgent);
        ctx.ui.notify("The loop starts once the session is idle.", "info");
        return;
      }
      if (!oneShot.exits(ctx)) {
        scheduler.fire(prompt, fromAgent);
        return;
      }
      await oneShot.assertStartsRun(prompt, ctx);
      const settled = oneShot.untilSettled();
      scheduler.fire(prompt, fromAgent);
      await settled;
    };
    switch (cmd.kind) {
      case "usage":
        ctx.ui.notify(`${cmd.reason ? `${cmd.reason} ` : ""}Usage: /loop [interval like 5m or 1h] <prompt>, or /loop stop`, "info");
        return;
      case "stop":
        ctx.ui.notify(scheduler.stopAll(scheduler.running) ? "Loop stopped." : "No loop was running.", "info");
        return;
      case "fixed": {
        const seconds = Math.max(MIN_DELAY_S, cmd.seconds);
        scheduler.stopAll(scheduler.running);
        scheduler.startLoop(seconds, cmd.prompt, ctx, fromAgent);
        ctx.ui.notify(`Looping every ${seconds}s. /loop stop ends it.`, "info");
        await fire(cmd.prompt);
        return;
      }
      case "dynamic":
        scheduler.stopAll(scheduler.running);
        scheduler.startSelfPaced();
        await fire(dynamicPrompt(cmd.prompt));
    }
  }
  scheduler.loopCommand = (args, ctx) => runLoop(args, ctx, true);

  pi.registerCommand("loop", {
    description: "Run a prompt on an interval (/loop 5m <prompt>), self-paced (/loop <prompt>), or stop (/loop stop)",
    handler: (args, ctx) => runLoop(args, ctx, false),
  });
}
