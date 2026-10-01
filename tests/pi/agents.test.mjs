// The agent tools driven through a fake ExtensionAPI, with the fake pi as the child.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { install } from "../../plugins/pstack/pi/index.ts";
import { alive, fakeCtx, fakePi, gitRepo, pluginRoot, waitFor, world } from "./harness.mjs";

let w;
afterEach(() => w?.cleanup());

function setup(opts = {}) {
  w = world(opts);
  const pi = fakePi();
  install(pi.api, w.settings);
  return { pi, ctx: fakeCtx({ cwd: w.cwd, ...opts.ctx }) };
}

const text = (result) => result.content.map((c) => c.text).join("");

describe("agent tool", () => {
  test("foreground waits, returns the final text and agentId, and runs the exact child command", async () => {
    const { pi, ctx } = setup({ script: { default: [{ reply: "draft" }, { reply: "final answer" }] } });
    const result = await pi.call("agent", { description: "write it", prompt: "-do it" }, ctx);

    const [inv] = w.invocations();
    const id = result.details.agentId;
    expect(text(result)).toContain(`agentId: ${id}`);
    expect(text(result)).toContain("final answer");
    expect(text(result)).not.toContain("draft");
    expect(result.details.status).toBe("completed");
    expect(inv.argv).toEqual([
      "--mode", "json", "-p",
      "--session-id", inv.argv[4],
      "--session-dir", join(w.agentDir, "pstack", "parent-session", "agents"),
      "--model", "anthropic/parent-model",
      "--thinking", "medium",
    ]);
    expect(inv.prompt).toBe("-do it");
    expect(inv.argv[4]).toMatch(/^[0-9a-f-]{36}$/);
    expect(inv.cwd).toBe(w.cwd);
    expect(inv.child).toBe("1");
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
    expect(JSON.parse(text(result))).toEqual({ agentId: id, status: "running" });

    const listed = JSON.parse(text(await pi.call("list_agents", {}, ctx)));
    expect(listed[0]).toMatchObject({ id, status: "running", description: "bg job" });
    expect(alive(listed[0].pid)).toBe(true);
    expect(pi.messages).toEqual([]);

    await waitFor(() => pi.messages.length === 1);
    const [{ message, options }] = pi.messages;
    expect(options).toEqual({ triggerTurn: true, deliverAs: "followUp" });
    expect(message.customType).toBe("pstack-agent");
    expect(message.display).toBe(true);
    expect(message.content).toContain(`agentId: ${id}`);
    expect(message.content).toContain("status: completed");
    expect(message.content).toContain("exit code: 0");
    expect(message.content).toContain("done in bg");
    expect(aliveAtNotice).toBe(false);
    expect(JSON.parse(text(await pi.call("list_agents", {}, ctx)))[0].status).toBe("completed");
  });

  test("a non-zero exit or a run without a final message is failed, with the error in the notice", async () => {
    const { pi, ctx } = setup({
      script: {
        byPrompt: {
          crash: [{ error: "provider exploded" }],
          silent: [],
        },
      },
    });
    await pi.call("agent", { description: "a", prompt: "crash", run_in_background: true }, ctx);
    await pi.call("agent", { description: "b", prompt: "silent", run_in_background: true }, ctx);
    await waitFor(() => pi.messages.length === 2);
    const byDesc = Object.fromEntries(pi.messages.map(({ message }) => [message.content.match(/description: (\w)/)[1], message]));
    expect(byDesc.a.content).toContain("status: failed");
    expect(byDesc.a.content).toContain("exit code: 1");
    expect(byDesc.a.content).toContain("provider exploded");
    expect(byDesc.b.content).toContain("status: failed");
    expect(byDesc.b.content).toContain("exit code: 0");
  });

  test("final text survives U+2028 inside a JSON string", async () => {
    const { pi, ctx } = setup({ script: { default: [{ reply: "line one\u2028line two" }] } });
    const result = await pi.call("agent", { description: "sep", prompt: "x" }, ctx);
    expect(text(result)).toContain("line one\u2028line two");
    expect(result.details.status).toBe("completed");
  });

  test("output over 50 KB is truncated in the notice and kept in full on disk", async () => {
    const big = "é".repeat(40 * 1024);
    const { pi, ctx } = setup({ script: { default: [{ reply: big }] } });
    await pi.call("agent", { description: "big", prompt: "x", run_in_background: true }, ctx);
    await waitFor(() => pi.messages.length === 1);
    const { content, details } = pi.messages[0].message;
    expect(details.outputFile).toBe(join(w.agentDir, "pstack", "parent-session", "agents", `${details.agentId}.out.md`));
    expect(content).toContain(`full output: ${details.outputFile}`);
    expect(Buffer.byteLength(content)).toBeLessThan(51 * 1024);
    expect(content).not.toContain("�");
    expect(readFileSync(details.outputFile, "utf8")).toBe(big);
  });

  test("unknown subagent_type is an error listing every valid type", async () => {
    const { pi, ctx } = setup();
    const err = await pi.call("agent", { description: "x", prompt: "x", subagent_type: "poteto-agent" }, ctx).catch((e) => e);
    expect(err.message).toContain('Unknown subagent_type "poteto-agent"');
    for (const t of ["general-purpose", "pstack:poteto-agent", "pstack:comment-sicko", "pstack:effort-high", "pstack:poteto-agent-xhigh"]) {
      expect(err.message).toContain(t);
    }
    expect(w.invocations()).toEqual([]);
  });

  test("an effort agent passes its body as a 0600 system prompt file and its effort as --thinking; others run at the parent's level", async () => {
    const { pi, ctx } = setup();
    await pi.call("agent", { description: "e", prompt: "x", subagent_type: "pstack:effort-xhigh" }, ctx);
    await pi.call("agent", { description: "g", prompt: "x", subagent_type: "general-purpose" }, ctx);
    const [effort, general] = w.invocations();

    const body = readFileSync(join(pluginRoot, "effort-agents/effort-xhigh.md"), "utf8").split("---\n").slice(2).join("---\n").trim();
    expect(effort.argv[effort.argv.indexOf("--thinking") + 1]).toBe("xhigh");
    const file = effort.argv[effort.argv.indexOf("--append-system-prompt") + 1];
    expect(effort.systemPrompt).toBe(body);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(general.argv[general.argv.indexOf("--thinking") + 1]).toBe("medium");
    expect(general.argv).not.toContain("--append-system-prompt");
  });
});

describe("model resolution", () => {
  const modelOf = (inv) => (inv.argv.includes("--model") ? inv.argv[inv.argv.indexOf("--model") + 1] : null);

  test("alias, sheet override, inherit-parent, auto, pass-through, and no parent model", async () => {
    const { pi, ctx } = setup({ sheet: "default effort: session\npi models: sonnet=openai/sheet-sonnet, haiku=openai/sheet-haiku\n" });
    for (const model of ["opus", "sonnet", "inherit-parent", "auto", "openai/gpt-x", undefined]) {
      await pi.call("agent", { description: "m", prompt: "x", model }, ctx);
    }
    await pi.call("agent", { description: "m", prompt: "x" }, fakeCtx({ cwd: w.cwd, model: null }));
    expect(w.invocations().map(modelOf)).toEqual([
      "anthropic/fixture-opus",
      "openai/sheet-sonnet",
      "anthropic/parent-model",
      "anthropic/parent-model",
      "openai/gpt-x",
      "anthropic/parent-model",
      null,
    ]);
  });

  test("an unknown alias is an error naming the valid values", async () => {
    const { pi, ctx } = setup();
    const err = await pi.call("agent", { description: "m", prompt: "x", model: "opus @xhigh" }, ctx).catch((e) => e);
    expect(err.message).toContain('Unknown model "opus @xhigh"');
    expect(err.message).toContain("opus, fable, sonnet, haiku, inherit-parent, auto");
    expect(w.invocations()).toEqual([]);
  });
});

describe("stop_agent", () => {
  test("kills the process group and reports stopped only once the process has exited", async () => {
    const { pi, ctx } = setup({ script: { default: [{ grandchild: true }, { sleep: 30000 }, { reply: "never" }] } });
    const { details } = await pi.call("agent", { description: "long", prompt: "x", run_in_background: true }, ctx);
    await waitFor(() => w.log().some((r) => r.kind === "grandchild"));
    const pid = w.invocations()[0].pid;
    const grandchild = w.log().find((r) => r.kind === "grandchild").pid;

    const result = await pi.call("stop_agent", { id: details.agentId }, ctx);
    expect(JSON.parse(text(result)).status).toBe("stopped");
    expect(alive(pid)).toBe(false);
    expect(alive(grandchild)).toBe(false);
    expect(JSON.parse(text(await pi.call("list_agents", {}, ctx)))[0].status).toBe("stopped");
    await waitFor(() => pi.messages.length === 1);
    expect(pi.messages[0].message.content).toContain("status: stopped");
  });

  test("escalates to SIGKILL when the child ignores SIGTERM", async () => {
    const { pi, ctx } = setup({ script: { default: [{ ignoreSigterm: true }, { sleep: 30000 }] } });
    const { details } = await pi.call("agent", { description: "stubborn", prompt: "x", run_in_background: true }, ctx);
    await waitFor(() => w.invocations().length === 1);
    await new Promise((r) => setTimeout(r, 100));
    const started = Date.now();
    const result = await pi.call("stop_agent", { id: details.agentId }, ctx);
    expect(JSON.parse(text(result)).status).toBe("stopped");
    expect(alive(w.invocations()[0].pid)).toBe(false);
    expect(w.log().some((r) => r.kind === "sigterm-ignored")).toBe(true);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  test("stopping an exited agent reports its final status unchanged", async () => {
    const { pi, ctx } = setup();
    const { details } = await pi.call("agent", { description: "quick", prompt: "x" }, ctx);
    const result = await pi.call("stop_agent", { id: details.agentId }, ctx);
    expect(JSON.parse(text(result)).status).toBe("completed");
  });

  test("a foreground agent stops when the tool call is aborted", async () => {
    const { pi, ctx } = setup({ script: { default: [{ sleep: 30000 }] } });
    const controller = new AbortController();
    const pending = pi.call("agent", { description: "fg", prompt: "x" }, ctx, controller.signal);
    await waitFor(() => w.invocations().length === 1);
    controller.abort();
    const result = await pending;
    expect(result.details.status).toBe("stopped");
    expect(result.isError).toBe(true);
    expect(alive(w.invocations()[0].pid)).toBe(false);
  });
});

describe("send_message", () => {
  test("resumes a finished agent in the same session, model, and thinking, in the background", async () => {
    const { pi, ctx } = setup({ script: { default: [{ reply: "seen: ${history}; now: ${prompt}" }] } });
    const first = await pi.call(
      "agent",
      { description: "reviewer", prompt: "first task", subagent_type: "pstack:effort-high", model: "fable" },
      ctx,
    );
    const sent = await pi.call("send_message", { to: "reviewer", message: "follow up" }, ctx);
    expect(JSON.parse(text(sent))).toEqual({ agentId: first.details.agentId, status: "running" });
    await waitFor(() => pi.messages.length === 1);

    const [a, b] = w.invocations();
    expect(b.argv).toEqual(a.argv);
    expect(b.prompt).toBe("follow up");
    expect(pi.messages[0].options).toEqual({ triggerTurn: true, deliverAs: "followUp" });
    expect(pi.messages[0].message.content).toContain("seen: first task; now: follow up");
    expect(pi.messages[0].message.content).toContain(`agentId: ${first.details.agentId}`);
  });

  test("a message to a running agent queues and resumes it after it exits", async () => {
    const { pi, ctx } = setup({
      script: { byPrompt: { slow: [{ sleep: 400 }, { reply: "slow done" }] }, default: [{ reply: "got ${prompt}" }] },
    });
    const { details } = await pi.call("agent", { description: "worker", prompt: "slow", run_in_background: true }, ctx);
    const sent = await pi.call("send_message", { to: details.agentId, message: "more" }, ctx);
    expect(sent.details.queued).toBe(true);

    await waitFor(() => pi.messages.length === 2);
    expect(pi.messages[0].message.content).toContain("slow done");
    expect(pi.messages[1].message.content).toContain("got more");
    expect(w.invocations().map((i) => i.prompt)).toEqual(["slow", "more"]);
  });

  test("an unknown recipient is an error naming the known agents", async () => {
    const { pi, ctx } = setup();
    const { details } = await pi.call("agent", { description: "known one", prompt: "x" }, ctx);
    const err = await pi.call("send_message", { to: "nobody", message: "hi" }, ctx).catch((e) => e);
    expect(err.message).toContain(`${details.agentId} (known one)`);
  });
});

describe("worktree isolation", () => {
  test("runs in its own worktree and removes it when the agent changed nothing", async () => {
    const { pi, ctx } = setup();
    const git = gitRepo(w.cwd);
    const result = await pi.call("agent", { description: "w", prompt: "x", isolation: "worktree" }, ctx);
    const id = result.details.agentId;
    const path = join(w.cwd, ".claude", "worktrees", `agent-${id}`);
    expect(w.invocations()[0].cwd).toBe(path);
    expect(text(result)).toContain("no changes; removed");
    expect(existsSync(path)).toBe(false);
    expect(git("branch", "--list", `worktree-agent-${id}`)).toBe("");
  });

  test("keeps a worktree with changes and reports its path and branch", async () => {
    const { pi, ctx } = setup({ script: { default: [{ touch: "new-file" }, { reply: "wrote" }] } });
    const git = gitRepo(w.cwd);
    const result = await pi.call("agent", { description: "w", prompt: "x", isolation: "worktree" }, ctx);
    const id = result.details.agentId;
    const path = join(w.cwd, ".claude", "worktrees", `agent-${id}`);
    expect(text(result)).toContain(`worktree: ${path} (branch worktree-agent-${id})`);
    expect(existsSync(join(path, "new-file"))).toBe(true);
    expect(git("branch", "--list", `worktree-agent-${id}`)).toContain(`worktree-agent-${id}`);
  });

  test("outside a git repo it is an error and nothing runs", async () => {
    const { pi, ctx } = setup();
    mkdirSync(join(w.cwd, "sub"));
    const err = await pi.call("agent", { description: "w", prompt: "x", isolation: "worktree" }, { ...ctx, cwd: join(w.cwd, "sub") }).catch((e) => e);
    expect(err.message).toContain("git rev-parse");
    expect(w.invocations()).toEqual([]);
  });
});

describe("registry", () => {
  test("list_agents survives a reload through the persisted entries", async () => {
    const { pi, ctx } = setup();
    const { details } = await pi.call("agent", { description: "remember me", prompt: "x", model: "haiku" }, ctx);

    const reloaded = fakePi();
    install(reloaded.api, w.settings);
    await reloaded.emit("session_start", { reason: "reload" }, fakeCtx({ cwd: w.cwd, entries: pi.entries }));
    const [listed] = JSON.parse(text(await reloaded.call("list_agents", {}, ctx)));
    expect(listed).toMatchObject({
      id: details.agentId,
      description: "remember me",
      subagent_type: "general-purpose",
      model: "anthropic/fixture-haiku",
      status: "completed",
    });

    await reloaded.call("send_message", { to: details.agentId, message: "again" }, ctx);
    await waitFor(() => reloaded.messages.length === 1);
    expect(w.invocations()[1].argv[4]).toBe(w.invocations()[0].argv[4]);
  });
});
