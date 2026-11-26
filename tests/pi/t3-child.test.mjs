import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, renameSync } from "node:fs";
import { join } from "node:path";

import { cancelOrphan, T3Child, t3Session } from "../../plugins/pstack/pi/t3-child.ts";
import { writeSheet } from "../session-hook-sheets.mjs";
import { agentBody, agentEntry, flag, gitRepo, listAgents, recordWith, restore, resultText, useWorld, waitFor } from "./harness.mjs";

const LIVE_SESSION = t3Session();
const T3_ENV = ["T3_MCP_URL", "T3_MCP_BEARER_TOKEN"];
const saved = Object.fromEntries(T3_ENV.map((name) => [name, process.env[name]]));
let server;

afterEach(() => {
  server?.stop(true);
  server = undefined;
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const reply = (value) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
const failure = (message) => ({ content: [{ type: "text", text: JSON.stringify({ _tag: "OrchestratorMcpFailure", message }) }], isError: true });
const delegated = { taskId: "task-1", childThreadId: "thread-1", childRunId: "run-1" };

const sse = (reply) => `event: message\ndata: ${JSON.stringify(reply)}\n\n`;

function fakeT3(tools, frame = sse) {
  const calls = [];
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const message = await request.json();
      if (message.id === undefined) return new Response(null, { status: 202 });
      if (message.method === "initialize") {
        return Response.json({ jsonrpc: "2.0", id: message.id, result: {} }, { headers: { "mcp-session-id": "s1" } });
      }
      const { name, arguments: args } = message.params;
      calls.push({ name, args, session: request.headers.get("mcp-session-id"), auth: request.headers.get("authorization") });
      const result = name in tools ? await tools[name](args, calls) : failure(`The fake has no ${name} tool.`);
      return new Response(frame({ jsonrpc: "2.0", id: message.id, result }), { headers: { "content-type": "text/event-stream" } });
    },
  });
  const session = { endpoint: `http://127.0.0.1:${server.port}/mcp`, token: "tok" };
  process.env.T3_MCP_URL = session.endpoint;
  process.env.T3_MCP_BEARER_TOKEN = session.token;
  return { session, calls };
}

const levels = (...values) => [{ id: "thinking", values }];
const ALL_LEVELS = levels("low", "medium", "high", "xhigh", "max");
const capabilities = () =>
  reply({
    inheritedProviderInstanceId: "pi",
    inheritedModel: "anthropic/parent-model",
    providers: [
      { providerInstanceId: "codex", models: [{ id: "m", options: ALL_LEVELS }] },
      {
        providerInstanceId: "pi",
        models: [
          { id: "magpie/claude/claude-haiku-5-5", options: ALL_LEVELS },
          { id: "anthropic/fixture-haiku", options: ALL_LEVELS },
          { id: "anthropic/parent-model", options: levels("low") },
          { id: "m", options: levels("low", "medium", "high") },
          { id: "no-reasoning" },
        ],
      },
    ],
  });

const completing = (summary = "the answer") => ({
  orchestrator_capabilities: capabilities,
  delegate_task: () => reply(delegated),
  t3_thread_send: () => reply({ taskId: "task-2", runId: "run-2", delivery: "started" }),
  t3_thread_wait: () => reply({ status: "completed", timedOut: false }),
  task_status: () => reply({ status: "completed", summary }),
});

describe("T3Child", () => {
  test("a first launch delegates to a T3 thread, waits until the run is settled, and returns its summary", async () => {
    let waits = 0;
    const { session, calls } = fakeT3({ ...completing(), t3_thread_wait: () => reply({ status: "running", timedOut: ++waits < 2 }) });
    let started;
    const child = new T3Child(session, { title: "probe", model: "magpie/claude/claude-haiku-5-5", thinking: "low", onStart: (task) => (started = task) }, "do it");
    expect(await child.exited).toEqual({ exitCode: 0, settled: true, finalText: "the answer", errorMessage: "", stderr: "" });
    expect(started).toEqual({ threadId: "thread-1", taskId: "task-1" });
    expect(calls.map((c) => c.name)).toEqual(["orchestrator_capabilities", "delegate_task", "t3_thread_wait", "t3_thread_wait", "task_status"]);
    expect(calls[1].args).toEqual({ task: "do it", title: "probe", target: { model: "magpie/claude/claude-haiku-5-5", options: { thinking: "low" } }, mode: "async" });
    expect(calls[2].args).toMatchObject({ threadId: "thread-1", runId: "run-1", untilDelegatedWorkSettled: true });
    expect(calls[4].args).toEqual({ taskId: "task-1" });
    expect(calls.every((c) => c.session === "s1" && c.auth === "Bearer tok")).toBe(true);
  });

  test("the thinking level goes to T3 Code only when the model lists it, and a task with no run yet waits on its thread", async () => {
    const { session, calls } = fakeT3({ ...completing(), delegate_task: () => reply({ ...delegated, childRunId: null }) });
    const launches = [
      { model: "m", thinking: "high" },
      { model: "m", thinking: "xhigh" },
      { model: "m", thinking: "off" },
      { model: "no-reasoning", thinking: "low" },
      { model: "unlisted", thinking: "low" },
      { thinking: "low" },
      { thinking: "high" },
      { model: "m" },
    ];
    for (const launch of launches) await new T3Child(session, { title: "probe", ...launch, onStart: () => {} }, "x").exited;
    expect(calls.filter((c) => c.name === "delegate_task").map((c) => c.args.target)).toEqual([
      { model: "m", options: { thinking: "high" } },
      { model: "m" },
      { model: "m" },
      { model: "no-reasoning" },
      { model: "unlisted" },
      { options: { thinking: "low" } },
      {},
      { model: "m" },
    ]);
    expect(calls.filter((c) => c.name === "orchestrator_capabilities").map((c) => c.args)).toEqual([...Array(5).fill(null).map((_, i) => ({ search: launches[i].model })), {}, {}]);
    expect(calls.find((c) => c.name === "t3_thread_wait").args.runId).toBeUndefined();
  });

  test("a resume sends to the agent's thread, and a run that does not complete reports its status", async () => {
    const { session, calls } = fakeT3({
      t3_thread_send: () => reply({ taskId: "task-2", runId: "run-2", delivery: "started" }),
      t3_thread_wait: () => reply({ status: "failed", timedOut: false }),
      task_status: () => reply({ status: "failed", summary: null }),
    });
    let started;
    const exit = await new T3Child(session, { title: "probe", threadId: "thread-1", onStart: (task) => (started = task) }, "again").exited;
    expect(exit).toMatchObject({ settled: false, finalText: "", errorMessage: "The T3 Code task ended with status failed." });
    expect(started).toEqual({ threadId: "thread-1", taskId: "task-2" });
    expect(calls[0].args).toEqual({ threadId: "thread-1", message: "again", mode: "auto" });
    expect(calls[2].args).toEqual({ taskId: "task-2" });
  });

  test("a steer is taken only when T3 steers the running turn, and end cancels the task", async () => {
    let finish;
    const done = new Promise((resolve) => (finish = resolve));
    let steers = 0;
    const { session, calls } = fakeT3({
      delegate_task: () => reply(delegated),
      t3_thread_wait: async () => (await done, reply({ status: "interrupted", timedOut: false })),
      t3_thread_send: () => (++steers === 1 ? reply({ taskId: null, runId: "run-1", delivery: "steered" }) : failure("Thread has no running turn that can be steered.")),
      task_cancel: () => (finish(), reply({ taskId: "task-1", status: "cancel_requested" })),
      task_status: () => reply({ status: "interrupted", summary: "Child task ended with status interrupted." }),
    });
    const child = new T3Child(session, { title: "probe", onStart: () => {} }, "work");
    await waitFor(() => calls.some((c) => c.name === "t3_thread_wait"));
    expect(await child.steer("first")).toEqual({ response: { success: true }, taken: true });
    expect(await child.steer("second")).toEqual({ response: undefined, taken: false });
    expect(calls.filter((c) => c.name === "t3_thread_send").map((c) => c.args.mode)).toEqual(["steer", "steer"]);
    child.end();
    expect(await child.exited).toMatchObject({ settled: false, errorMessage: "Child task ended with status interrupted." });
    expect(calls.find((c) => c.name === "task_cancel").args).toMatchObject({ taskId: "task-1" });
    expect(await child.steer("late")).toEqual({ response: undefined, taken: false });
  });

  test("an end before T3 Code answers the launch cancels the task once it has one", async () => {
    let answer;
    const answered = new Promise((resolve) => (answer = resolve));
    const { session, calls } = fakeT3({
      delegate_task: async () => (await answered, reply(delegated)),
      task_cancel: () => reply({ taskId: "task-1", status: "cancel_requested" }),
      t3_thread_wait: () => reply({ status: "interrupted", timedOut: false }),
      task_status: () => reply({ status: "interrupted", summary: null }),
    });
    const child = new T3Child(session, { title: "probe", onStart: () => child.end() }, "work");
    await waitFor(() => calls.length === 1);
    child.end();
    answer();
    expect((await child.exited).settled).toBe(false);
    expect(calls.map((c) => c.name)).toEqual(["delegate_task", "task_cancel", "t3_thread_wait", "task_status"]);
  });

  test("a reply split over several data lines with CRLF line endings, after a priming event and a notification, is read whole", async () => {
    const crlf = (reply) => `id: 1\r\ndata:\r\n\r\n: ping\r\ndata: {"jsonrpc": "2.0", "method": "notifications/message"}\r\n\r\nevent: message\r\n${JSON.stringify(reply, null, 2).split("\n").map((line) => `data: ${line}`).join("\r\n")}\r\n\r\n`;
    const { session } = fakeT3(completing(), crlf);
    expect(await new T3Child(session, { title: "probe", onStart: () => {} }, "x").exited).toMatchObject({ settled: true, finalText: "the answer" });
  });

  test("a tool answer that is not JSON is an error naming the tool and the answer", async () => {
    const { session } = fakeT3({ delegate_task: () => ({ content: [{ type: "text", text: "Task queued, no id yet." }] }) });
    const exit = await new T3Child(session, { title: "probe", onStart: () => {} }, "x").exited;
    expect(exit.errorMessage).toBe("T3 Code delegate_task answered: Task queued, no id yet.");
  });

  test("a cancel that T3 Code refuses once the run has finished keeps the run's summary", async () => {
    let release;
    const held = new Promise((resolve) => (release = resolve));
    const { session, calls } = fakeT3({
      delegate_task: () => reply(delegated),
      t3_thread_wait: () => reply({ timedOut: false }),
      task_status: async () => (await held, reply({ status: "completed", summary: "the answer" })),
      task_cancel: () => (setTimeout(release, 20), failure("Task task-1 already completed.")),
    });
    const child = new T3Child(session, { title: "probe", onStart: () => {} }, "x");
    await waitFor(() => calls.some((c) => c.name === "task_status"));
    child.end();
    expect(await child.exited).toMatchObject({ settled: true, finalText: "the answer" });
  });

  test("signal from the exit hook sends T3 Code nothing", async () => {
    const { session, calls } = fakeT3({
      delegate_task: () => reply(delegated),
      t3_thread_wait: async () => (await Bun.sleep(20), reply({ timedOut: true })),
      task_cancel: () => reply({ taskId: "task-1", status: "cancel_requested" }),
    });
    const child = new T3Child(session, { title: "probe", onStart: () => {} }, "x");
    await waitFor(() => calls.some((c) => c.name === "t3_thread_wait"));
    child.signal("SIGTERM");
    await Bun.sleep(50);
    expect(calls.some((c) => c.name === "task_cancel")).toBe(false);
  });

  test("a T3 error becomes the run's error message", async () => {
    const { session } = fakeT3({ delegate_task: () => failure("Provider instance is disabled.") });
    const exit = await new T3Child(session, { title: "probe", onStart: () => {} }, "x").exited;
    expect(exit.settled).toBe(false);
    expect(exit.errorMessage).toContain("Provider instance is disabled.");
  });

  test("cancelOrphan reports true only once T3 Code has cancelled the task and its thread has settled", async () => {
    const { calls } = fakeT3({
      task_cancel: () => reply({ taskId: "task-1", status: "cancel_requested" }),
      t3_thread_wait: () => reply({ status: "interrupted", timedOut: false }),
    });
    expect(await cancelOrphan({ taskId: "task-1", threadId: "thread-1" })).toBe(true);
    expect(calls.map((c) => [c.name, c.args.taskId ?? c.args.threadId])).toEqual([["task_cancel", "task-1"], ["t3_thread_wait", "thread-1"]]);
    fakeT3({ task_cancel: () => failure("T3 Code is restarting.") });
    expect(await cancelOrphan({ taskId: "task-1", threadId: "thread-1" })).toBe(false);
    fakeT3({ task_cancel: () => ({ content: [{ type: "text", text: "Cancelled." }] }) });
    expect(await cancelOrphan({ taskId: "task-1", threadId: "thread-1" })).toBe(false);
    for (const name of T3_ENV) delete process.env[name];
    expect(await cancelOrphan({ taskId: "task-1", threadId: "thread-1" })).toBe(false);
  });
});

describe("the pi agent host: t3 sheet line", () => {
  const setup = useWorld();
  const t3Sheet = { sheet: "pi agent host: t3\n" };

  test("inside T3 Code, an agent runs as a T3 Code child thread with its agent file, model, and effort in the task", async () => {
    const { calls } = fakeT3(completing());
    const { w, pi, ctx } = setup(t3Sheet);
    const result = await pi.call("agent", { description: "probe", prompt: "look", subagent_type: "pstack:poteto-agent", model: "haiku", effort: "low" }, ctx);
    expect(resultText(result)).toContain("the answer");
    expect(w.invocations()).toEqual([]);
    const { task, title, target } = calls.find((c) => c.name === "delegate_task").args;
    expect({ title, target }).toEqual({ title: "probe", target: { model: "anthropic/fixture-haiku", options: { thinking: "low" } } });
    expect(task).toBe(`<agent name="pstack:poteto-agent">\n${agentBody("agents/poteto-agent.md")}\n</agent>\n\nlook`);
    const running = pi.entries.map((e) => e.data).filter((r) => r.status === "running");
    expect(running.map((r) => [r.host, r.agent.host, r.t3TaskId, r.agent.t3ThreadId])).toEqual([
      ["t3", "t3", undefined, undefined],
      ["t3", "t3", "task-1", "thread-1"],
    ]);
    expect(pi.entries.at(-1).data).toMatchObject({ status: "completed", finalText: "the answer" });
  });

  test("a read-only agent runs as a local process without the edit and write tools, because T3 Code cannot remove a thread's tools", async () => {
    const { calls } = fakeT3(completing());
    const { w, pi, ctx } = setup(t3Sheet);
    await pi.call("agent", { description: "ro", prompt: "x", readonly: true }, ctx);
    expect(w.invocations().map((inv) => [flag(inv, "--mode"), flag(inv, "--exclude-tools")])).toEqual([["rpc", "edit,write"]]);
    expect(calls).toEqual([]);
  });

  test("an agent at the depth limit runs as a local process without the agent tool", async () => {
    const { calls } = fakeT3(completing());
    const { w, pi, ctx } = setup({ ...t3Sheet, settings: { depth: 2 } });
    await pi.call("agent", { description: "deep", prompt: "x" }, ctx);
    expect(w.invocations().map((inv) => [flag(inv, "--mode"), flag(inv, "--exclude-tools")])).toEqual([["rpc", "agent"]]);
    expect(calls).toEqual([]);
  });

  test("send_message to a finished T3 agent resumes it in its thread with the message alone", async () => {
    const { calls } = fakeT3(completing());
    const { pi, ctx } = setup(t3Sheet);
    await pi.call("agent", { description: "probe", prompt: "first" }, ctx);
    const id = pi.entries[0].data.agent.id;
    await pi.call("send_message", { to: id, message: "more" }, ctx);
    await waitFor(() => pi.entries.at(-1).data.status === "completed" && calls.some((c) => c.name === "t3_thread_send"));
    expect(calls.find((c) => c.name === "t3_thread_send").args).toEqual({ threadId: "thread-1", message: "more", mode: "auto" });
    expect(pi.entries.findLast((e) => e.data.status === "running").data).toMatchObject({ host: "t3", t3TaskId: "task-2" });
  });

  test("an agent whose first T3 launch failed starts in T3 Code on send_message", async () => {
    let launches = 0;
    const { calls } = fakeT3({ ...completing(), delegate_task: () => (++launches === 1 ? failure("Provider instance is disabled.") : reply(delegated)) });
    const { w, pi, ctx } = setup(t3Sheet);
    await pi.call("agent", { description: "probe", prompt: "first" }, ctx).catch(() => undefined);
    expect(pi.entries.at(-1).data.status).toBe("failed");
    await pi.call("send_message", { to: pi.entries[0].data.agent.id, message: "more" }, ctx);
    await waitFor(() => pi.entries.at(-1).data.status === "completed");
    expect(calls.filter((c) => c.name === "delegate_task").map((c) => c.args.task.split("\n\n").at(-1))).toEqual(["first", "more"]);
    expect(w.invocations()).toEqual([]);
  });

  test("send_message to a T3 agent from a session outside T3 Code is an error", async () => {
    fakeT3(completing());
    const { pi, ctx } = setup(t3Sheet);
    await pi.call("agent", { description: "probe", prompt: "first" }, ctx);
    for (const name of T3_ENV) delete process.env[name];
    const err = await pi.call("send_message", { to: pi.entries[0].data.agent.id, message: "more" }, ctx).catch((e) => e);
    expect(err.message).toContain("runs in T3 Code; message it from a Pi session inside T3 Code");
  });

  test("stop_agent cancels a background T3 agent's task and records it stopped", async () => {
    let finish;
    const done = new Promise((resolve) => (finish = resolve));
    const { calls } = fakeT3({
      orchestrator_capabilities: capabilities,
      delegate_task: () => reply(delegated),
      t3_thread_wait: async () => (await done, reply({ status: "interrupted", timedOut: false })),
      task_cancel: () => (finish(), reply({ taskId: "task-1", status: "cancel_requested" })),
      task_status: () => reply({ status: "interrupted", summary: null }),
    });
    const { pi, ctx } = setup(t3Sheet);
    await pi.call("agent", { description: "long", prompt: "x", run_in_background: true }, ctx);
    await waitFor(() => calls.some((c) => c.name === "t3_thread_wait"));
    await pi.call("stop_agent", { id: pi.entries[0].data.agent.id }, ctx);
    expect(calls.find((c) => c.name === "task_cancel").args).toMatchObject({ taskId: "task-1" });
    expect(pi.entries.at(-1).data.status).toBe("stopped");
  });

  test("a worktree agent runs as a local process without the T3 Code session, so its own agents stay in its worktree", async () => {
    const { session, calls } = fakeT3(completing());
    const { w, pi, ctx } = setup(t3Sheet);
    gitRepo(w.cwd);
    await pi.call("agent", { description: "w", prompt: "x", isolation: "worktree" }, ctx);
    const [inv] = w.invocations();
    expect({ mode: flag(inv, "--mode"), t3Url: inv.t3Url }).toEqual({ mode: "rpc", t3Url: null });
    expect(process.env.T3_MCP_URL).toBe(session.endpoint);
    expect(calls).toEqual([]);
  });

  test("without the line, or outside T3 Code, an agent runs as a local process", async () => {
    const { session, calls } = fakeT3(completing());
    const { w, pi, ctx } = setup();
    await pi.call("agent", { description: "no line", prompt: "x" }, ctx);
    writeSheet(join(w.agentDir, "pstack-models.md"), "pi agent host: t3\n");
    for (const name of T3_ENV) delete process.env[name];
    await pi.call("agent", { description: "outside", prompt: "x" }, ctx);
    expect(w.invocations().map((inv) => [flag(inv, "--mode"), inv.t3Url])).toEqual([["rpc", session.endpoint], ["rpc", null]]);
    expect(calls).toEqual([]);
  });

  test("stop_agent on an agent whose task T3 Code will not cancel returns stopped with T3 Code's refusal, and waits no more", async () => {
    const { calls } = fakeT3({
      orchestrator_capabilities: capabilities,
      delegate_task: () => reply(delegated),
      t3_thread_wait: async () => (await Bun.sleep(20), reply({ timedOut: true })),
      task_cancel: () => failure("Child runtime mode full-access is broader than parent mode approval-required."),
    });
    const { pi, ctx } = setup(t3Sheet);
    await pi.call("agent", { description: "long", prompt: "x", run_in_background: true }, ctx);
    await waitFor(() => calls.some((c) => c.name === "t3_thread_wait"));
    const stopped = JSON.parse(resultText(await pi.call("stop_agent", { id: "long" }, ctx)));
    expect(stopped.status).toBe("stopped");
    const record = pi.entries.at(-1).data;
    expect(record).toMatchObject({ status: "stopped" });
    expect(record.finalText).toContain("T3 Code did not cancel task task-1, so thread thread-1 may still be running");
    expect(record.finalText).toContain("broader than parent mode");
    const waits = calls.filter((c) => c.name === "t3_thread_wait").length;
    await Bun.sleep(200);
    expect(calls.filter((c) => c.name === "t3_thread_wait").length).toBe(waits);
    await pi.emit("session_shutdown", {}, ctx);
  });

  test("an agent that ran as a local process resumes as one, even once the line is added and its session file is gone", async () => {
    const { calls } = fakeT3(completing());
    const { w, pi, ctx } = setup();
    await pi.call("agent", { description: "local", prompt: "x" }, ctx);
    const { sessionDir } = pi.entries[0].data.agent;
    for (const name of readdirSync(sessionDir).filter((n) => n.endsWith(".jsonl"))) renameSync(join(sessionDir, name), join(sessionDir, `${name}.moved`));
    const resumed = await restore(w, pi.entries, "resume");
    writeSheet(join(w.agentDir, "pstack-models.md"), "pi agent host: t3\n");
    await resumed.call("send_message", { to: pi.entries[0].data.agent.id, message: "more" }, ctx);
    await w.until("invocation", 2);
    expect(calls).toEqual([]);
  });

  test("a restored T3 agent is left to its live launching pi, and once that pi is gone its task is cancelled and it reads as stopped", async () => {
    const { calls } = fakeT3({
      ...completing(),
      task_cancel: () => reply({ taskId: "task-1", status: "cancel_requested" }),
      t3_thread_wait: () => reply({ status: "interrupted", timedOut: false }),
    });
    const { w, pi, ctx } = setup();
    await pi.call("agent", { description: "in t3", prompt: "x" }, ctx);
    const launcher = w.spawn("sleep", ["30"], { detached: true });
    const gone = w.spawn("sleep", ["0.1"]);
    await new Promise((resolve) => gone.on("exit", resolve));
    const asT3 = (parentPid) => [agentEntry(recordWith(pi.entries[0].data, { agent: { host: "t3", t3ThreadId: "thread-1" }, status: "running", host: "t3", t3TaskId: "task-1", pid: undefined, parentPid }))];

    const kept = await restore(w, asT3(launcher.pid));
    expect((await listAgents(kept, ctx))[0].status).toBe("running");
    expect(calls).toEqual([]);

    const resumed = await restore(w, asT3(gone.pid));
    await waitFor(async () => (await listAgents(resumed, ctx))[0].status === "stopped");
    expect(calls.map((c) => [c.name, c.args.taskId ?? c.args.threadId])).toEqual([["task_cancel", "task-1"], ["t3_thread_wait", "thread-1"]]);
  });

  test("a restored T3 agent whose task T3 Code has not cancelled stays unavailable, and the next look tries again", async () => {
    let refuse = true;
    const { calls } = fakeT3({
      task_cancel: () => (refuse ? failure("T3 Code is restarting.") : reply({ taskId: "task-1", status: "cancel_requested" })),
      t3_thread_wait: () => reply({ status: "interrupted", timedOut: false }),
    });
    const { w, pi, ctx } = setup();
    await pi.call("agent", { description: "in t3", prompt: "x" }, ctx);
    const gone = w.spawn("sleep", ["0.1"]);
    await new Promise((resolve) => gone.on("exit", resolve));
    const record = recordWith(pi.entries[0].data, { agent: { host: "t3", t3ThreadId: "thread-1" }, status: "running", host: "t3", t3TaskId: "task-1", pid: undefined, parentPid: gone.pid });
    const resumed = await restore(w, [agentEntry(record)]);
    await waitFor(() => calls.some((c) => c.name === "task_cancel"));
    await Bun.sleep(50);
    const err = await resumed.call("send_message", { to: record.agent.id, message: "more" }, ctx).catch((e) => e);
    expect(err.message).toContain("T3 Code task task-1 has not been cancelled");
    refuse = false;
    await waitFor(async () => (await listAgents(resumed, ctx))[0].status === "stopped");
    expect(calls.filter((c) => c.name === "task_cancel").length).toBeGreaterThan(1);
  });

  test("cancelOrphan treats a refused cancel as done only when T3 Code reports the task ended", async () => {
    let status = "running";
    fakeT3({ task_cancel: () => failure("Child runtime mode full-access is broader than parent mode approval-required."), task_status: () => reply({ status, summary: null }) });
    expect(await cancelOrphan({ taskId: "task-1", threadId: "thread-1" })).toBe(false);
    status = "completed";
    expect(await cancelOrphan({ taskId: "task-1", threadId: "thread-1" })).toBe(true);
  });

  test("a restored T3 agent whose cancel T3 Code always refuses reads as stopped once its task has ended", async () => {
    let status = "running";
    const { calls } = fakeT3({
      task_cancel: () => failure("Child runtime mode full-access is broader than parent mode approval-required."),
      task_status: () => reply({ status, summary: null }),
    });
    const { w, pi, ctx } = setup();
    await pi.call("agent", { description: "in t3", prompt: "x" }, ctx);
    const gone = w.spawn("sleep", ["0.1"]);
    await new Promise((resolve) => gone.on("exit", resolve));
    const record = recordWith(pi.entries[0].data, { agent: { host: "t3", t3ThreadId: "thread-1" }, status: "running", host: "t3", t3TaskId: "task-1", pid: undefined, parentPid: gone.pid });
    const resumed = await restore(w, [agentEntry(record)]);
    await waitFor(() => calls.some((c) => c.name === "task_status"));
    expect((await listAgents(resumed, ctx))[0].status).toBe("running");
    status = "completed";
    await waitFor(async () => (await listAgents(resumed, ctx))[0].status === "stopped");
  });

  test("stop_agent stops waiting after the kill grace when T3 Code accepts the cancel but the thread never settles", async () => {
    const { calls } = fakeT3({
      orchestrator_capabilities: capabilities,
      delegate_task: () => reply(delegated),
      t3_thread_wait: async () => (await Bun.sleep(20), reply({ timedOut: true })),
      task_cancel: () => reply({ taskId: "task-1", status: "cancel_requested" }),
    });
    const { pi, ctx } = setup({ ...t3Sheet, settings: { killGraceMs: 300 } });
    await pi.call("agent", { description: "long", prompt: "x", run_in_background: true }, ctx);
    await waitFor(() => calls.some((c) => c.name === "t3_thread_wait"));
    const started = Date.now();
    const stopped = JSON.parse(resultText(await pi.call("stop_agent", { id: "long" }, ctx)));
    expect(Date.now() - started).toBeLessThan(3000);
    expect(stopped.status).toBe("stopped");
    expect(pi.entries.at(-1).data.finalText).toContain("T3 Code had not settled thread thread-1 300 ms after the cancel of task task-1");
    const waits = calls.filter((c) => c.name === "t3_thread_wait").length;
    await Bun.sleep(200);
    expect(calls.filter((c) => c.name === "t3_thread_wait").length).toBe(waits);
  });
});

const LIVE = process.env.PSTACK_PI_T3_LIVE === "1" && LIVE_SESSION !== undefined;
const MODEL = process.env.PSTACK_PI_T3_MODEL;
const MINUTE = 60_000;

describe.skipIf(!LIVE)("T3Child on a live T3 Code server", () => {
  const launch = (prompt, threadId) => {
    const task = { threadId };
    const child = new T3Child(LIVE_SESSION, { title: `pstack t3 live ${Date.now()}`, model: MODEL, thinking: "low", threadId, onStart: (started) => Object.assign(task, started) }, prompt);
    return { child, task };
  };

  test(
    "a run settles on its reply, and a resume in the same thread keeps the context",
    async () => {
      const first = launch("Remember the word t3probe42. Reply with the result of 6 * 7, and nothing else.");
      const exit = await first.child.exited;
      expect(exit.settled).toBe(true);
      expect(exit.finalText).toContain("42");
      const again = launch("Which word did I ask you to remember? Reply with just the word.", first.task.threadId);
      const resumed = await again.child.exited;
      expect(resumed.settled).toBe(true);
      expect(resumed.finalText).toContain("t3probe42");
    },
    5 * MINUTE,
  );

  test(
    "a steer reaches the running turn, and end stops a working run",
    async () => {
      const { child } = launch("Run `sleep 25` with bash and wait for it, then reply with the word done, unless I tell you otherwise.");
      await Bun.sleep(12_000);
      expect((await child.steer("When the sleep ends, reply with the word steered instead.")).taken).toBe(true);
      const steered = await child.exited;
      expect(steered.settled).toBe(true);
      expect(steered.finalText.toLowerCase()).toContain("steered");

      const long = launch("Run `sleep 120` with bash and wait for it, then say done.");
      await Bun.sleep(10_000);
      const at = Date.now();
      long.child.end();
      const stopped = await long.child.exited;
      expect(stopped.settled).toBe(false);
      expect(Date.now() - at).toBeLessThan(MINUTE);
    },
    5 * MINUTE,
  );

  test(
    "cancelOrphan, as a resumed session uses it, stops a working task and returns once its thread has settled",
    async () => {
      const { child, task } = launch("Run `sleep 120` with bash and wait for it, then say done.");
      await Bun.sleep(10_000);
      const at = Date.now();
      expect(await cancelOrphan(task)).toBe(true);
      expect(Date.now() - at).toBeLessThan(MINUTE);
      expect((await child.exited).settled).toBe(false);
    },
    3 * MINUTE,
  );
});
