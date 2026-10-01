import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const OTHER = "Other (type an answer)";
export const DONE = "Done";
export const MIN_DELAY_S = 60;
export const MAX_DELAY_S = 3600;
// setInterval treats a delay above 2^31-1 ms as 1 ms.
export const MAX_LOOP_S = 24 * 86400;

interface Question {
  question: string;
  header?: string;
  options: { label: string; description?: string }[];
  multiSelect?: boolean;
}

type Ui = ExtensionContext["ui"];

// undefined means the user dismissed the dialog.
async function ask(ui: Ui, q: Question, signal: AbortSignal | undefined): Promise<string | undefined> {
  const title = q.header ? `${q.header}: ${q.question}` : q.question;
  const shown = (o: Question["options"][number]) => (o.description ? `${o.label} - ${o.description}` : o.label);
  const other = () => ui.input(title, "Your answer", { signal });
  if (!q.multiSelect) {
    const pick = await ui.select(title, [...q.options.map(shown), OTHER], { signal });
    if (pick === undefined) return undefined;
    return pick === OTHER ? other() : q.options.find((o) => shown(o) === pick)!.label;
  }
  const chosen: string[] = [];
  for (;;) {
    const remaining = q.options.filter((o) => !chosen.includes(o.label));
    const pick = await ui.select(`${title} (one at a time; ${DONE} when finished)`, [...remaining.map(shown), OTHER, DONE], {
      signal,
    });
    if (pick === undefined) return undefined;
    if (pick === DONE) return chosen.join(", ");
    if (pick === OTHER) {
      const text = await other();
      if (text === undefined) return undefined;
      chosen.push(text);
    } else chosen.push(remaining.find((o) => shown(o) === pick)!.label);
  }
}

const questionSchema = {
  type: "object",
  properties: {
    questions: {
      type: "array",
      minItems: 1,
      maxItems: 4,
      items: {
        type: "object",
        properties: {
          question: { type: "string", description: "The complete question to ask the user" },
          header: { type: "string", description: "Very short label for the question (max 12 chars)" },
          options: {
            type: "array",
            minItems: 2,
            maxItems: 4,
            items: {
              type: "object",
              properties: { label: { type: "string" }, description: { type: "string" } },
              required: ["label"],
            },
          },
          multiSelect: { type: "boolean", description: "Allow more than one answer" },
        },
        required: ["question", "options"],
      },
    },
  },
  required: ["questions"],
};

// One pending wakeup and one fixed-interval loop per session. A fire delivers
// the prompt as a follow-up user message, which runs at once when the agent is idle.
export class Scheduler {
  private wakeup?: NodeJS.Timeout;
  private loop?: NodeJS.Timeout;

  private settleWaiters: (() => void)[] = [];

  constructor(private readonly pi: ExtensionAPI) {}

  fire(prompt: string): void {
    this.pi.sendUserMessage(prompt, { deliverAs: "followUp", expandPromptTemplates: true });
  }

  // sendUserMessage only starts the run, and print mode disposes the session as
  // soon as the command that called it returns, so there the command waits it out.
  async fireFromCommand(prompt: string, ctx: ExtensionContext): Promise<void> {
    const settled = ctx.mode === "print" || ctx.mode === "json" ? new Promise<void>((r) => this.settleWaiters.push(r)) : undefined;
    this.fire(prompt);
    await settled;
  }

  settled(): void {
    for (const resolve of this.settleWaiters.splice(0)) resolve();
  }

  scheduleWakeup(seconds: number, prompt: string): void {
    this.cancelWakeup();
    this.wakeup = setTimeout(() => {
      this.wakeup = undefined;
      this.fire(prompt);
    }, seconds * 1000);
    this.wakeup.unref?.();
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
    this.loop.unref?.();
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

export function clampDelay(seconds: number): number {
  return Math.min(MAX_DELAY_S, Math.max(MIN_DELAY_S, Math.round(seconds)));
}

const UNIT_SECONDS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };

export type LoopCommand =
  | { kind: "stop" }
  | { kind: "usage"; reason?: string }
  | { kind: "fixed"; seconds: number; prompt: string }
  | { kind: "dynamic"; prompt: string };

export function parseLoop(args: string): LoopCommand {
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

export function dynamicPrompt(prompt: string): string {
  return (
    `${prompt}\n\n` +
    `[/loop, self-paced] When this iteration is done, call schedule_wakeup with prompt "/loop ${prompt}" ` +
    `and a delay that fits what you are waiting for (${MIN_DELAY_S} to ${MAX_DELAY_S} seconds) to run it again. ` +
    `Skip the call to end the loop.`
  );
}

export function registerInteraction(pi: ExtensionAPI, scheduler: Scheduler): void {
  pi.registerTool({
    name: "ask_user_question",
    label: "Ask user",
    description:
      "Ask the user 1-4 structured questions, each with 2-4 options; the user can also type their own answer. Use it for genuine preference calls the user must make.",
    parameters: questionSchema as any,
    executionMode: "sequential",
    async execute(_id, params: { questions: Question[] }, signal, _onUpdate, ctx) {
      if (!ctx.hasUI) {
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
    description: `Schedule this session to be re-invoked with a prompt after delaySeconds (clamped to ${MIN_DELAY_S}-${MAX_DELAY_S}). One wakeup is pending at a time: a new call replaces it, and stop: true cancels it. Used by /loop's self-paced mode.`,
    parameters: {
      type: "object",
      properties: {
        delaySeconds: { type: "number", description: `Seconds until the wakeup (${MIN_DELAY_S}-${MAX_DELAY_S})` },
        prompt: { type: "string", description: "The prompt to run when the wakeup fires" },
        reason: { type: "string", description: "Why this delay, in one short sentence" },
        noop: { type: "boolean", description: "Record the reason without changing any pending wakeup" },
        stop: { type: "boolean", description: "Cancel the pending wakeup" },
      },
      required: ["delaySeconds", "prompt", "reason"],
    } as any,
    async execute(
      _id,
      params: { delaySeconds: number; prompt: string; reason: string; noop?: boolean; stop?: boolean },
      _signal,
      _onUpdate,
      ctx,
    ) {
      if (params.stop) {
        const had = scheduler.cancelWakeup();
        const text = had ? "Pending wakeup cancelled." : "No wakeup was pending.";
        return { content: [{ type: "text", text }], details: { cancelled: had } };
      }
      if (ctx.mode === "print" || ctx.mode === "json") {
        throw new Error(
          `schedule_wakeup cannot fire in ${ctx.mode} mode: pi exits when this run ends. Finish the work in this run instead.`,
        );
      }
      if (params.noop) {
        return { content: [{ type: "text", text: "No change to the pending wakeup." }], details: { noop: true } };
      }
      const seconds = clampDelay(params.delaySeconds);
      scheduler.scheduleWakeup(seconds, params.prompt);
      const fireAt = new Date(Date.now() + seconds * 1000).toISOString();
      const clamped = seconds !== params.delaySeconds ? ` (clamped from ${params.delaySeconds})` : "";
      return {
        content: [{ type: "text", text: `Wakeup scheduled in ${seconds}s${clamped}, at ${fireAt}. It replaces any earlier pending wakeup.` }],
        details: { delaySeconds: seconds, fireAt },
      };
    },
  });

  pi.registerCommand("loop", {
    description: "Run a prompt on an interval (/loop 5m <prompt>), self-paced (/loop <prompt>), or stop (/loop stop)",
    async handler(args, ctx) {
      const cmd = parseLoop(args);
      switch (cmd.kind) {
        case "usage":
          ctx.ui.notify(`${cmd.reason ? `${cmd.reason} ` : ""}Usage: /loop [interval like 5m or 1h] <prompt>, or /loop stop`, "info");
          return;
        case "stop": {
          ctx.ui.notify(scheduler.stopAll() ? "Loop stopped." : "No loop was running.", "info");
          return;
        }
        case "fixed": {
          const seconds = Math.max(MIN_DELAY_S, cmd.seconds);
          scheduler.cancelWakeup();
          scheduler.startLoop(seconds, cmd.prompt, ctx);
          ctx.ui.notify(`Looping every ${seconds}s. /loop stop ends it.`, "info");
          await scheduler.fireFromCommand(cmd.prompt, ctx);
          return;
        }
        case "dynamic":
          scheduler.stopLoop();
          await scheduler.fireFromCommand(dynamicPrompt(cmd.prompt), ctx);
      }
    },
  });

  pi.on("agent_settled", () => scheduler.settled());
}
