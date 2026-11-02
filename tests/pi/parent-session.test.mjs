// The session a child's permission asks are relayed to: @gotgenes/pi-permission-system
// 42.0.0 reads PI_SUBAGENT_PARENT_SESSION in the child, and forwards an ask to that
// session's inbox only while that session has a UI and serves it.
import { describe, expect, test } from "bun:test";

import { install } from "../../plugins/pstack/pi/index.ts";
import { fakeCtx, fakePi, restore, useWorld, waitFor } from "./harness.mjs";

const setup = useWorld();
const ENV = "PI_SUBAGENT_PARENT_SESSION";

describe("parent session for children", () => {
  test("a child gets the starting session's id in PI_SUBAGENT_PARENT_SESSION, and its other environment is inherited", async () => {
    const { w, pi, ctx } = setup();
    await pi.call("agent", { description: "a", prompt: "x" }, ctx);
    await pi.call("agent", { description: "b", prompt: "x", subagent_type: "pstack:poteto-agent" }, ctx);
    expect(w.invocations().map((inv) => inv.parentSession)).toEqual(["parent-session", "parent-session"]);
    expect(w.invocations().every((inv) => inv.path === process.env.PATH)).toBe(true);
  });

  test("a child that is itself a parent names its own session, not the one that started it", async () => {
    const { w } = setup();
    const before = process.env[ENV];
    process.env[ENV] = "root-session";
    try {
      const middle = fakePi();
      install(middle.api, { ...w.settings, depth: 1 });
      const ctx = fakeCtx({ cwd: w.cwd });
      ctx.sessionManager = { getSessionId: () => "middle-session", getEntries: () => [] };
      await middle.call("agent", { description: "grandchild", prompt: "x" }, ctx);
    } finally {
      if (before === undefined) delete process.env[ENV];
      else process.env[ENV] = before;
    }
    expect(w.invocations().map((inv) => inv.parentSession)).toEqual(["middle-session"]);
  });

  test("a message that resumes a finished agent after a reload still names the session", async () => {
    const { w, pi, ctx } = setup();
    await pi.call("agent", { description: "a", prompt: "first" }, ctx);
    // The reloaded runner has started no agent, so only its session_start can have told it the id.
    const reloaded = await restore(w, pi.entries, "reload");
    await reloaded.call("send_message", { to: "a", message: "again" }, ctx);
    await waitFor(() => w.invocations().length === 2);
    expect(w.invocations().map((inv) => inv.parentSession)).toEqual(["parent-session", "parent-session"]);
  });
});
