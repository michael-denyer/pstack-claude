import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import register from "../plugins/pstack/hooks/pi-session-start.ts";

const pluginRoot = fileURLToPath(new URL("../plugins/pstack/", import.meta.url));
const mandate = readFileSync(join(pluginRoot, "hooks/session-start-context.md"), "utf8");
const piMandate = mandate.replace(/`pstack:/g, "`");

function makeEvent(existing) {
  return {
    systemPromptOptions: {
      appendSystemPrompt: existing ?? "",
    },
  };
}

// Runs the command for real so the chain from the extension through env and
// session-start.sh to sed is exercised end to end.
function realExecStub() {
  return {
    exec(cmd, args) {
      const r = spawnSync(cmd, args, { encoding: "utf8" });
      return Promise.resolve({
        stdout: r.stdout,
        stderr: r.stderr,
        code: r.status ?? 1,
        killed: r.signal !== null,
      });
    },
  };
}

function plainStub({ stdout = "", stderr = "", code = 0, killed = false } = {}) {
  return {
    exec() {
      return Promise.resolve({ stdout, stderr, code, killed });
    },
  };
}

function stubPi(execImpl) {
  const handlers = {};
  return {
    pi: {
      on(event, handler) {
        handlers[event] = handler;
      },
      ...execImpl,
    },
    handlers,
  };
}

describe("pi extension", () => {
  let tmp;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "pi-ext-"));
    process.env.PI_CODING_AGENT_DIR = tmp;
  });

  afterEach(() => {
    delete process.env.PI_CODING_AGENT_DIR;
    rmSync(tmp, { recursive: true, force: true });
  });

  test("appends stripped mandate when no sheet exists", async () => {
    const { pi, handlers } = stubPi(realExecStub());
    register(pi);

    const event = makeEvent();
    await handlers.before_agent_start(event);
    expect(event.systemPromptOptions.appendSystemPrompt).toBe(piMandate);
  });

  test("appends only sheet body when session hook is off", async () => {
    const sheetBody = "bug-fix: fable\nsession hook: off\n";
    writeFileSync(join(tmp, "pstack-models.md"), sheetBody);

    const { pi, handlers } = stubPi(realExecStub());
    register(pi);

    const event = makeEvent();
    await handlers.before_agent_start(event);
    expect(event.systemPromptOptions.appendSystemPrompt).toBe(sheetBody);
  });

  test("appends mandate and sheet body when session hook is on", async () => {
    const sheetBody = "bug-fix: fable\nsession hook: on\n";
    writeFileSync(join(tmp, "pstack-models.md"), sheetBody);

    const { pi, handlers } = stubPi(realExecStub());
    register(pi);

    const event = makeEvent();
    await handlers.before_agent_start(event);
    expect(event.systemPromptOptions.appendSystemPrompt).toBe(
      piMandate + "\n\n" + sheetBody,
    );
  });

  test("preserves existing appendSystemPrompt content", async () => {
    const { pi, handlers } = stubPi(plainStub({ stdout: piMandate }));
    register(pi);

    const existing = "pre-existing system prompt content";
    const event = makeEvent(existing);
    await handlers.before_agent_start(event);
    expect(event.systemPromptOptions.appendSystemPrompt).toStartWith(existing);
    expect(event.systemPromptOptions.appendSystemPrompt).toContain(piMandate);
  });

  test("throws on non-zero exit from the script", async () => {
    const { pi, handlers } = stubPi(plainStub({ stderr: "some error", code: 2 }));
    register(pi);

    const event = makeEvent();
    await expect(handlers.before_agent_start(event)).rejects.toThrow("some error");
  });
});
