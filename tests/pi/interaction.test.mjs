// ask_user_question, schedule_wakeup, and /loop through the fake ExtensionAPI.
import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";

import { DONE, OTHER } from "../../plugins/pstack/pi/ask.ts";
import { useWorld } from "./harness.mjs";

const setup = useWorld();

// A scripted UI: each select/input call takes the next answer.
function scriptedUi(answers) {
  const calls = [];
  const next = (kind, args) => {
    calls.push({ kind, ...args });
    return Promise.resolve(answers.shift());
  };
  return {
    calls,
    select: (title, options) => next("select", { title, options }),
    input: (title) => next("input", { title }),
    confirm: () => Promise.reject(new Error("confirm is not used")),
    notify: (message) => calls.push({ kind: "notify", message }),
  };
}

const q = (extra = {}) => ({
  question: "Which store?",
  header: "Store",
  options: [
    { label: "Postgres", description: "relational" },
    { label: "Redis", description: "in memory" },
  ],
  ...extra,
});

describe("ask_user_question", () => {
  test("without a UI it fails and tells the model to ask in plain text", async () => {
    const ui = scriptedUi([]);
    const { pi, ctx } = setup({ ctx: { hasUI: false, ui } });
    const err = await pi.call("ask_user_question", { questions: [q()] }, ctx).catch((e) => e);
    expect(err.message).toContain("Ask the user in plain text");
    expect(ui.calls).toEqual([]);
  });

  test("a single-select question returns the chosen label", async () => {
    const ui = scriptedUi(["Redis - in memory"]);
    const { pi, ctx } = setup({ ctx: { hasUI: true, ui } });
    const result = await pi.call("ask_user_question", { questions: [q()] }, ctx);
    expect(ui.calls).toEqual([
      { kind: "select", title: "Store: Which store?", options: ["Postgres - relational", "Redis - in memory", OTHER] },
    ]);
    expect(result.details.answers).toEqual([{ question: "Which store?", answer: "Redis" }]);
    expect(result.content[0].text).toContain('"Which store?"="Redis"');
  });

  test("Other takes free text", async () => {
    const ui = scriptedUi([OTHER, "SQLite"]);
    const { pi, ctx } = setup({ ctx: { hasUI: true, ui } });
    const result = await pi.call("ask_user_question", { questions: [q()] }, ctx);
    expect(result.details.answers[0].answer).toBe("SQLite");
  });

  test("multiSelect picks one at a time until Done, including typed answers", async () => {
    const ui = scriptedUi(["Postgres - relational", OTHER, "SQLite", DONE]);
    const { pi, ctx } = setup({ ctx: { hasUI: true, ui } });
    const result = await pi.call("ask_user_question", { questions: [q({ multiSelect: true })] }, ctx);
    expect(result.details.answers[0].answer).toBe("Postgres, SQLite");
    const selects = ui.calls.filter((c) => c.kind === "select");
    expect(selects[1].options).toEqual(["Redis - in memory", OTHER, DONE]);
  });

  test("several questions are asked in order, and a dismissal stops the run", async () => {
    const ui = scriptedUi(["Postgres - relational", undefined]);
    const { pi, ctx } = setup({ ctx: { hasUI: true, ui } });
    const result = await pi.call("ask_user_question", { questions: [q(), q({ question: "Cache?" })] }, ctx);
    expect(result.details).toEqual({ answers: [{ question: "Which store?", answer: "Postgres" }], dismissed: true });
    expect(result.content[0].text).toContain("dismissed");
  });

  test("a child agent refuses ask_user_question even though rpc mode reports a UI", async () => {
    const { pi, ctx } = setup({ settings: { depth: 1 }, ctx: { mode: "rpc", hasUI: true, ui: {} } });
    const err = await pi.call("ask_user_question", { questions: [q()] }, ctx).catch((e) => e);
    expect(err.message).toContain("Ask the user in plain text");
  });
});

describe("schedule_wakeup", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  const wake = (pi, ctx, params) => pi.call("schedule_wakeup", { reason: "waiting on CI", ...params }, ctx);

  test("clamps to 60 s and fires the prompt as a follow-up user message", async () => {
    const { pi, ctx } = setup({ ctx: { idle: true } });
    const result = await wake(pi, ctx, { delaySeconds: 5, prompt: "check CI" });
    expect(result.details.delaySeconds).toBe(60);
    jest.advanceTimersByTime(59_000);
    expect(pi.userMessages).toEqual([]);
    jest.advanceTimersByTime(1_000);
    expect(pi.userMessages).toEqual([{ content: "check CI", options: { deliverAs: "followUp", expandPromptTemplates: true } }]);
  });

  for (const mode of ["print", "json"]) {
    test(`in ${mode} mode it is an error, since pi exits before a wakeup could fire`, async () => {
      const { pi, ctx } = setup({ ctx: { mode } });
      const err = await wake(pi, ctx, { delaySeconds: 60, prompt: "later" }).catch((e) => e);
      expect(err.message).toContain("exits when this run ends");
      jest.advanceTimersByTime(3_600_000);
      expect(pi.userMessages).toEqual([]);
    });
  }

  test("clamps to 3600 s and queues as a follow-up when the agent is busy", async () => {
    const { pi, ctx } = setup({ ctx: { idle: false } });
    expect((await wake(pi, ctx, { delaySeconds: 99999, prompt: "later" })).details.delaySeconds).toBe(3600);
    jest.advanceTimersByTime(3_599_000);
    expect(pi.userMessages).toEqual([]);
    jest.advanceTimersByTime(1_000);
    expect(pi.userMessages).toEqual([{ content: "later", options: { deliverAs: "followUp", expandPromptTemplates: true } }]);
  });

  test("a new call replaces the pending wakeup", async () => {
    const { pi, ctx } = setup();
    await wake(pi, ctx, { delaySeconds: 600, prompt: "first" });
    await wake(pi, ctx, { delaySeconds: 120, prompt: "second" });
    jest.advanceTimersByTime(3_600_000);
    expect(pi.userMessages.map((m) => m.content)).toEqual(["second"]);
  });

  test("noop only labels the wakeup; it is scheduled and replaces the pending one, as on Claude Code", async () => {
    const { pi, ctx } = setup();
    await wake(pi, ctx, { delaySeconds: 120, prompt: "replaced" });
    const result = await wake(pi, ctx, { delaySeconds: 60, prompt: "routine check", noop: true });
    expect(result.details).toMatchObject({ delaySeconds: 60, noop: true });
    jest.advanceTimersByTime(60_000);
    expect(pi.userMessages.map((m) => m.content)).toEqual(["routine check"]);
    jest.advanceTimersByTime(3_600_000);
    expect(pi.userMessages.map((m) => m.content)).toEqual(["routine check"]);
  });

  test("stop: true cancels the pending wakeup and needs no other field", async () => {
    const { pi, ctx } = setup();
    expect(pi.tools.get("schedule_wakeup").parameters.required ?? []).toEqual([]);
    await wake(pi, ctx, { delaySeconds: 120, prompt: "cancelled" });
    expect((await pi.call("schedule_wakeup", { stop: true }, ctx)).details.cancelled).toBe(true);
    jest.advanceTimersByTime(3_600_000);
    expect(pi.userMessages).toEqual([]);
    expect((await pi.call("schedule_wakeup", { stop: true }, ctx)).details.cancelled).toBe(false);
  });

  test("without stop, delaySeconds and prompt are required", async () => {
    const { pi, ctx } = setup();
    const err = await pi.call("schedule_wakeup", { reason: "r" }, ctx).catch((e) => e);
    expect(err.message).toContain("needs delaySeconds and prompt");
    jest.advanceTimersByTime(3_600_000);
    expect(pi.userMessages).toEqual([]);
  });

  test("session_shutdown cancels the pending wakeup and the loop", async () => {
    const { pi, ctx } = setup();
    const ui = scriptedUi([]);
    await wake(pi, ctx, { delaySeconds: 120, prompt: "wake" });
    await pi.commands.get("loop").handler("1m tick", { ...ctx, ui });
    await pi.emit("session_shutdown", { reason: "quit" }, ctx);
    jest.advanceTimersByTime(3_600_000);
    expect(pi.userMessages.map((m) => m.content)).toEqual(["tick"]);
  });
});

describe("/loop", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  function loop(ctxOpts = {}) {
    const ui = scriptedUi([]);
    const { pi, ctx } = setup({ ctx: ctxOpts });
    return { pi, ctx, ui, run: (args) => pi.commands.get("loop").handler(args, { ...ctx, ui }) };
  }

  test("a fixed interval runs now and then on every interval until /loop stop", async () => {
    const { pi, run } = loop();
    await run("5m check the deploy");
    expect(pi.userMessages.map((m) => m.content)).toEqual(["check the deploy"]);
    jest.advanceTimersByTime(10 * 60_000);
    expect(pi.userMessages).toHaveLength(3);
    await run("stop");
    jest.advanceTimersByTime(60 * 60_000);
    expect(pi.userMessages).toHaveLength(3);
  });

  test("an interval under a minute is raised to one minute", async () => {
    const { pi, run, ui } = loop();
    await run("10s poll");
    jest.advanceTimersByTime(59_000);
    expect(pi.userMessages).toHaveLength(1);
    jest.advanceTimersByTime(1_000);
    expect(pi.userMessages).toHaveLength(2);
    expect(ui.calls.at(-1).message).toContain("60s");
  });

  test("an interval tick while the agent is busy is skipped, not queued", async () => {
    let idle = true;
    const { pi, run } = loop({ idle: () => idle });
    await run("1m tick");
    idle = false;
    jest.advanceTimersByTime(10 * 60_000);
    expect(pi.userMessages).toHaveLength(1);
    idle = true;
    jest.advanceTimersByTime(60_000);
    expect(pi.userMessages).toHaveLength(2);
  });

  test("an interval with no prompt or over 24 days is rejected and starts nothing", async () => {
    const { pi, run, ui } = loop();
    await run("5m");
    await run("25d x");
    jest.advanceTimersByTime(60 * 60_000);
    expect(pi.userMessages).toEqual([]);
    expect(ui.calls.map((c) => c.message)).toEqual([expect.stringContaining("Usage"), expect.stringContaining("24 days")]);
  });

  test("without an interval the prompt runs once and asks the model to pace itself", async () => {
    const { pi, run } = loop();
    await run("watch PR 42");
    expect(pi.userMessages).toHaveLength(1);
    const text = pi.userMessages[0].content;
    expect(text.startsWith("watch PR 42\n")).toBe(true);
    expect(text).toContain('schedule_wakeup with prompt "/loop watch PR 42"');
    jest.advanceTimersByTime(24 * 3_600_000);
    expect(pi.userMessages).toHaveLength(1);
  });

  test("a new self-paced loop cancels the previous loop's pending wakeup", async () => {
    const { pi, ctx, run } = loop();
    await pi.call("schedule_wakeup", { delaySeconds: 60, prompt: "/loop watch old PR" }, ctx);
    await run("watch new PR");
    jest.advanceTimersByTime(60_000);
    expect(pi.userMessages).toHaveLength(1);
    expect(pi.userMessages[0].content).toStartWith("watch new PR\n");

    await pi.call("schedule_wakeup", { delaySeconds: 120, prompt: "/loop watch new PR" }, ctx);
    jest.advanceTimersByTime(120_000);
    expect(pi.userMessages.map((m) => m.content)).toEqual([
      expect.stringContaining("watch new PR\n"),
      "/loop watch new PR",
    ]);
  });

  test("a new self-paced loop also stops the previous fixed interval", async () => {
    const { pi, run } = loop();
    await run("1m old task");
    await run("new task");
    jest.advanceTimersByTime(120_000);
    expect(pi.userMessages.map((m) => m.content)).toEqual(["old task", expect.stringContaining("new task\n")]);
  });

  test("a new fixed loop cancels the previous loop's pending wakeup and interval", async () => {
    const { pi, ctx, run } = loop();
    await pi.call("schedule_wakeup", { delaySeconds: 60, prompt: "/loop watch old PR" }, ctx);
    await run("1m old task");
    await run("2m new task");
    jest.advanceTimersByTime(120_000);
    expect(pi.userMessages.map((m) => m.content)).toEqual(["old task", "new task", "new task"]);
  });

  for (const mode of ["print", "json"]) {
    test(`in ${mode} mode /loop returns only once the run it started settles, since pi disposes the session when it returns`, async () => {
      const { pi, ctx, run } = loop({ mode });
      let returned = false;
      const done = run("tick").then(() => (returned = true));
      await Promise.resolve();
      expect(pi.userMessages).toHaveLength(1);
      jest.advanceTimersByTime(60_000);
      await Promise.resolve();
      expect(returned).toBe(false);
      await pi.emit("agent_settled", {}, ctx);
      await done;
      expect(returned).toBe(true);
    });
  }

  test("/loop stop also cancels a self-paced wakeup", async () => {
    const { pi, ctx, run } = loop();
    await pi.call("schedule_wakeup", { delaySeconds: 120, prompt: "/loop watch", reason: "r" }, ctx);
    await run("stop");
    jest.advanceTimersByTime(3_600_000);
    expect(pi.userMessages).toEqual([]);
  });
});
