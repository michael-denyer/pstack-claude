import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sessionFile } from "../../plugins/pstack/pi/agents.ts";
import { HcChild, replyIn } from "../../plugins/pstack/pi/hc-child.ts";

const entry = (role, content, extra = {}) => JSON.stringify({ type: "message", id: randomUUID().slice(0, 8), message: { role, content, ...extra } });
const text = (value) => [{ type: "text", text: value }];

function transcript(lines) {
  const file = join(mkdtempSync(join(tmpdir(), "pstack-hc-reply-")), "session.jsonl");
  writeFileSync(file, `${lines.join("\n")}\n`);
  return file;
}

test("the reply is the last assistant text written after the run began", () => {
  const earlier = [JSON.stringify({ type: "session", version: 3 }), entry("user", text("first task")), entry("assistant", text("old answer"), { stopReason: "stop" })];
  const file = transcript([
    ...earlier,
    entry("user", text("second task")),
    entry("assistant", [{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "ls" } }], { stopReason: "toolUse" }),
    entry("toolResult", text("a.txt")),
    entry("assistant", text("new answer"), { stopReason: "stop" }),
    JSON.stringify({ type: "custom", customType: "agent-summary", data: {} }),
  ]);
  const from = Buffer.byteLength(`${earlier.join("\n")}\n`);
  expect(replyIn(file, from)).toEqual({ finalText: "new answer", errorMessage: "" });
  expect(replyIn(file, statSync(file).size)).toEqual({ finalText: "", errorMessage: "" });
});

test("a run that ends on a failed message keeps its earlier text and reports the error", () => {
  const file = transcript([
    entry("assistant", text("partial findings"), { stopReason: "toolUse" }),
    entry("assistant", [], { stopReason: "error", errorMessage: "overloaded" }),
  ]);
  expect(replyIn(file, 0)).toEqual({ finalText: "partial findings", errorMessage: "overloaded" });
  expect(replyIn(undefined, 0)).toEqual({ finalText: "", errorMessage: "" });
});

const LIVE = process.env.PSTACK_PI_HC_LIVE === "1" && Boolean(process.env.HC_TERMINAL_ID);
const MODEL = process.env.PSTACK_PI_HC_MODEL;
const suite = LIVE ? describe : describe.skip;
const MINUTE = 60_000;

suite("HcChild on a live hc core", () => {
  function launch(prompt, env = {}) {
    const root = mkdtempSync(join(tmpdir(), "pstack-hc-live-"));
    const cwd = join(root, "work");
    const identity = { sessionDir: join(root, "agents"), sessionId: randomUUID() };
    mkdirSync(cwd);
    mkdirSync(identity.sessionDir);
    writeFileSync(join(cwd, "a.txt"), "1\n2\n3\n");
    const name = `pstack-test-${identity.sessionId.slice(0, 8)}`;
    const args = ["--session-id", identity.sessionId, "--session-dir", identity.sessionDir, "--model", MODEL, "--thinking", "low", "--exclude-tools", "edit,write"];
    const child = new HcChild(name, "pi", args, { cwd, env, transcript: () => sessionFile(identity) }, prompt);
    return { child, cwd, name };
  }

  const gone = (name) => spawnSync("hc", ["get", "--json", name]).status !== 0;

  test(
    "a run settles on the reply in its transcript, with the parent's variables and without edit tools, and leaves no terminal",
    async () => {
      const { child, cwd, name } = launch("Run `wc -l a.txt` and `echo $PSTACK_HC_PROBE` with bash, then try the write tool on b.txt. Reply with the line count, the echoed word, and whether write existed.", {
        PSTACK_HC_PROBE: "hcprobe42",
      });
      const exit = await child.exited;
      expect(exit.settled).toBe(true);
      expect(exit.errorMessage).toBe("");
      expect(exit.finalText).toContain("3");
      expect(exit.finalText).toContain("hcprobe42");
      expect(existsSync(join(cwd, "b.txt"))).toBe(false);
      expect(gone(name)).toBe(true);
    },
    5 * MINUTE,
  );

  test(
    "end stops a working run and removes its terminal",
    async () => {
      const { child, name } = launch("Run `ping -c 90 127.0.0.1 > /dev/null` with bash and wait for it to finish, then say done.");
      await new Promise((resolve) => setTimeout(resolve, 10_000));
      const started = Date.now();
      child.end();
      const exit = await child.exited;
      expect(exit.settled).toBe(false);
      expect(Date.now() - started).toBeLessThan(MINUTE);
      expect(gone(name)).toBe(true);
    },
    5 * MINUTE,
  );
});
