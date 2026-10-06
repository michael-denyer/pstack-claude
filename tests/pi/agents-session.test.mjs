// The agent registry across a session's life: restore from persisted entries,
// shutdown, an abrupt parent exit, and the settle hold of a non-interactive run.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { agentEntry, alive, flag, listAgents, recordWith, restore, sleep, useWorld, waitFor } from "./harness.mjs";

const setup = useWorld();

const exitOf = (proc) => new Promise((r) => proc.on("exit", r));

// A record's pid once another process has it: that one started at another time.
const reusedBy = (proc) => ({ pid: proc.pid, pidStart: "another time" });

describe("registry", () => {
  test("list_agents survives a reload through the persisted entries", async () => {
    const { w, pi, ctx } = setup();
    const { details } = await pi.call("agent", { description: "remember me", prompt: "x", model: "haiku" }, ctx);

    const reloaded = await restore(w, pi.entries, "reload");
    const [listed] = await listAgents(reloaded, ctx);
    expect(listed).toMatchObject({
      id: details.agentId,
      description: "remember me",
      subagent_type: "general-purpose",
      model: "anthropic/fixture-haiku",
      status: "completed",
    });

    await reloaded.call("send_message", { to: details.agentId, message: "again" }, ctx);
    await waitFor(() => reloaded.messages.length === 1);
    const [first, second] = w.invocations();
    expect(flag(second, "--session-id")).toBe(flag(first, "--session-id"));
  });

  test("a restored agent whose process outlived its parent is killed, and an unrelated pid is left alone", async () => {
    const { w, pi, ctx } = setup({ script: { default: [{ spawn: "running" }, { sleep: 30000 }] } });
    await pi.call("agent", { description: "orphan", prompt: "x", run_in_background: true }, ctx);
    await w.until("grandchild");
    const stranger = w.spawn("sleep", ["30"], { detached: true });
    const entries = [...pi.entries, agentEntry(recordWith(pi.entries.at(-1).data, { agent: { id: "astranger" }, ...reusedBy(stranger) }))];

    const resumed = await restore(w, entries);
    await waitFor(() => w.log().every((r) => !alive(r.pid)));
    expect(alive(stranger.pid)).toBe(true);
    expect((await listAgents(resumed, ctx)).map((a) => a.status)).toEqual(["stopped", "stopped"]);
    expect(resumed.entries.map((e) => e.data.status)).toEqual(["stopped", "stopped"]);
  });

  test("a restored record whose pid now leads a dead-leader group of another process is left alone", async () => {
    const { w, pi, ctx } = setup();
    await pi.call("agent", { description: "sound", prompt: "x" }, ctx);
    const leader = w.spawn("sh", ["-c", "sleep 300 & exec sleep 0.1"], { detached: true });
    const parent = w.spawn("sleep", ["0.1"]);
    await Promise.all([exitOf(leader), exitOf(parent)]);
    const member = await new Promise((r) => {
      let out = "";
      const p = w.spawn("pgrep", ["-g", String(leader.pid)], { stdio: ["ignore", "pipe", "ignore"] });
      p.stdout.on("data", (d) => (out += d));
      p.on("exit", () => r(Number(out.trim().split("\n")[0])));
    });
    expect(alive(member)).toBe(true);
    const entries = [...pi.entries, agentEntry(recordWith(pi.entries.at(0).data, { agent: { id: "agroup" }, status: "running", pid: leader.pid, parentPid: parent.pid }))];

    await restore(w, entries);
    await sleep(2 * w.settings.killGraceMs);
    expect(alive(member)).toBe(true);
  });

  test("a persisted record that does not match the schema is dropped at restore, and the rest load", async () => {
    const { w, pi, ctx } = setup();
    const { details } = await pi.call("agent", { description: "sound", prompt: "x" }, ctx);
    const bad = [
      { agent: { id: "anoparent" }, status: "running", pid: 1 },
      { agent: { id: 7 }, status: "completed" },
      recordWith(pi.entries.at(-1).data, { agent: { id: "abadstatus" }, status: "done" }),
      recordWith(pi.entries.at(-1).data, { agent: { id: "anoexit" }, exitCode: "0" }),
      recordWith(pi.entries.at(-1).data, { agent: { id: "anosession", sessionId: "" } }),
      // The shape before identity moved under `agent`.
      (({ agent, ...state }) => ({ ...agent, ...state, id: "aflat" }))(pi.entries.at(-1).data),
      "garbage",
      null,
    ];

    const resumed = await restore(w, [...pi.entries, ...bad.map(agentEntry)]);
    expect((await listAgents(resumed, ctx)).map((a) => a.id)).toEqual([details.agentId]);
    expect(resumed.entries).toEqual([]);
  });

  // The other pi: a second process that starts a background agent and prints
  // the entries a pi process opening the same session would read.
  async function otherPi() {
    const { w, ctx } = setup({ script: { default: [{ spawn: "running" }, { sleep: 30000 }] } });
    const host = w.spawn(process.execPath, [join(import.meta.dir, "host.mjs"), JSON.stringify(w.settings), "stay"], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    let printed = "";
    host.stdout.on("data", (d) => (printed += d));
    await w.until("grandchild");
    await waitFor(() => printed.includes("\n"));
    return { w, ctx, host, entries: JSON.parse(printed) };
  }

  for (const [what, edit, env, status] of [
    ["is left running, untouched", (data) => data, {}, "running"],
    ["is left running on a record an earlier version wrote, which has no start time", ({ pidStart, ...data }) => data, {}, "running"],
    ["is left running when ps cannot be run", (data) => data, { PATH: "/nonexistent" }, "running"],
    ["is stopped, and that process left alone, when it started at another time than the record's", (data) => ({ ...data, pidStart: "another time" }), {}, "stopped"],
  ]) {
    test(`a restored agent whose process is a child of the live pi process that launched it ${what}`, async () => {
      const { w, ctx, entries } = await otherPi();
      const path = process.env.PATH;
      Object.assign(process.env, env);
      const resumed = await restore(w, entries.map((e) => agentEntry(edit(e.data)))).finally(() => (process.env.PATH = path));
      await sleep(500);
      expect(alive(w.invocations()[0].pid)).toBe(true);
      expect((await listAgents(resumed, ctx))[0].status).toBe(status);
      expect(resumed.entries.map((e) => e.data.status)).toEqual(status === "running" ? [] : [status]);
    });
  }

  test("a restored agent whose launching pi process was killed is stopped, and its process and the command it ran are ended", async () => {
    const { w, ctx, host, entries } = await otherPi();
    const exited = exitOf(host);
    host.kill("SIGKILL");
    await exited;
    expect(alive(w.invocations()[0].pid)).toBe(true);

    const resumed = await restore(w, entries);
    await waitFor(() => w.log().every((r) => !alive(r.pid)));
    expect((await listAgents(resumed, ctx))[0].status).toBe("stopped");
  });

  test("a restored agent whose recorded launcher pid now belongs to another live process is stopped, and its process is ended", async () => {
    const { w, pi, ctx } = setup({ script: { default: [{ sleep: 30000 }] } });
    await pi.call("agent", { description: "theirs", prompt: "x", run_in_background: true }, ctx);
    await w.until("invocation");
    const reusedParent = w.spawn("sleep", ["30"], { detached: true });

    const resumed = await restore(w, pi.entries.map((e) => agentEntry(recordWith(e.data, { parentPid: reusedParent.pid }))));
    await waitFor(() => !alive(w.invocations()[0].pid));
    expect((await listAgents(resumed, ctx))[0].status).toBe("stopped");
    expect(alive(reusedParent.pid)).toBe(true);
  });

  test("send_message and stop_agent refuse an agent another live pi process is running, naming that process", async () => {
    const { w, ctx, host: liveParent, entries } = await otherPi();
    const id = entries[0].data.agent.id;

    const resumed = await restore(w, entries);
    const sent = await resumed.call("send_message", { to: id, message: "more" }, ctx).catch((e) => e);
    const stopped = await resumed.call("stop_agent", { id }, ctx).catch((e) => e);
    for (const err of [sent, stopped]) {
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toContain(String(liveParent.pid));
    }
    expect(w.invocations()).toHaveLength(1);
    expect(alive(w.invocations()[0].pid)).toBe(true);
  });

  test("a restored record whose own process is gone, or whose pid now belongs to another process, is stopped though the pid recorded as its launching pi is alive", async () => {
    const { w, pi, ctx } = setup();
    await pi.call("agent", { description: "sound", prompt: "x" }, ctx);
    const reusedParent = w.spawn("sleep", ["300"], { detached: true });
    const stranger = w.spawn("sleep", ["300"], { detached: true });
    const gone = w.spawn("sleep", ["0.1"]);
    await exitOf(gone);
    const entries = Object.entries({ agone: { pid: gone.pid }, areused: reusedBy(stranger) }).map(([id, process]) =>
      agentEntry(recordWith(pi.entries.at(0).data, { agent: { id }, status: "running", ...process, parentPid: reusedParent.pid })),
    );

    const resumed = await restore(w, entries);
    expect((await listAgents(resumed, ctx)).map((a) => [a.id, a.status])).toEqual([["agone", "stopped"], ["areused", "stopped"]]);
    expect(resumed.entries.map((e) => e.data.status)).toEqual(["stopped", "stopped"]);
    expect((await resumed.call("stop_agent", { id: "agone" }, ctx)).details).toEqual({ agentId: "agone", status: "stopped" });
    await sleep(2 * w.settings.killGraceMs);
    expect([reusedParent.pid, stranger.pid].map(alive)).toEqual([true, true]);
  });

  test("session_shutdown stops every running agent without a notice, and a second shutdown is a no-op", async () => {
    const { w, pi, ctx } = setup({ script: { default: [{ spawn: "running" }, { sleep: 30000 }] } });
    await pi.call("agent", { description: "one", prompt: "x", run_in_background: true }, ctx);
    await pi.call("agent", { description: "two", prompt: "x", run_in_background: true }, ctx);
    await w.until("grandchild", 2);

    await pi.emit("session_shutdown", { reason: "quit" }, ctx);
    for (const inv of w.invocations()) expect(alive(inv.pid)).toBe(false);
    // A child kills its running command as it exits and does not wait for it.
    await waitFor(() => w.logged("grandchild").every((r) => !alive(r.pid)));
    expect((await listAgents(pi, ctx)).map((a) => a.status)).toEqual(["stopped", "stopped"]);
    expect(pi.messages).toEqual([]);

    await pi.emit("session_shutdown", { reason: "quit" }, ctx);
    expect(pi.messages).toEqual([]);
  });

  for (const how of ["exit", "SIGINT"]) {
    test(`a print-mode parent that ends by ${how} takes its running agents with it`, async () => {
      const { w } = setup({ script: { default: [{ spawn: "running" }, { sleep: 30000 }] } });
      const host = w.spawn(process.execPath, [join(import.meta.dir, "host.mjs"), JSON.stringify(w.settings), how], {
        stdio: ["ignore", "pipe", "inherit"],
      });
      const exited = exitOf(host);
      await w.until("grandchild");
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
      expect((await listAgents(pi, ctx)).map((a) => a.status)).toEqual(["completed", "completed"]);
    });
  }

  for (const mode of ["tui", "rpc"]) {
    test(`in ${mode} mode the main session's settle does not wait for a running agent`, async () => {
      const { pi, ctx } = setup({ script: { default: [{ sleep: 5000 }] }, ctx: { mode } });
      await pi.call("agent", { description: "long", prompt: "x", run_in_background: true }, ctx);

      expect(await settleLoop(pi, ctx)).toEqual([]);
      expect((await listAgents(pi, ctx))[0].status).toBe("running");
    });
  }

  test("a child agent (rpc, depth 1) holds its settle for its own background agents, since its parent closes stdin once it settles", async () => {
    const { pi, ctx } = setup({ script: { default: [{ sleep: 150 }, { reply: "grandchild done" }] }, settings: { depth: 1 }, ctx: { mode: "rpc" } });
    await pi.call("agent", { description: "g", prompt: "x", run_in_background: true }, ctx);
    const turns = await settleLoop(pi, ctx);
    expect(turns).toHaveLength(1);
    expect(turns[0][0].message.content).toContain("grandchild done");
  });

  test("a message from the parent ends a child's settle hold while its background agent still runs", async () => {
    let pending = false;
    const { pi, ctx } = setup({ script: { default: [{ sleep: 5000 }] }, settings: { depth: 1 }, ctx: { mode: "rpc", pending: () => pending } });
    await pi.call("agent", { description: "long", prompt: "x", run_in_background: true }, ctx);

    let released = false;
    const hold = pi.emit("agent_before_settle", { entries: [], continue: false, outcome: "completed" }, ctx).then(() => (released = true));
    await sleep(300);
    expect(released).toBe(false);
    pending = true;
    await hold;
    expect((await listAgents(pi, ctx))[0].status).toBe("running");
  });
});
