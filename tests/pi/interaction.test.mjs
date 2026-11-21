// ask_user_question, schedule_wakeup, and /loop through the fake ExtensionAPI.
import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { DONE, OTHER } from "../../plugins/pstack/pi/ask.ts";
import { resultText, useWorld } from "./harness.mjs";

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
  test("a choice named Done is selectable independently of the completion control", async () => {
    let step = 0;
    const ui = { select: async (_title, options) => options[step++ === 0 ? 0 : options.length - 1] };
    const { pi, ctx } = setup({ ctx: { hasUI: true, ui } });
    const result = await pi.call("ask_user_question", {
      questions: [q({ multiSelect: true, options: [{ label: "Done" }, { label: "In progress" }] })],
    }, ctx);
    expect(result.details).toEqual({ answers: [{ question: "Which store?", answer: "Done" }], dismissed: false });
  });

  test("a choice named Other stays a choice and equal rendered labels stay distinct", async () => {
    const ui = { select: async (_title, options) => options[0] };
    const { pi, ctx } = setup({ ctx: { hasUI: true, ui } });
    const result = await pi.call("ask_user_question", {
      questions: [
        q({ options: [{ label: OTHER }, { label: "Listed" }] }),
        q({ options: [{ label: "A", description: "B" }, { label: "A - B" }] }),
      ],
    }, ctx);
    expect(result.details.answers.map((a) => a.answer)).toEqual([OTHER, "A"]);
  });

  test("multiSelect keeps a choice selectable after its same-label twin is picked", async () => {
    const ui = scriptedUi(["1. Same - first", "2. Same - second", DONE]);
    const { pi, ctx } = setup({ ctx: { hasUI: true, ui } });
    const result = await pi.call("ask_user_question", {
      questions: [q({ multiSelect: true, options: [{ label: "Same", description: "first" }, { label: "Same", description: "second" }] })],
    }, ctx);
    const selects = ui.calls.filter((c) => c.kind === "select");
    expect(selects[1].options).toEqual(["2. Same - second", OTHER, DONE]);
    expect(result.details.answers).toEqual([{ question: "Which store?", answer: "Same, Same" }]);
  });

  test("without a UI it fails and tells the model to ask in plain text", async () => {
    const ui = scriptedUi([]);
    const { pi, ctx } = setup({ ctx: { hasUI: false, ui } });
    const err = await pi.call("ask_user_question", { questions: [q()] }, ctx).catch((e) => e);
    expect(err.message).toContain("Ask the user in plain text");
    expect(ui.calls).toEqual([]);
  });

  test("a single-select question returns the chosen label", async () => {
    const ui = scriptedUi(["2. Redis - in memory"]);
    const { pi, ctx } = setup({ ctx: { hasUI: true, ui } });
    const result = await pi.call("ask_user_question", { questions: [q()] }, ctx);
    expect(ui.calls).toEqual([
      { kind: "select", title: "Store: Which store?", options: ["1. Postgres - relational", "2. Redis - in memory", OTHER] },
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
    const ui = scriptedUi(["1. Postgres - relational", OTHER, "SQLite", DONE]);
    const { pi, ctx } = setup({ ctx: { hasUI: true, ui } });
    const result = await pi.call("ask_user_question", { questions: [q({ multiSelect: true })] }, ctx);
    expect(result.details.answers[0].answer).toBe("Postgres, SQLite");
    const selects = ui.calls.filter((c) => c.kind === "select");
    expect(selects[1].options).toEqual(["2. Redis - in memory", OTHER, DONE]);
  });

  test("a later dismissal preserves completed answers in model-facing content and stops the run", async () => {
    const ui = scriptedUi(["1. Postgres - relational", undefined]);
    const { pi, ctx } = setup({ ctx: { hasUI: true, ui } });
    const result = await pi.call("ask_user_question", { questions: [q(), q({ question: "Cache?" }), q({ question: "Queue?" })] }, ctx);
    expect(result.details).toEqual({ answers: [{ question: "Which store?", answer: "Postgres" }], dismissed: true });
    expect(result.content[0].text).toContain('"Which store?"="Postgres"');
    expect(result.content[0].text).toContain("The user dismissed the remaining questions without answering.");
    expect(result.content[0].text).not.toContain('"Cache?"=');
    expect(result.content[0].text).not.toContain('"Queue?"=');
    expect(ui.calls.map((c) => c.title)).toEqual(["Store: Which store?", "Store: Cache?"]);
  });

  test("dismissing the first question still returns only a dismissal", async () => {
    const ui = scriptedUi([undefined]);
    const { pi, ctx } = setup({ ctx: { hasUI: true, ui } });
    const result = await pi.call("ask_user_question", { questions: [q(), q({ question: "Cache?" })] }, ctx);
    expect(result.details).toEqual({ answers: [], dismissed: true });
    expect(result.content).toEqual([{ type: "text", text: "The user dismissed the question without answering." }]);
    expect(ui.calls).toHaveLength(1);
  });

  test("dismissing Other input preserves earlier typed and completed multi-select answers", async () => {
    const ui = scriptedUi([OTHER, "SQLite", "1. Postgres - relational", "2. Redis - in memory", DONE, OTHER, undefined]);
    const { pi, ctx } = setup({ ctx: { hasUI: true, ui } });
    const result = await pi.call("ask_user_question", {
      questions: [q(), q({ question: "Caches?", multiSelect: true }), q({ question: "Queue?" })],
    }, ctx);
    expect(result.details).toEqual({
      answers: [{ question: "Which store?", answer: "SQLite" }, { question: "Caches?", answer: "Postgres, Redis" }],
      dismissed: true,
    });
    expect(result.content[0].text).toContain('"Which store?"="SQLite", "Caches?"="Postgres, Redis"');
    expect(result.content[0].text).toContain("dismissed");
    expect(result.content[0].text).not.toContain('"Queue?"=');
  });

  test("completing all questions retains the success message and answer order", async () => {
    const ui = scriptedUi(["1. Postgres - relational", "2. Redis - in memory"]);
    const { pi, ctx } = setup({ ctx: { hasUI: true, ui } });
    const result = await pi.call("ask_user_question", { questions: [q(), q({ question: "Cache?" })] }, ctx);
    expect(result.details).toEqual({
      answers: [{ question: "Which store?", answer: "Postgres" }, { question: "Cache?", answer: "Redis" }],
      dismissed: false,
    });
    expect(result.content).toEqual([{
      type: "text",
      text: 'User has answered your questions: "Which store?"="Postgres", "Cache?"="Redis". You can now continue with the user\'s answers in mind.',
    }]);
  });

  test("pi ask tool: off in the sheet installs without the tool, so another extension can own the name", () => {
    const { pi } = setup({ sheet: "bug-fix: opus\npi ask tool: off\n" });
    expect(pi.tools.has("ask_user_question")).toBe(false);
    expect(pi.tools.has("schedule_wakeup")).toBe(true);
  });

  test("a child agent refuses ask_user_question even though rpc mode reports a UI", async () => {
    const { pi, ctx } = setup({ settings: { depth: 1 }, ctx: { mode: "rpc", hasUI: true, ui: {} } });
    const err = await pi.call("ask_user_question", { questions: [q()] }, ctx).catch((e) => e);
    expect(err.message).toContain("Ask the user in plain text");
  });
});

// What the agent's own wakeups sent: custom messages, never user messages.
const woken = (pi) => pi.messages.map((m) => m.message.content);

describe("schedule_wakeup", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  const wake = (pi, ctx, params) => pi.call("schedule_wakeup", { reason: "waiting on CI", ...params }, ctx);

  test("a due wakeup waits through compaction and runs exactly once after idle", async () => {
    let idle = false;
    const { pi, ctx } = setup({ ctx: { idle: () => idle } });
    await wake(pi, ctx, { delaySeconds: 60, prompt: "resume after compaction" });
    jest.advanceTimersByTime(65_000);
    expect(pi.messages).toEqual([]);
    idle = true;
    jest.advanceTimersByTime(1_000);
    expect(woken(pi)).toEqual(["resume after compaction"]);
    jest.advanceTimersByTime(60_000);
    expect(pi.messages).toHaveLength(1);
  });

  test.each(["cancel", "replace", "shutdown"])("a wakeup waiting for idle can %s", async (action) => {
    let idle = false;
    const { pi, ctx } = setup({ ctx: { idle: () => idle } });
    await wake(pi, ctx, { delaySeconds: 60, prompt: "old" });
    jest.advanceTimersByTime(60_000);
    if (action === "cancel") expect((await wake(pi, ctx, { stop: true })).details.cancelled).toBe(true);
    if (action === "replace") await wake(pi, ctx, { delaySeconds: 60, prompt: "new" });
    if (action === "shutdown") await pi.emit("session_shutdown", { reason: "quit" }, ctx);
    idle = true;
    jest.advanceTimersByTime(120_000);
    expect(woken(pi)).toEqual(action === "replace" ? ["new"] : []);
  });

  test("clamps to 60 s and fires the prompt as a follow-up custom message that starts a turn", async () => {
    const { pi, ctx } = setup({ ctx: { idle: true } });
    const result = await wake(pi, ctx, { delaySeconds: 5, prompt: "check CI" });
    expect(result.details.delaySeconds).toBe(60);
    jest.advanceTimersByTime(59_000);
    expect(pi.messages).toEqual([]);
    jest.advanceTimersByTime(1_000);
    expect(pi.messages).toEqual([
      { message: { customType: "pstack-wakeup", content: "check CI", display: true }, options: { triggerTurn: true, deliverAs: "followUp" } },
    ]);
  });

  // The permission classifier counts user-role messages as what the user asked for. Text the agent chose
  // for itself must not land as one, in any form a wakeup takes.
  test("nothing the agent schedules lands as a user message", async () => {
    const { pi, ctx } = setup({ ctx: { idle: true } });
    const ui = scriptedUi([]);
    for (const prompt of ["check CI", "/skill:babysit 42", "/loop watch PR 42", "/loop 1m tick"]) {
      await wake(pi, { ...ctx, ui }, { delaySeconds: 60, prompt });
      jest.advanceTimersByTime(60_000);
    }
    jest.advanceTimersByTime(3 * 60_000);
    expect(pi.userMessages).toEqual([]);
    // The fixed loop sends "tick" when its wakeup fires, then once a minute for three minutes.
    expect(woken(pi)).toEqual([
      "check CI",
      "/skill:babysit 42",
      expect.stringContaining("watch PR 42\n\n[/loop, self-paced] "),
      "tick",
      "tick",
      "tick",
      "tick",
    ]);
  });

  // Pi expands a skill or template only inside a user message, so the wakeup does it and sends the result as its own.
  test("an agent-scheduled skill or prompt template arrives expanded, as one custom message and no user message", async () => {
    const { pi, ctx, w } = setup({ ctx: { idle: true } });
    const dir = mkdtempSync(join(w.cwd, "slash-"));
    writeFileSync(join(dir, "SKILL.md"), "---\nname: babysit\ndescription: watch a PR\n---\nSKILL-BODY-MARKER watch the PR\n");
    writeFileSync(join(dir, "tpl.md"), "---\ndescription: t\n---\nTEMPLATE-MARKER first=$1 rest=${@:2} all=$ARGUMENTS\n");
    writeFileSync(join(dir, "other.md"), "OTHER-BODY-MARKER");
    pi.slashCommands.push(
      { name: "skill:babysit", source: "skill", sourceInfo: { path: join(dir, "SKILL.md"), baseDir: dir } },
      { name: "review", source: "prompt", sourceInfo: { path: join(dir, "tpl.md") } },
      { name: "loop", source: "prompt", sourceInfo: { path: join(dir, "other.md") } },
      { name: "skill:gone", source: "skill", sourceInfo: { path: join(dir, "missing.md"), baseDir: dir } },
    );
    pi.commands.set("clash", {});
    pi.slashCommands.push({ name: "clash", source: "prompt", sourceInfo: { path: join(dir, "other.md") } });
    const ui = scriptedUi([]);
    for (const prompt of ["/skill:babysit PR 42", "/review a 'b c' d", '/review --title="fix bug" 42', "/clash x", "/skill:gone", "/skill:unknown y", "/nothing"]) {
      await wake(pi, { ...ctx, ui }, { delaySeconds: 60, prompt });
      jest.advanceTimersByTime(60_000);
    }
    expect(pi.userMessages).toEqual([]);
    expect(pi.messages.every((m) => m.message.customType === "pstack-wakeup" && m.options.triggerTurn)).toBe(true);
    const [skill, template, quoted, ...plain] = woken(pi);
    expect(skill).toBe(`<skill name="babysit" location="${join(dir, "SKILL.md")}">\nReferences are relative to ${dir}.\n\nSKILL-BODY-MARKER watch the PR\n</skill>\n\nPR 42`);
    expect(template).toBe("TEMPLATE-MARKER first=a rest=b c d all=a b c d");
    // As pi's parser: a quote inside a word is text, so the space after it still splits.
    expect(quoted).toBe('TEMPLATE-MARKER first=--title="fix rest=bug" 42 all=--title="fix bug" 42');
    // An extension command is never run for the agent, and an unknown or unreadable one is left as typed.
    expect(plain).toEqual(["/clash x", "/skill:gone", "/skill:unknown y", "/nothing"]);
    expect(ui.calls.filter((c) => c.kind === "notify").map((c) => c.message)).toEqual([
      expect.stringMatching(/^A wakeup's command could not be expanded and was sent as written: ENOENT.*missing\.md/),
    ]);
  });

  test("a loop the agent re-arms with a skill sends it expanded on every tick", async () => {
    const { pi, ctx, w } = setup({ ctx: { idle: true } });
    writeFileSync(join(w.cwd, "SKILL.md"), "SKILL-BODY-MARKER");
    pi.slashCommands.push({ name: "skill:babysit", source: "skill", sourceInfo: { path: join(w.cwd, "SKILL.md"), baseDir: w.cwd } });
    await wake(pi, { ...ctx, ui: scriptedUi([]) }, { delaySeconds: 60, prompt: "/loop 1m /skill:babysit" });
    jest.advanceTimersByTime(3 * 60_000);
    expect(pi.userMessages).toEqual([]);
    expect(woken(pi)).toHaveLength(3);
    expect(woken(pi).every((c) => c.includes("SKILL-BODY-MARKER") && !c.startsWith("/skill:"))).toBe(true);
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

  test("clamps to 3600 s and retains the wakeup while the agent is busy", async () => {
    let idle = false;
    const { pi, ctx } = setup({ ctx: { idle: () => idle } });
    expect((await wake(pi, ctx, { delaySeconds: 99999, prompt: "later" })).details.delaySeconds).toBe(3600);
    jest.advanceTimersByTime(3_599_000);
    expect(pi.messages).toEqual([]);
    jest.advanceTimersByTime(1_000);
    expect(pi.messages).toEqual([]);
    idle = true;
    jest.advanceTimersByTime(1_000);
    expect(woken(pi)).toEqual(["later"]);
  });

  test("a new call replaces the pending wakeup", async () => {
    const { pi, ctx } = setup();
    await wake(pi, ctx, { delaySeconds: 600, prompt: "first" });
    await wake(pi, ctx, { delaySeconds: 120, prompt: "second" });
    jest.advanceTimersByTime(3_600_000);
    expect(woken(pi)).toEqual(["second"]);
  });

  test("noop only labels the wakeup; it is scheduled and replaces the pending one, as on Claude Code", async () => {
    const { pi, ctx } = setup();
    await wake(pi, ctx, { delaySeconds: 120, prompt: "replaced" });
    const result = await wake(pi, ctx, { delaySeconds: 60, prompt: "routine check", noop: true });
    expect(result.details).toMatchObject({ delaySeconds: 60, noop: true });
    jest.advanceTimersByTime(60_000);
    expect(woken(pi)).toEqual(["routine check"]);
    jest.advanceTimersByTime(3_600_000);
    expect(woken(pi)).toEqual(["routine check"]);
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
    await run("watch old PR");
    await pi.call("schedule_wakeup", { delaySeconds: 60, prompt: "/loop watch old PR" }, ctx);
    await run("watch new PR");
    jest.advanceTimersByTime(60_000);
    expect(pi.userMessages.map((m) => m.content)).toEqual([expect.stringContaining("watch old PR\n"), expect.stringContaining("watch new PR\n")]);
    expect(pi.messages).toEqual([]);

    // The agent's re-arm runs the /loop command for it, and what that sends is the agent's, not the user's.
    await pi.call("schedule_wakeup", { delaySeconds: 120, prompt: "/loop watch new PR" }, ctx);
    jest.advanceTimersByTime(120_000);
    expect(pi.userMessages).toHaveLength(2);
    expect(woken(pi)).toEqual([expect.stringContaining("watch new PR\n")]);
  });

  for (const rearm of ["/loop watch PR 42", "watch PR 42", "/loop 5m watch PR 42"]) {
    test(`/loop stop during a self-paced iteration ends the loop: a wakeup that run then asks for with prompt "${rearm}" is refused, and the user is told`, async () => {
      let idle = true;
      const { pi, ctx, run, ui } = loop({ idle: () => idle });
      await run("watch PR 42");
      idle = false;
      await pi.emit("agent_start", {}, ctx);
      await run("stop");
      expect(ui.calls.at(-1).message).toBe("Loop stopped.");
      const refused = await pi.call("schedule_wakeup", { delaySeconds: 60, prompt: rearm }, { ...ctx, ui });
      expect(resultText(refused)).toContain("Not scheduled");
      expect(refused.details).toEqual({ refused: true });
      expect(ui.calls.at(-1).message).toContain("was not scheduled");
      idle = true;
      jest.advanceTimersByTime(3_600_000);
      expect(pi.userMessages).toHaveLength(1);
    });
  }

  test("/loop stop during a run cuts that run off even with no loop live, and a run after it settles schedules a wakeup again", async () => {
    let idle = false;
    const { pi, ctx, run, ui } = loop({ idle: () => idle });
    const wake = () => pi.call("schedule_wakeup", { delaySeconds: 60, prompt: "later" }, { ...ctx, ui });
    await pi.emit("agent_start", {}, ctx);
    await run("stop");
    expect(ui.calls.at(-1).message).toBe("No loop was running.");
    expect((await wake()).details).toEqual({ refused: true });
    await pi.emit("agent_settled", {}, ctx);
    idle = true;
    expect(resultText(await wake())).toContain("Wakeup scheduled");
    jest.advanceTimersByTime(60_000);
    expect(woken(pi)).toEqual(["later"]);
    expect(pi.userMessages).toEqual([]);
  });

  test("a new self-paced loop asked for during an old iteration starts once that run settles: the old run can neither re-arm nor cancel it, and the new loop re-arms itself", async () => {
    let idle = true;
    const { pi, ctx, run, ui } = loop({ idle: () => idle });
    const wake = (params) => pi.call("schedule_wakeup", params, { ...ctx, ui });
    await run("watch old");
    idle = false;
    await pi.emit("agent_start", {}, ctx);
    await run("watch new");
    expect(ui.calls.at(-1).message).toBe("The loop starts once the session is idle.");
    expect((await wake({ delaySeconds: 60, prompt: "/loop watch old" })).details).toEqual({ refused: true });
    expect((await wake({ stop: true })).details).toEqual({ cancelled: false });
    jest.advanceTimersByTime(60_000);
    expect(pi.userMessages).toHaveLength(1);

    await pi.emit("agent_settled", {}, ctx);
    idle = true;
    jest.advanceTimersByTime(1_000);
    expect(pi.userMessages).toHaveLength(2);
    expect(resultText(await wake({ delaySeconds: 120, prompt: "/loop watch new" }))).toContain("Wakeup scheduled");
    jest.advanceTimersByTime(120_000);
    expect(pi.userMessages.map((m) => m.content)).toEqual([expect.stringContaining("watch old\n"), expect.stringContaining("watch new\n")]);
    expect(woken(pi)).toEqual([expect.stringContaining("watch new\n")]);
  });

  test("a fixed loop asked for during a run sends its first prompt once that run settles", async () => {
    let idle = false;
    const { pi, ctx, run } = loop({ idle: () => idle });
    await pi.emit("agent_start", {}, ctx);
    await run("5m check the deploy");
    jest.advanceTimersByTime(30_000);
    expect(pi.userMessages).toEqual([]);
    await pi.emit("agent_settled", {}, ctx);
    idle = true;
    jest.advanceTimersByTime(1_000);
    expect(pi.userMessages.map((m) => m.content)).toEqual(["check the deploy"]);
  });

  // During a manual compaction isIdle() is false with no run in flight, and
  // no agent_settled follows when it ends.
  test("a self-paced loop started during a manual compaction waits for idle, then re-arms after its first iteration", async () => {
    let idle = false;
    const { pi, ctx, run, ui } = loop({ idle: () => idle });
    await run("watch the deploy");
    expect(ui.calls.at(-1).message).toBe("The loop starts once the session is idle.");
    idle = true;
    jest.advanceTimersByTime(1_000);
    expect(pi.userMessages).toHaveLength(1);
    idle = false;
    await pi.emit("agent_start", {}, ctx);
    const rearm = await pi.call("schedule_wakeup", { delaySeconds: 60, prompt: "/loop watch the deploy" }, { ...ctx, ui });
    expect(resultText(rearm)).toContain("Wakeup scheduled");
  });

  test("/loop stop during a manual compaction does not refuse the next run's wakeup", async () => {
    let idle = false;
    const { pi, ctx, run, ui } = loop({ idle: () => idle });
    await run("stop");
    await pi.emit("agent_start", {}, ctx);
    const wake = await pi.call("schedule_wakeup", { delaySeconds: 60, prompt: "later" }, { ...ctx, ui });
    expect(resultText(wake)).toContain("Wakeup scheduled");
  });

  for (const [what, started, prompt, sent] of [
    ["a live loop's re-arm in other words than its prompt", "watch  PR 42", "/loop Watch PR 42.", "Watch PR 42."],
    ["a /loop prompt with no loop started", null, "/loop babysit PR 42", "babysit PR 42"],
  ]) {
    test(`with no /loop command during the run, a wakeup is scheduled whatever its prompt says: ${what}`, async () => {
      const { pi, ctx, run } = loop();
      if (started) await run(started);
      expect(resultText(await pi.call("schedule_wakeup", { delaySeconds: 60, prompt }, ctx))).toContain("Wakeup scheduled");
      jest.advanceTimersByTime(60_000);
      // The wakeup's /loop line runs the command for the agent; its prompt goes out as the agent's.
      expect(woken(pi)).toEqual([expect.stringContaining(`${sent}\n\n[/loop, self-paced] `)]);
      expect(pi.userMessages.map((m) => m.content)).toEqual(started ? [expect.stringContaining(`${started}\n\n[/loop, self-paced] `)] : []);
    });
  }

  test("a new self-paced loop also stops the previous fixed interval", async () => {
    const { pi, run } = loop();
    await run("1m old task");
    await run("new task");
    jest.advanceTimersByTime(120_000);
    expect(pi.userMessages.map((m) => m.content)).toEqual(["old task", expect.stringContaining("new task\n")]);
  });

  test("a new fixed loop cancels the previous loop's pending wakeup and interval", async () => {
    const { pi, ctx, run } = loop();
    await run("watch old PR");
    await pi.call("schedule_wakeup", { delaySeconds: 60, prompt: "/loop watch old PR" }, ctx);
    await run("1m old task");
    await run("2m new task");
    jest.advanceTimersByTime(120_000);
    expect(pi.userMessages.map((m) => m.content)).toEqual([expect.stringContaining("watch old PR\n"), "old task", "new task", "new task"]);
  });

  // Lets a handler reach its first fire or its failure; fake timers rule out sleeping.
  const drain = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };

  for (const mode of ["print", "json"]) {
    test(`in ${mode} mode /loop returns only once the run it started settles, since pi disposes the session when it returns`, async () => {
      const { pi, ctx, run } = loop({ mode });
      let returned = false;
      const done = run("tick").then(() => (returned = true));
      await drain();
      expect(pi.userMessages).toHaveLength(1);
      jest.advanceTimersByTime(60_000);
      await drain();
      expect(returned).toBe(false);
      await pi.emit("agent_settled", {}, ctx);
      await done;
      expect(returned).toBe(true);
    });
  }

  for (const [why, ctxOpts, args, reason] of [
    ["no model is selected", { model: null }, "1m tick", "no model is selected"],
    ["the selected model has no credentials", { auth: "none" }, "1m tick", "no credentials"],
    ["the prompt is an extension command, which pi runs without starting a run", {}, "1m /loop stop", "/loop is an extension command"],
  ]) {
    test(`in print mode /loop fails at once and marks the process failed when ${why}, since no settle would follow`, async () => {
      const { pi, run } = loop({ mode: "print", ...ctxOpts });
      const exitCode = process.exitCode;
      try {
        let outcome = "still waiting";
        run(args).then(
          () => (outcome = "returned"),
          (e) => (outcome = e),
        );
        await drain();
        expect(outcome).toBeInstanceOf(Error);
        expect(outcome.message).toContain(reason);
        expect(pi.userMessages).toEqual([]);
        expect(process.exitCode).toBe(1);
      } finally {
        // Bun ignores an undefined exit code, and a leftover 1 would fail the whole test run.
        process.exitCode = exitCode ?? 0;
      }
    });
  }

  for (const [what, ctxOpts, args, sent] of [
    ["on credentials only pi's live check finds", { auth: "live-check-only" }, "1m tick", "tick"],
    ["a slash prompt that names no extension command, such as a skill", {}, "1m /skill:babysit 42", "/skill:babysit 42"],
  ]) {
    test(`in print mode /loop still runs ${what}`, async () => {
      const { pi, ctx, run } = loop({ mode: "print", ...ctxOpts });
      const done = run(args);
      await drain();
      expect(pi.userMessages.map((m) => m.content)).toEqual([sent]);
      await pi.emit("agent_settled", {}, ctx);
      await done;
    });
  }

  test("in tui mode /loop fires a prompt pi would refuse, since pi reports the refusal itself and nothing waits on the run", async () => {
    const { pi, run } = loop({ auth: "none" });
    await run("1m tick");
    expect(pi.userMessages.map((m) => m.content)).toEqual(["tick"]);
  });

  test("/loop stop also cancels a self-paced wakeup", async () => {
    const { pi, ctx, run, ui } = loop();
    await run("watch");
    await pi.call("schedule_wakeup", { delaySeconds: 120, prompt: "/loop watch", reason: "r" }, ctx);
    await run("stop");
    expect(ui.calls.at(-1).message).toBe("Loop stopped.");
    jest.advanceTimersByTime(3_600_000);
    expect(pi.userMessages).toHaveLength(1);
  });
});
