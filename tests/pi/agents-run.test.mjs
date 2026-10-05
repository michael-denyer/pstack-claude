// One agent run through the fake ExtensionAPI, with the fake pi as the child:
// its lifecycle, how its end is classified, its output, and stopping it.
import { describe, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { alive, flag, listAgents, resultText, sleep, useWorld, waitFor } from "./harness.mjs";

const setup = useWorld();

describe("agent tool", () => {
  test("foreground waits, returns the final text and agentId, and runs the exact child command", async () => {
    const { w, pi, ctx } = setup({ script: { default: [{ reply: "draft" }, { reply: "final answer" }] } });
    const result = await pi.call("agent", { description: "write it", prompt: "-do it" }, ctx);

    const [inv] = w.invocations();
    const id = result.details.agentId;
    expect(resultText(result)).toContain(`agentId: ${id}`);
    expect(resultText(result)).toContain("final answer");
    expect(resultText(result)).not.toContain("draft");
    expect(result.details.status).toBe("completed");
    expect(inv.argv).toEqual([
      "--mode", "rpc",
      "--session-id", flag(inv, "--session-id"),
      "--session-dir", join(w.agentDir, "pstack", "parent-session", "agents"),
      "--model", "anthropic/parent-model",
      "--thinking", "medium",
      "--pstack-depth", "1",
    ]);
    expect(inv.prompt).toBe("-do it");
    expect(flag(inv, "--session-id")).toMatch(/^[0-9a-f-]{36}$/);
    expect(inv.cwd).toBe(w.cwd);
    expect(inv.depth).toBe("1");
    expect(pi.messages).toEqual([]);
  });

  test("background returns at once and the completion notice comes only after the process exits", async () => {
    const { pi, ctx } = setup({ script: { default: [{ sleep: 300 }, { reply: "done in bg" }] } });
    let aliveAtNotice;
    const send = pi.api.sendMessage;
    pi.api.sendMessage = (m, o) => {
      aliveAtNotice = alive(pi.entries.at(-1).data.pid);
      send(m, o);
    };
    const result = await pi.call("agent", { description: "bg job", prompt: "go", run_in_background: true }, ctx);
    const id = result.details.agentId;
    const [json, note] = resultText(result).split("\n\n");
    expect(JSON.parse(json)).toEqual({ agentId: id, status: "running" });
    expect(note).toContain("You will be notified automatically when it completes.");

    const listed = await listAgents(pi, ctx);
    expect(listed[0]).toMatchObject({ id, status: "running", description: "bg job" });
    expect(alive(listed[0].pid)).toBe(true);
    expect(pi.messages).toEqual([]);

    await waitFor(() => pi.messages.length === 1);
    const [{ message, options }] = pi.messages;
    expect(options).toEqual({ triggerTurn: true, deliverAs: "steer" });
    expect(message.customType).toBe("pstack-agent");
    expect(message.display).toBe(true);
    expect(message.content).toContain(`agentId: ${id}`);
    expect(message.content).toContain("status: completed");
    expect(message.content).toContain("exit code: 0");
    expect(message.content).toContain("done in bg");
    expect(aliveAtNotice).toBe(false);
    expect((await listAgents(pi, ctx))[0].status).toBe("completed");
  });

  test("an errored last message, a run without a final message, or a non-zero exit is failed, with the error in the notice", async () => {
    const { pi, ctx } = setup({
      script: {
        byPrompt: {
          crash: [{ reply: "partial" }, { error: "provider exploded" }],
          silent: [],
          died: [{ reply: "almost" }, { exit: 3 }],
          recovered: [{ error: "transient" }, { reply: "second try" }],
        },
      },
    });
    for (const prompt of ["crash", "silent", "died", "recovered"]) {
      await pi.call("agent", { description: prompt, prompt, run_in_background: true }, ctx);
    }
    await waitFor(() => pi.messages.length === 4);
    const byDesc = Object.fromEntries(pi.messages.map(({ message }) => [message.content.match(/description: (\w+)/)[1], message]));
    expect(byDesc.crash.content).toContain("status: failed");
    expect(byDesc.crash.content).toContain("exit code: 0");
    expect(byDesc.crash.content).toContain("partial\n\nprovider exploded");
    expect(byDesc.silent.content).toContain("status: failed");
    expect(byDesc.silent.content).toContain("(no output)");
    expect(byDesc.died.content).toContain("status: failed");
    expect(byDesc.died.content).toContain("exit code: 3");
    expect(byDesc.recovered.content).toContain("status: completed");
    expect(byDesc.recovered.content).toContain("second try");
    expect(byDesc.recovered.content).not.toContain("transient");
  });

  test("a prompt an extension command consumes ends the agent as failed instead of waiting for a run that never starts", async () => {
    const { pi, ctx } = setup();
    const result = await pi.call("agent", { description: "cmd", prompt: "/hello there" }, ctx);
    expect(result.details.status).toBe("failed");
    expect(resultText(result)).toContain("extension command");
  });

  test("a child that settles but never exits after stdin closes is ended, and its reply still counts as completed", async () => {
    const { w, pi, ctx } = setup({ script: { default: [{ reply: "done" }, { lingerAfterSettle: 60000 }] } });
    const result = await pi.call("agent", { description: "x", prompt: "p" }, ctx);
    expect(result.details.status).toBe("completed");
    expect(resultText(result)).toContain("done");
    expect(alive(w.invocations()[0].pid)).toBe(false);
  });

  test("a process a finished bash command left in the background outlives the agent, as on pi, and does not delay its result", async () => {
    const { w, pi, ctx } = setup({ script: { default: [{ spawn: "background" }, { reply: "ok" }] } });
    const started = Date.now();
    const result = await pi.call("agent", { description: "x", prompt: "p" }, ctx);
    expect(result.details.status).toBe("completed");
    expect(Date.now() - started).toBeLessThan(w.settings.exitGraceMs);
    await sleep(100);
    expect(alive(w.logged("grandchild")[0].pid)).toBe(true);
  });

  test("a clean exit sends no signal to the child's process group", async () => {
    const { w, pi, ctx } = setup({ script: { default: [{ spawn: "ingroup" }, { reply: "ok" }] } });
    const result = await pi.call("agent", { description: "x", prompt: "p" }, ctx);
    await sleep(100);
    expect(result.details.status).toBe("completed");
    expect(alive(w.logged("grandchild")[0].pid)).toBe(true);
  });

  test("a process holding the child's pipes after it exited delays the result by the close timer only", async () => {
    const { pi, ctx } = setup({ script: { default: [{ spawn: "holding-pipes" }, { sleep: 300 }, { reply: "ok" }] } });
    const started = Date.now();
    const result = await pi.call("agent", { description: "x", prompt: "p" }, ctx);
    const elapsed = Date.now() - started;
    expect(result.details.status).toBe("completed");
    expect(elapsed).toBeGreaterThan(1500);
    expect(elapsed).toBeLessThan(4000);
  });

  test("a dialog the child opens is cancelled so its run goes on, and a notify gets no response", async () => {
    const { w, pi, ctx } = setup({ script: { default: [{ askUser: true }, { reply: "went on" }] } });
    const result = await pi.call("agent", { description: "x", prompt: "p" }, ctx);
    expect(result.details.status).toBe("completed");
    expect(resultText(result)).toContain("went on");
    const [inv] = w.invocations();
    expect(w.logged("ui-response")).toEqual([{ kind: "ui-response", id: "u1", cancelled: true, pid: inv.pid }]);
  });

  test("a stdout record missing the fields its type implies is skipped, and the run still completes", async () => {
    const lines = [
      { type: "message_end" },
      { type: "message_end", message: null },
      { type: "message_end", message: { role: "assistant", content: "a string" } },
      { type: "message_end", message: { role: "assistant", content: [null, { type: "text" }] } },
      { type: "response" },
      { type: "extension_ui_request", method: "select" },
    ];
    const { pi, ctx } = setup({ script: { default: [{ raw: lines.map((l) => `${JSON.stringify(l)}\n`).join("") }, { reply: "ok" }] } });
    const result = await pi.call("agent", { description: "x", prompt: "p" }, ctx);
    expect(result.details.status).toBe("completed");
    expect(resultText(result)).toContain("ok");
  });

  test("a stdout line that is valid JSON but not an object is skipped", async () => {
    const { pi, ctx } = setup({ script: { default: [{ raw: "null\n42\n\"text\"\n" }, { reply: "ok" }] } });
    const result = await pi.call("agent", { description: "x", prompt: "p" }, ctx);
    expect(result.details.status).toBe("completed");
    expect(resultText(result)).toContain("ok");
  });

  test("a run whose last assistant message has no text is failed, with the earlier text and the stop reason", async () => {
    const cutOff = { type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", id: "t", name: "bash", arguments: {} }], stopReason: "length", timestamp: 1 } };
    const { pi, ctx } = setup({ script: { default: [{ reply: "Let me look at the files." }, { raw: `${JSON.stringify(cutOff)}\n` }] } });
    const result = await pi.call("agent", { description: "x", prompt: "p" }, ctx);
    expect(result.details.status).toBe("failed");
    expect(resultText(result)).toContain("Let me look at the files.");
    expect(resultText(result)).toContain("length");
  });

  test("final text survives U+2028 inside a JSON string", async () => {
    const { pi, ctx } = setup({ script: { default: [{ reply: "line one line two" }] } });
    const result = await pi.call("agent", { description: "sep", prompt: "x" }, ctx);
    expect(resultText(result)).toContain("line one line two");
    expect(result.details.status).toBe("completed");
  });

  test("output over 50 KB is truncated in the notice and kept in full on disk", async () => {
    // Three-byte characters: the cap falls inside one, so the cut must back off.
    const big = "€".repeat(40 * 1024);
    const { w, pi, ctx } = setup({ script: { default: [{ reply: big }] } });
    await pi.call("agent", { description: "big", prompt: "x", run_in_background: true }, ctx);
    await waitFor(() => pi.messages.length === 1);
    const { content, details } = pi.messages[0].message;
    expect(details.outputFile).toBe(join(w.agentDir, "pstack", "parent-session", "agents", `${details.agentId}.out.md`));
    expect(content).toContain(`full output: ${details.outputFile}`);
    expect(Buffer.byteLength(content)).toBeLessThan(51 * 1024);
    expect(content).not.toContain("�");
    expect(readFileSync(details.outputFile, "utf8")).toBe(big);
  });

  test("a persisted record keeps capped text and the full output's path", async () => {
    const big = "x".repeat(80 * 1024);
    const { pi, ctx } = setup({ script: { default: [{ reply: big }] } });
    await pi.call("agent", { description: "big", prompt: "x", run_in_background: true }, ctx);
    await waitFor(() => pi.messages.length === 1);
    const last = pi.entries.at(-1).data;
    expect(last.status).toBe("completed");
    expect(Buffer.byteLength(last.finalText)).toBeLessThanOrEqual(50 * 1024);
    expect(readFileSync(last.outputFile, "utf8")).toBe(big);
  });

  test("an agent whose oversized output cannot be saved still ends, reports once, and can be stopped and messaged", async () => {
    const { w, pi, ctx } = setup({ script: { default: [{ sleep: 400 }, { reply: "x".repeat(80 * 1024) }] } });
    const id = (await pi.call("agent", { description: "big", prompt: "x", run_in_background: true }, ctx)).details.agentId;
    await w.until("invocation");
    const { pid } = w.invocations()[0];
    rmSync(join(w.agentDir, "pstack"), { recursive: true, force: true });
    await waitFor(() => !alive(pid));
    await waitFor(() => pi.messages.length > 0, 2000);
    await sleep(100);

    expect(pi.messages).toHaveLength(1);
    expect(pi.messages[0].message.content).toContain("(full output not saved");
    expect((await listAgents(pi, ctx))[0].status).toBe("completed");
    expect(JSON.parse(resultText(await pi.call("stop_agent", { id }, ctx))).status).toBe("completed");
    expect(JSON.parse(resultText(await pi.call("send_message", { to: id, message: "more" }, ctx)))).toEqual({ agentId: id, status: "running" });
  });
});

describe("stop_agent", () => {
  test("ends the child and the bash command it has running, not a process a finished command left behind, and reports stopped once the child has exited", async () => {
    const { w, pi, ctx } = setup({ script: { default: [{ spawn: "running" }, { spawn: "background" }, { sleep: 30000 }, { reply: "never" }] } });
    const { details } = await pi.call("agent", { description: "long", prompt: "x", run_in_background: true }, ctx);
    await w.until("grandchild", 2);
    const pid = w.invocations()[0].pid;
    const spawned = (as) => w.logged("grandchild").find((r) => r.as === as).pid;

    const result = await pi.call("stop_agent", { id: details.agentId }, ctx);
    expect(JSON.parse(resultText(result)).status).toBe("stopped");
    expect(alive(pid)).toBe(false);
    // The child kills its running command as it exits and does not wait for it.
    await waitFor(() => !alive(spawned("running")));
    expect(alive(spawned("background"))).toBe(true);
    expect((await listAgents(pi, ctx))[0].status).toBe("stopped");
    await waitFor(() => pi.messages.length === 1);
    expect(pi.messages[0].message.content).toContain("status: stopped");
  });

  test("escalates to SIGKILL when the child ignores SIGTERM", async () => {
    // Muted, so the abort cannot end the run and let the child exit before the SIGTERM lands.
    const { w, pi, ctx } = setup({ script: { default: [{ ignoreSigterm: true }, { mute: true }, { sleep: 30000 }] } });
    const { details } = await pi.call("agent", { description: "stubborn", prompt: "x", run_in_background: true }, ctx);
    await w.until("ignoring-sigterm");
    const started = Date.now();
    const result = await pi.call("stop_agent", { id: details.agentId }, ctx);
    expect(JSON.parse(resultText(result)).status).toBe("stopped");
    expect(alive(w.invocations()[0].pid)).toBe(false);
    expect(w.logged("sigterm-ignored")).not.toEqual([]);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  test("sends one SIGTERM and waits the whole kill grace before SIGKILL, even when the exit grace is shorter", async () => {
    const killGraceMs = 700;
    const { w, pi, ctx } = setup({
      script: { default: [{ ignoreSigterm: true }, { mute: true }, { sleep: 30000 }] },
      settings: { killGraceMs, exitGraceMs: 200 },
    });
    const { details } = await pi.call("agent", { description: "stubborn", prompt: "x", run_in_background: true }, ctx);
    await w.until("ignoring-sigterm");
    const started = Date.now();
    await pi.call("stop_agent", { id: details.agentId }, ctx);
    expect(Date.now() - started).toBeGreaterThanOrEqual(killGraceMs - 50);
    expect(alive(w.invocations()[0].pid)).toBe(false);
    expect(w.logged("sigterm-ignored")).toHaveLength(1);
  });

  test("a stop returns once the child has exited, without waiting out the kill grace for a group member that ignores SIGTERM", async () => {
    const killGraceMs = 3000;
    const { w, pi, ctx } = setup({ script: { default: [{ spawn: "deaf" }, { sleep: 30000 }] }, settings: { killGraceMs } });
    const { details } = await pi.call("agent", { description: "x", prompt: "p", run_in_background: true }, ctx);
    await w.until("grandchild");
    // The shell needs a moment to install its trap before the signal lands.
    await sleep(200);
    const started = Date.now();
    const result = await pi.call("stop_agent", { id: details.agentId }, ctx);
    expect(Date.now() - started).toBeLessThan(killGraceMs / 2);
    expect(JSON.parse(resultText(result)).status).toBe("stopped");
    expect(alive(w.invocations()[0].pid)).toBe(false);
    expect(alive(w.logged("grandchild")[0].pid)).toBe(true);
  });

  test("a stopped agent reports its last reply, never pi's stderr diagnostics as its output", async () => {
    const warning = "Warning: No project session found with id 'x'; creating a new session with that id.\n";
    const { w, pi, ctx } = setup({
      script: {
        byPrompt: {
          quiet: [{ stderr: warning }, { sleep: 30000 }],
          chatty: [{ stderr: warning }, { reply: "halfway" }, { sleep: 30000 }],
        },
      },
    });
    const quiet = (await pi.call("agent", { description: "quiet", prompt: "quiet", run_in_background: true }, ctx)).details.agentId;
    const chatty = (await pi.call("agent", { description: "chatty", prompt: "chatty", run_in_background: true }, ctx)).details.agentId;
    await waitFor(() => w.invocations().length === 2 && w.logged("reply").length > 0);
    await pi.call("stop_agent", { id: quiet }, ctx);
    await pi.call("stop_agent", { id: chatty }, ctx);

    const notice = (id) => pi.messages.find((m) => m.message.details.agentId === id).message.content;
    expect(notice(quiet)).toContain("status: stopped");
    expect(notice(quiet)).toContain("stopped before it replied");
    expect(notice(chatty)).toContain("halfway");
    for (const id of [quiet, chatty]) expect(notice(id)).not.toContain("No project session");
    for (const { options } of pi.messages) expect(options).toEqual({ triggerTurn: false });
  });

  test("a stop that lands after the child exited, while a process still holds its pipes, signals nothing", async () => {
    const { w, pi, ctx } = setup({ script: { default: [{ spawn: "holding-pipes" }, { sleep: 300 }, { reply: "ok" }] } });
    const { details } = await pi.call("agent", { description: "x", prompt: "p", run_in_background: true }, ctx);
    await w.until("settled");
    const pid = w.invocations()[0].pid;
    await waitFor(() => !alive(pid));
    const holder = w.logged("grandchild")[0].pid;
    expect(alive(holder)).toBe(true);

    const stopped = await pi.call("stop_agent", { id: details.agentId }, ctx);
    expect(alive(holder)).toBe(true);
    expect(JSON.parse(resultText(stopped)).status).toBe("stopped");
  });

  test("stopping an exited agent reports its final status unchanged", async () => {
    const { pi, ctx } = setup();
    const { details } = await pi.call("agent", { description: "quick", prompt: "x" }, ctx);
    const result = await pi.call("stop_agent", { id: details.agentId }, ctx);
    expect(JSON.parse(resultText(result)).status).toBe("completed");
  });

  test("a foreground agent stops when the tool call is aborted", async () => {
    const { w, pi, ctx } = setup({ script: { default: [{ sleep: 30000 }] } });
    const controller = new AbortController();
    const pending = pi.call("agent", { description: "fg", prompt: "x" }, ctx, controller.signal);
    await w.until("invocation");
    controller.abort();
    const result = await pending;
    expect(result.details.status).toBe("stopped");
    expect(result.isError).toBe(true);
    expect(alive(w.invocations()[0].pid)).toBe(false);
  });
});
