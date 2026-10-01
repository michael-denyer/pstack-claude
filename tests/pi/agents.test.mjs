// The agent tools driven through a fake ExtensionAPI, with the fake pi as the child.
import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

import { defaultSettings } from "../../plugins/pstack/pi/config.ts";
import { post } from "../../plugins/pstack/pi/inbox.ts";
import { install } from "../../plugins/pstack/pi/index.ts";
import { alive, fakeCtx, fakePi, gitRepo, pluginRoot, sleep, waitFor, world } from "./harness.mjs";

let w;
afterEach(() => w?.cleanup());

// opts.inbox runs the extension as an agent whose parent writes to that mailbox.
function setup(opts = {}) {
  w = world(opts);
  if (opts.inbox) w.settings.inbox = join(w.root, "inbox");
  const pi = fakePi();
  install(pi.api, w.settings);
  return { pi, ctx: fakeCtx({ cwd: w.cwd, ...opts.ctx }) };
}

const text = (result) => result.content.map((c) => c.text).join("");

describe("agent tool", () => {
  test("a tool's prompt snippet does not repeat the name Pi already prints before it", () => {
    const { pi } = setup();
    const snippets = [...pi.tools.values()].filter((t) => t.promptSnippet);
    expect(snippets.map((t) => t.name)).toContain("agent");
    for (const t of snippets) expect(t.promptSnippet.toLowerCase().startsWith(`${t.name}:`)).toBe(false);
  });

  test("every pstack tool is model-only, so Pi declares it to the model in every codemode mode and never defers it", () => {
    const { pi } = setup();
    const exposures = Object.fromEntries([...pi.tools.values()].map((t) => [t.name, t.exposure]));
    expect(exposures).toEqual({
      agent: "model-only",
      send_message: "model-only",
      list_agents: "model-only",
      stop_agent: "model-only",
      ask_user_question: "model-only",
      schedule_wakeup: "model-only",
    });
  });

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
    expect(JSON.parse(text(result))).toEqual({ agentId: id, status: "running" });

    const listed = JSON.parse(text(await pi.call("list_agents", {}, ctx)));
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

  test("readonly runs the child without the edit and write tools", async () => {
    const { pi, ctx } = setup();
    await pi.call("agent", { description: "r", prompt: "x", readonly: true }, ctx);
    await pi.call("agent", { description: "w", prompt: "x" }, ctx);
    const [ro, rw] = w.invocations();
    expect(ro.argv.slice(ro.argv.indexOf("--exclude-tools"))).toEqual(["--exclude-tools", "edit,write"]);
    expect(rw.argv).not.toContain("--exclude-tools");
    expect(pi.tools.get("agent").parameters.properties.readonly.type).toBe("boolean");
  });

  test("agents nest at most three layers below the main session, as on Claude Code", async () => {
    w = world();
    const argvAt = async (depth, params = {}) => {
      const pi = fakePi();
      install(pi.api, { ...w.settings, depth });
      await pi.call("agent", { description: "d", prompt: "x", ...params }, fakeCtx({ cwd: w.cwd }));
      const { argv } = w.invocations().at(-1);
      return argv.includes("--exclude-tools") ? argv[argv.indexOf("--exclude-tools") + 1] : null;
    };
    expect(await argvAt(0)).toBeNull();
    expect(await argvAt(1)).toBeNull();
    expect(await argvAt(2)).toBe("agent");
    expect(await argvAt(2, { readonly: true })).toBe("edit,write,agent");
  });

  test("every pstack agent type reaches its child with its own agent file as the system prompt", async () => {
    const { pi, ctx } = setup();
    const files = {
      "pstack:poteto-agent": "agents/poteto-agent.md",
      "pstack:comment-sicko": "agents/comment-sicko.md",
      "pstack:poteto-agent-high": "effort-agents/poteto-agent-high.md",
      "pstack:effort-low": "effort-agents/effort-low.md",
    };
    for (const type of Object.keys(files)) await pi.call("agent", { description: type, prompt: "x", subagent_type: type }, ctx);
    const prompts = w.invocations().map((inv) => inv.systemPrompt);
    const bodies = Object.values(files).map((f) => readFileSync(join(pluginRoot, f), "utf8").split("---\n").slice(2).join("---\n").trim());
    expect(prompts).toEqual(bodies);
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
    await pi.call("agent", { description: "m", prompt: "x", model: "opus" }, fakeCtx({ cwd: w.cwd, model: null }));
    expect(w.invocations().map(modelOf)).toEqual([
      "anthropic/fixture-opus",
      "openai/sheet-sonnet",
      "anthropic/parent-model",
      "anthropic/parent-model",
      "openai/gpt-x",
      "anthropic/parent-model",
      null,
      "anthropic/fixture-opus",
    ]);
  });

  test("a family name resolves in the table of the parent's provider, and in the fallback table on any other", async () => {
    const { pi } = setup({ sheet: "pi models: haiku=anthropic/sheet-haiku\n" });
    const on = (provider) => fakeCtx({ cwd: w.cwd, model: { provider, id: "parent" } });
    for (const model of ["opus", "fable", "haiku"]) await pi.call("agent", { description: "m", prompt: "x", model }, on("openai-codex"));
    await pi.call("agent", { description: "m", prompt: "x", model: "opus" }, on("openrouter"));
    await pi.call("agent", { description: "m", prompt: "x", model: "opus" }, on("constructor"));
    expect(w.invocations().map(modelOf)).toEqual([
      "openai-codex/fixture-opus",
      "openai-codex/fixture-fable",
      "anthropic/sheet-haiku",
      "anthropic/fixture-opus",
      "anthropic/fixture-opus",
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

  test("a stopped agent reports its last reply, never pi's stderr diagnostics as its output", async () => {
    const warning = "Warning: No project session found with id 'x'; creating a new session with that id.\n";
    const { pi, ctx } = setup({
      script: {
        byPrompt: {
          quiet: [{ stderr: warning }, { sleep: 30000 }],
          chatty: [{ stderr: warning }, { reply: "halfway" }, { sleep: 30000 }],
        },
      },
    });
    const quiet = (await pi.call("agent", { description: "quiet", prompt: "quiet", run_in_background: true }, ctx)).details.agentId;
    const chatty = (await pi.call("agent", { description: "chatty", prompt: "chatty", run_in_background: true }, ctx)).details.agentId;
    await waitFor(() => w.invocations().length === 2);
    await new Promise((r) => setTimeout(r, 300));
    await pi.call("stop_agent", { id: quiet }, ctx);
    await pi.call("stop_agent", { id: chatty }, ctx);

    const notice = (id) => pi.messages.find((m) => m.message.details.agentId === id).message.content;
    expect(notice(quiet)).toContain("status: stopped");
    expect(notice(quiet)).toContain("stopped before it replied");
    expect(notice(chatty)).toContain("halfway");
    for (const id of [quiet, chatty]) expect(notice(id)).not.toContain("No project session");
    for (const { options } of pi.messages) expect(options).toEqual({ triggerTurn: false });
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
    expect(pi.messages[0].options).toEqual({ triggerTurn: true, deliverAs: "steer" });
    expect(pi.messages[0].message.content).toContain("seen: first task; now: follow up");
    expect(pi.messages[0].message.content).toContain(`agentId: ${first.details.agentId}`);
  });

  test("a message to a running agent reaches that run before it exits, and the agent reports once", async () => {
    const { pi, ctx } = setup({
      script: { byPrompt: { slow: [{ awaitMessage: 3000 }, { reply: "slow done, told: ${steered}" }] } },
    });
    const { details } = await pi.call("agent", { description: "worker", prompt: "slow", run_in_background: true }, ctx);
    await waitFor(() => w.invocations().length === 1);
    const sent = await pi.call("send_message", { to: "worker", message: "change course" }, ctx);
    expect(sent.details).toEqual({ agentId: details.agentId, running: true });
    expect(text(sent)).toContain("after its current tool calls");

    await waitFor(() => pi.messages.length === 1);
    const [run] = w.invocations();
    expect(w.log().filter((r) => r.kind === "steered")).toEqual([{ kind: "steered", text: "change course", pid: run.pid }]);
    expect(pi.messages[0].message.content).toContain("slow done, told: change course");
    await sleep(300);
    expect(pi.messages).toHaveLength(1);
    expect(w.invocations()).toHaveLength(1);
  });

  test("a message the running agent never reads resumes it after it exits", async () => {
    const { pi, ctx } = setup({
      script: { byPrompt: { slow: [{ deaf: true }, { sleep: 400 }, { reply: "slow done" }] }, default: [{ reply: "got ${prompt}" }] },
    });
    const { details } = await pi.call("agent", { description: "worker", prompt: "slow", run_in_background: true }, ctx);
    const sent = await pi.call("send_message", { to: details.agentId, message: "more" }, ctx);
    expect(sent.details.running).toBe(true);

    await waitFor(() => pi.messages.length === 2);
    expect(pi.messages[0].message.content).toContain("slow done");
    expect(pi.messages[1].message.content).toContain("got more");
    expect(w.invocations().map((i) => i.prompt)).toEqual(["slow", "more"]);
  });

  test("stopping an agent discards a message it never read", async () => {
    const { pi, ctx } = setup({ script: { default: [{ deaf: true }, { sleep: 5000 }] } });
    const { details } = await pi.call("agent", { description: "worker", prompt: "x", run_in_background: true }, ctx);
    await waitFor(() => w.invocations().length === 1);
    await pi.call("send_message", { to: details.agentId, message: "never read" }, ctx);
    await pi.call("stop_agent", { id: details.agentId }, ctx);
    await sleep(300);
    expect(w.invocations()).toHaveLength(1);
    expect(pi.messages.map((m) => m.message.details.status)).toEqual(["stopped"]);
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

  test("a queued resume whose worktree cannot be re-created fails with a notice", async () => {
    const { pi, ctx } = setup({ script: { byPrompt: { first: [{ deaf: true }, { sleep: 400 }, { reply: "ok" }] } } });
    gitRepo(w.cwd);
    const id = (await pi.call("agent", { description: "w", prompt: "first", isolation: "worktree", run_in_background: true }, ctx))
      .details.agentId;
    await waitFor(() => w.invocations().length === 1);
    await pi.call("send_message", { to: id, message: "again" }, ctx);
    rmSync(w.invocations()[0].cwd, { recursive: true, force: true });

    await waitFor(() => pi.messages.length === 2);
    expect(pi.messages[1].message.details.status).toBe("failed");
    expect(pi.messages[1].message.content).toContain("git worktree add");
    expect(w.invocations()).toHaveLength(1);
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

  test("a restored agent whose process outlived its parent is killed, and an unrelated pid is left alone", async () => {
    const { pi, ctx } = setup({ script: { default: [{ grandchild: true }, { sleep: 30000 }] } });
    await pi.call("agent", { description: "orphan", prompt: "x", run_in_background: true }, ctx);
    await waitFor(() => w.log().some((r) => r.kind === "grandchild"));
    const stranger = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
    const entries = [
      ...pi.entries,
      { type: "custom", customType: "pstack-agents", data: { ...pi.entries.at(-1).data, id: "astranger", pid: stranger.pid } },
    ];

    const resumed = fakePi();
    install(resumed.api, w.settings);
    await resumed.emit("session_start", { reason: "resume" }, fakeCtx({ cwd: w.cwd, entries }));
    try {
      await waitFor(() => w.log().every((r) => !alive(r.pid)));
      expect(alive(stranger.pid)).toBe(true);
      const listed = JSON.parse(text(await resumed.call("list_agents", {}, ctx)));
      expect(listed.map((a) => a.status)).toEqual(["stopped", "stopped"]);
    } finally {
      stranger.kill("SIGKILL");
    }
  });

  for (const how of ["exit", "SIGINT"]) {
    test(`a print-mode parent that ends by ${how} takes its running agents with it`, async () => {
      w = world({ script: { default: [{ grandchild: true }, { sleep: 30000 }] } });
      const host = spawn(process.execPath, [join(import.meta.dir, "host.mjs"), JSON.stringify(w.settings), how], {
        stdio: ["ignore", "pipe", "inherit"],
      });
      const exited = new Promise((r) => host.on("exit", r));
      await waitFor(() => w.log().some((r) => r.kind === "grandchild"));
      if (how === "SIGINT") host.kill("SIGINT");
      await exited;
      await waitFor(() => w.log().every((r) => !alive(r.pid)));
      expect(w.log().length).toBeGreaterThan(1);
    });
  }
});

// Plays Pi's settle loop: a follow-up queued during agent_before_settle starts
// another turn, and a settle that queues nothing ends the run.
async function settleLoop(pi, ctx) {
  const turns = [];
  for (let i = 0; i < 5; i++) {
    const before = pi.messages.length;
    await pi.emit("agent_before_settle", { entries: [], continue: false, outcome: "completed" }, ctx);
    const queued = pi.messages.slice(before);
    if (!queued.length) return turns;
    turns.push(queued);
  }
  throw new Error("settle never ended");
}

describe("non-interactive settle", () => {
  for (const mode of ["json", "print"]) {
    test(`in ${mode} mode the run settles only after every background agent's notice has run as a turn`, async () => {
      const { pi, ctx } = setup({
        script: { byPrompt: { fast: [{ sleep: 150 }, { reply: "fast done" }], slow: [{ sleep: 700 }, { reply: "slow done" }] } },
        ctx: { mode },
      });
      const fast = (await pi.call("agent", { description: "fast", prompt: "fast", run_in_background: true }, ctx)).details.agentId;
      const slow = (await pi.call("agent", { description: "slow", prompt: "slow", run_in_background: true }, ctx)).details.agentId;

      const turns = await settleLoop(pi, ctx);

      expect(turns.map((t) => t.map(({ message }) => message.details.agentId))).toEqual([[fast], [slow]]);
      for (const [{ message, options }] of turns) {
        expect(message.customType).toBe("pstack-agent");
        expect(options).toEqual({ triggerTurn: true, deliverAs: "steer" });
      }
      expect(turns[1][0].message.content).toContain("slow done");
      const listed = JSON.parse(text(await pi.call("list_agents", {}, ctx)));
      expect(listed.map((a) => a.status)).toEqual(["completed", "completed"]);
    });
  }

  for (const mode of ["tui", "rpc"]) {
    test(`in ${mode} mode the settle does not wait for a running agent`, async () => {
      const { pi, ctx } = setup({ script: { default: [{ sleep: 5000 }] }, ctx: { mode } });
      await pi.call("agent", { description: "long", prompt: "x", run_in_background: true }, ctx);

      expect(await settleLoop(pi, ctx)).toEqual([]);
      expect(JSON.parse(text(await pi.call("list_agents", {}, ctx)))[0].status).toBe("running");
      await pi.emit("session_shutdown", {}, ctx);
    });
  }
});

describe("an agent's mailbox", () => {
  test("a streaming run takes its parent's message as a steer; an idle session leaves it for the parent", async () => {
    let idle = true;
    const { pi, ctx } = setup({ inbox: true, ctx: { mode: "json", idle: () => idle } });
    ctx.hasPendingMessages = () => pi.userMessages.length > 0;
    await pi.emit("session_start", { reason: "startup" }, ctx);
    post(w.settings.inbox, "while idle");
    await sleep(500);
    expect(pi.userMessages).toEqual([]);

    idle = false;
    post(w.settings.inbox, "while streaming");
    await waitFor(() => pi.userMessages.length === 2);
    expect(pi.userMessages).toEqual([
      { content: "while idle", options: { deliverAs: "steer" } },
      { content: "while streaming", options: { deliverAs: "steer" } },
    ]);
    await pi.emit("session_shutdown", {}, ctx);
  });

  test("in json mode a message ends the settle hold while a background agent still runs", async () => {
    const { pi, ctx } = setup({ inbox: true, script: { default: [{ sleep: 5000 }] }, ctx: { mode: "json", idle: false } });
    ctx.hasPendingMessages = () => pi.userMessages.length > 0;
    await pi.emit("session_start", { reason: "startup" }, ctx);
    await pi.call("agent", { description: "long", prompt: "x", run_in_background: true }, ctx);

    let released = false;
    const hold = pi.emit("agent_before_settle", { entries: [], continue: false, outcome: "completed" }, ctx).then(() => (released = true));
    await sleep(400);
    expect(released).toBe(false);
    post(w.settings.inbox, "new direction");
    await hold;
    expect(pi.userMessages).toEqual([{ content: "new direction", options: { deliverAs: "steer" } }]);
    expect(JSON.parse(text(await pi.call("list_agents", {}, ctx)))[0].status).toBe("running");
    await pi.emit("session_shutdown", {}, ctx);
  });

  test("a message waiting when the run reaches its settle is taken there", async () => {
    const { pi, ctx } = setup({ inbox: true, ctx: { mode: "json", idle: false } });
    ctx.hasPendingMessages = () => pi.userMessages.length > 0;
    post(w.settings.inbox, "last word");
    await pi.emit("agent_before_settle", { entries: [], continue: false, outcome: "completed" }, ctx);
    expect(pi.userMessages).toEqual([{ content: "last word", options: { deliverAs: "steer" } }]);
  });

  test("an agent's own children get their own mailbox, never the agent's", async () => {
    const settings = defaultSettings({ PATH: "/bin", PSTACK_PI_DEPTH: "1", PSTACK_PI_INBOX: "/parent/inbox" });
    expect(settings.inbox).toBe("/parent/inbox");
    expect(settings.childEnv).toEqual({ PATH: "/bin", PSTACK_PI_DEPTH: "2" });

    const { pi, ctx } = setup({ inbox: true });
    const { details } = await pi.call("agent", { description: "grandchild", prompt: "x" }, ctx);
    const [inv] = w.invocations();
    expect(inv.inbox).toBe(join(w.agentDir, "pstack", "parent-session", "agents", `${details.agentId}.inbox`));
  });
});
