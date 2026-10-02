import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";

import type { OneShot } from "./one-shot.ts";

export const OTHER = "Other (type an answer)";
export const DONE = "Done";
const MIN_DELAY_S = 60;
const MAX_DELAY_S = 3600;
// setInterval treats a delay above 2^31-1 ms as 1 ms.
const MAX_LOOP_S = 24 * 86400;

const question = Type.Object(
  {
    question: Type.String({ description: "The complete question to ask the user" }),
    header: Type.Optional(Type.String({ description: "Very short label for the question (max 12 chars)" })),
    options: Type.Array(Type.Object({ label: Type.String(), description: Type.Optional(Type.String()) }), { minItems: 2, maxItems: 4 }),
    multiSelect: Type.Optional(Type.Boolean({ description: "Allow more than one answer" })),
  },
);
type Question = Static<typeof question>;
const questionParams = Type.Object({ questions: Type.Array(question, { minItems: 1, maxItems: 4 }) });

const wakeupParams = Type.Object({
  delaySeconds: Type.Optional(Type.Number({ description: `Seconds until the wakeup (${MIN_DELAY_S}-${MAX_DELAY_S})` })),
  prompt: Type.Optional(Type.String({ description: "The prompt to run when the wakeup fires" })),
  reason: Type.Optional(Type.String({ description: "Why this delay, in one short sentence" })),
  noop: Type.Optional(Type.Boolean({ description: "Mark this wakeup as a routine check; it is scheduled all the same" })),
  stop: Type.Optional(Type.Boolean({ description: "Cancel the pending wakeup; no other field is needed" })),
});

type Ui = ExtensionContext["ui"];

// undefined means the user dismissed the dialog.
async function ask(ui: Ui, q: Question, signal: AbortSignal | undefined): Promise<string | undefined> {
  const title = q.header ? `${q.header}: ${q.question}` : q.question;
  const shown = (o: Question["options"][number]) => (o.description ? `${o.label} - ${o.description}` : o.label);
  const labels = new Map(q.options.map((o) => [shown(o), o.label]));
  // The label of a listed pick, or what the user types for OTHER.
  const answer = (pick: string) => (pick === OTHER ? ui.input(title, "Your answer", { signal }) : labels.get(pick));
  if (!q.multiSelect) {
    const pick = await ui.select(title, [...labels.keys(), OTHER], { signal });
    return pick === undefined ? undefined : answer(pick);
  }
  const chosen: string[] = [];
  for (;;) {
    const remaining = [...labels].filter(([, label]) => !chosen.includes(label)).map(([text]) => text);
    const pick = await ui.select(`${title} (one at a time; ${DONE} when finished)`, [...remaining, OTHER, DONE], { signal });
    if (pick === undefined) return undefined;
    if (pick === DONE) return chosen.join(", ");
    const text = await answer(pick);
    if (text === undefined) return undefined;
    chosen.push(text);
  }
}

// One pending wakeup and one fixed-interval loop per session. A fire delivers
// the prompt as a follow-up user message, which runs at once when the agent is idle.
export class Scheduler {
  private wakeup?: NodeJS.Timeout;
  private loop?: NodeJS.Timeout;

  constructor(private readonly pi: ExtensionAPI) {}

  fire(prompt: string): void {
    this.pi.sendUserMessage(prompt, { deliverAs: "followUp", expandPromptTemplates: true });
  }

  scheduleWakeup(seconds: number, prompt: string): void {
    this.cancelWakeup();
    this.wakeup = setTimeout(() => {
      this.wakeup = undefined;
      this.fire(prompt);
    }, seconds * 1000);
    this.wakeup.unref();
  }

  cancelWakeup(): boolean {
    const had = this.wakeup !== undefined;
    clearTimeout(this.wakeup);
    this.wakeup = undefined;
    return had;
  }

  startLoop(seconds: number, prompt: string, ctx: ExtensionContext): void {
    this.stopLoop();
    // A tick that lands mid-run is dropped, so a slow iteration cannot pile up a backlog.
    this.loop = setInterval(() => ctx.isIdle() && this.fire(prompt), seconds * 1000);
    this.loop.unref();
  }

  stopLoop(): boolean {
    const had = this.loop !== undefined;
    clearInterval(this.loop);
    this.loop = undefined;
    return had;
  }

  stopAll(): boolean {
    const wakeup = this.cancelWakeup();
    return this.stopLoop() || wakeup;
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

// model-only exposure keeps these tools declared under codemode.mode "only".
export function registerInteraction(pi: ExtensionAPI, scheduler: Scheduler, oneShot: OneShot): void {
  pi.registerTool({
    name: "ask_user_question",
    label: "Ask user",
    exposure: "model-only",
    description:
      "Ask the user 1-4 structured questions, each with 2-4 options; the user can also type their own answer. Use it for genuine preference calls the user must make.",
    parameters: questionParams,
    executionMode: "sequential",
    async execute(_id, params, signal, _onUpdate, ctx) {
      // An rpc child reports a UI, but its parent cancels every dialog, so asking
      // could only report a dismissal.
      if (!ctx.hasUI || oneShot.exits(ctx)) {
        throw new Error(
          "ask_user_question needs an interactive UI, and this session has none. Ask the user in plain text instead and wait for the reply.",
        );
      }
      const answers: { question: string; answer: string }[] = [];
      for (const q of params.questions) {
        const answer = await ask(ctx.ui, q, signal);
        if (answer === undefined) {
          return {
            content: [{ type: "text", text: "The user dismissed the question without answering." }],
            details: { answers, dismissed: true },
          };
        }
        answers.push({ question: q.question, answer });
      }
      const text = answers.map((a) => `"${a.question}"="${a.answer}"`).join(", ");
      return {
        content: [{ type: "text", text: `User has answered your questions: ${text}. You can now continue with the user's answers in mind.` }],
        details: { answers, dismissed: false },
      };
    },
  });

  pi.registerTool({
    name: "schedule_wakeup",
    label: "Schedule wakeup",
    exposure: "model-only",
    description: `Schedule this session to be re-invoked with a prompt after delaySeconds (clamped to ${MIN_DELAY_S}-${MAX_DELAY_S}). One wakeup is pending at a time: a new call replaces it, and stop: true cancels it. Used by /loop's self-paced mode.`,
    parameters: wakeupParams,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (params.stop) {
        const had = scheduler.cancelWakeup();
        const text = had ? "Pending wakeup cancelled." : "No wakeup was pending.";
        return { content: [{ type: "text", text }], details: { cancelled: had } };
      }
      if (params.delaySeconds === undefined || !params.prompt) {
        throw new Error("schedule_wakeup needs delaySeconds and prompt unless stop is true.");
      }
      if (oneShot.exits(ctx)) {
        throw new Error(`schedule_wakeup cannot fire in a ${ctx.mode} run: pi exits when this run ends. Finish the work in this run instead.`);
      }
      const seconds = clampDelay(params.delaySeconds);
      scheduler.scheduleWakeup(seconds, params.prompt);
      const fireAt = new Date(Date.now() + seconds * 1000).toISOString();
      const clamped = seconds !== params.delaySeconds ? ` (clamped from ${params.delaySeconds})` : "";
      return {
        content: [{ type: "text", text: `Wakeup scheduled in ${seconds}s${clamped}, at ${fireAt}. It replaces any earlier pending wakeup.` }],
        details: { delaySeconds: seconds, fireAt, noop: params.noop === true },
      };
    },
  });

  pi.registerCommand("loop", {
    description: "Run a prompt on an interval (/loop 5m <prompt>), self-paced (/loop <prompt>), or stop (/loop stop)",
    async handler(args, ctx) {
      const cmd = parseLoop(args);
      // sendUserMessage only starts the run, and a one-shot run disposes the
      // session as soon as the command returns, so there the command waits it out.
      const fire = async (prompt: string) => {
        const settled = oneShot.exits(ctx) ? oneShot.untilSettled() : undefined;
        scheduler.fire(prompt);
        await settled;
      };
      switch (cmd.kind) {
        case "usage":
          ctx.ui.notify(`${cmd.reason ? `${cmd.reason} ` : ""}Usage: /loop [interval like 5m or 1h] <prompt>, or /loop stop`, "info");
          return;
        case "stop":
          ctx.ui.notify(scheduler.stopAll() ? "Loop stopped." : "No loop was running.", "info");
          return;
        case "fixed": {
          const seconds = Math.max(MIN_DELAY_S, cmd.seconds);
          scheduler.cancelWakeup();
          scheduler.startLoop(seconds, cmd.prompt, ctx);
          ctx.ui.notify(`Looping every ${seconds}s. /loop stop ends it.`, "info");
          await fire(cmd.prompt);
          return;
        }
        case "dynamic":
          scheduler.stopLoop();
          await fire(dynamicPrompt(cmd.prompt));
      }
    },
  });
}
