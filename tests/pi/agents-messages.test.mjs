// send_message through the fake ExtensionAPI: a steer into a running agent, a
// resume of a finished one, and the races between the two.
import { describe, expect, test } from "bun:test";

import { alive, listAgents, resultText, sleep, useWorld, waitFor } from "./harness.mjs";

const setup = useWorld();

describe("send_message", () => {
  test("resumes a finished agent in the same session, model, and thinking, in the background", async () => {
    const { w, pi, ctx } = setup({ script: { default: [{ reply: "seen: ${history}; now: ${prompt}" }] } });
    const first = await pi.call(
      "agent",
      { description: "reviewer", prompt: "first task", subagent_type: "pstack:effort-high", model: "fable" },
      ctx,
    );
    const sent = await pi.call("send_message", { to: "reviewer", message: "follow up" }, ctx);
    expect(JSON.parse(resultText(sent))).toEqual({ agentId: first.details.agentId, status: "running" });
    await waitFor(() => pi.messages.length === 1);

    const [a, b] = w.invocations();
    expect(b.argv).toEqual(a.argv);
    expect(b.prompt).toBe("follow up");
    expect(pi.messages[0].options).toEqual({ triggerTurn: true, deliverAs: "steer" });
    expect(pi.messages[0].message.content).toContain("seen: first task; now: follow up");
    expect(pi.messages[0].message.content).toContain(`agentId: ${first.details.agentId}`);
  });

  test("a message to a running agent reaches that run before it exits, and the agent reports once", async () => {
    const { w, pi, ctx } = setup({
      script: { byPrompt: { slow: [{ awaitMessage: 3000 }, { reply: "slow done, told: ${steered}" }] } },
    });
    const { details } = await pi.call("agent", { description: "worker", prompt: "slow", run_in_background: true }, ctx);
    await w.until("invocation");
    const sent = await pi.call("send_message", { to: "worker", message: "change course" }, ctx);
    expect(sent.details).toEqual({ agentId: details.agentId, running: true });
    expect(resultText(sent)).toContain("after its current tool calls");

    await waitFor(() => pi.messages.length === 1);
    const [run] = w.invocations();
    expect(w.logged("steered")).toEqual([{ kind: "steered", text: "change course", pid: run.pid }]);
    expect(pi.messages[0].message.content).toContain("slow done, told: change course");
    await sleep(300);
    expect(pi.messages).toHaveLength(1);
    expect(w.invocations()).toHaveLength(1);
  });

  test("a message that arrives after the run settled but before the process exited resumes the agent once it is gone", async () => {
    const { w, pi, ctx } = setup({
      script: { byPrompt: { slow: [{ reply: "slow done" }, { lingerAfterSettle: 600 }] }, default: [{ reply: "got ${prompt}" }] },
    });
    const { details } = await pi.call("agent", { description: "worker", prompt: "slow", run_in_background: true }, ctx);
    await w.until("settled");
    const sent = await pi.call("send_message", { to: details.agentId, message: "more" }, ctx);
    expect(sent.details.running).toBe(false);

    await waitFor(() => pi.messages.length === 2);
    expect(pi.messages[0].message.content).toContain("slow done");
    expect(pi.messages[1].message.content).toContain("got more");
    expect(w.invocations().map((i) => i.prompt)).toEqual(["slow", "more"]);
    expect(w.logged("steered")).toEqual([]);
  });

  test("two messages sent at once to a settled agent start one resume, and the second steers it", async () => {
    const { w, pi, ctx } = setup({
      script: { byPrompt: { slow: [{ reply: "slow done" }, { lingerAfterSettle: 800 }] }, default: [{ awaitMessage: 3000 }, { reply: "got ${prompt}, then ${steered}" }] },
    });
    const { details } = await pi.call("agent", { description: "worker", prompt: "slow", run_in_background: true }, ctx);
    await w.until("settled");
    const [a, b] = await Promise.all([
      pi.call("send_message", { to: details.agentId, message: "m1" }, ctx),
      pi.call("send_message", { to: details.agentId, message: "m2" }, ctx),
    ]);
    expect([a.details.running, b.details.running]).toEqual([false, true]);

    await waitFor(() => pi.messages.length === 2);
    expect(w.invocations().map((i) => i.prompt)).toEqual(["slow", "m1"]);
    expect(pi.messages[1].message.content).toContain("got m1, then m2");
    await pi.emit("session_shutdown", {}, ctx);
    for (const inv of w.invocations()) expect(alive(inv.pid)).toBe(false);
  });

  test("a message pi queues after it has settled, but before the parent saw the settle, resumes the agent with it", async () => {
    const { w, pi, ctx } = setup({
      script: { byPrompt: { slow: [{ reply: "slow done" }, { holdSettle: 400 }] }, default: [{ reply: "got ${prompt}" }] },
    });
    const { details } = await pi.call("agent", { description: "worker", prompt: "slow", run_in_background: true }, ctx);
    await w.until("idle");
    const sent = await pi.call("send_message", { to: details.agentId, message: "more" }, ctx);
    expect(sent.details.running).toBe(false);

    await waitFor(() => pi.messages.length === 2);
    expect(pi.messages[1].message.content).toContain("got more");
    expect(w.invocations().map((i) => i.prompt)).toEqual(["slow", "more"]);
    expect(w.logged("steered")).toEqual([]);
  });

  test("a message the child never answers before it dies resumes the agent instead of waiting forever", async () => {
    const { w, pi, ctx } = setup({ script: { byPrompt: { first: [{ mute: true }, { sleep: 600 }, { exit: 1 }] }, default: [{ reply: "got ${prompt}" }] } });
    const { details } = await pi.call("agent", { description: "worker", prompt: "first", run_in_background: true }, ctx);
    await w.until("invocation");
    const sent = await pi.call("send_message", { to: details.agentId, message: "more" }, ctx);
    expect(sent.details.running).toBe(false);
    await waitFor(() => pi.messages.length === 2);
    expect(pi.messages[1].message.content).toContain("got more");
  });

  test("a message waiting on a settling agent does not resume it after session_shutdown", async () => {
    const { w, pi, ctx } = setup({ script: { byPrompt: { slow: [{ reply: "slow done" }, { lingerAfterSettle: 2000 }] }, default: [{ sleep: 30000 }] } });
    const { details } = await pi.call("agent", { description: "worker", prompt: "slow", run_in_background: true }, ctx);
    await w.until("settled");
    const sent = pi.call("send_message", { to: details.agentId, message: "more" }, ctx).then(() => "resumed", (e) => e.message);
    await pi.emit("session_shutdown", { reason: "quit" }, ctx);
    expect(await sent).toContain("stopped");
    await sleep(200);
    expect(w.invocations().map((i) => i.prompt)).toEqual(["slow"]);
    for (const inv of w.invocations()) expect(alive(inv.pid)).toBe(false);
    expect((await listAgents(pi, ctx))[0].status).toBe("stopped");
  });

  test("a message waiting on a settling agent is not delivered when stop_agent wins the race, and nothing starts after shutdown", async () => {
    const { w, pi, ctx } = setup({ script: { byPrompt: { slow: [{ reply: "slow done" }, { lingerAfterSettle: 2000 }] }, default: [{ sleep: 30000 }] } });
    const { details } = await pi.call("agent", { description: "worker", prompt: "slow", run_in_background: true }, ctx);
    await w.until("settled");
    const sent = pi.call("send_message", { to: details.agentId, message: "more" }, ctx).then(() => "resumed", (e) => e.message);
    const stopped = await pi.call("stop_agent", { id: details.agentId }, ctx);
    expect(JSON.parse(resultText(stopped)).status).toBe("stopped");
    expect(await sent).toContain("stopped");
    expect(w.invocations().map((i) => i.prompt)).toEqual(["slow"]);
    expect((await listAgents(pi, ctx))[0].status).toBe("stopped");

    await pi.emit("session_shutdown", { reason: "quit" }, ctx);
    const late = await pi.call("agent", { description: "late", prompt: "x", run_in_background: true }, ctx).catch((e) => e);
    expect(late).toBeInstanceOf(Error);
    expect(w.invocations()).toHaveLength(1);
  });

  test("a message the child rejects is an error, and the child keeps running", async () => {
    const { w, pi, ctx } = setup({ script: { default: [{ awaitMessage: 3000 }, { reply: "done" }] } });
    const { details } = await pi.call("agent", { description: "worker", prompt: "x", run_in_background: true }, ctx);
    await w.until("invocation");
    const err = await pi.call("send_message", { to: details.agentId, message: "/reject-me" }, ctx).catch((e) => e);
    expect(err.message).toContain("did not take the message");
    expect((await listAgents(pi, ctx))[0].status).toBe("running");
  });

  test("an unknown recipient is an error naming the known agents", async () => {
    const { pi, ctx } = setup();
    const { details } = await pi.call("agent", { description: "known one", prompt: "x" }, ctx);
    const err = await pi.call("send_message", { to: "nobody", message: "hi" }, ctx).catch((e) => e);
    expect(err.message).toContain(`${details.agentId} (known one)`);
  });
});
