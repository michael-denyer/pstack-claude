// The sleep rule as a table: each row is a command line and whether it blocks.
// The last two groups are the rule's known misses and over-blocks; a row that
// moves between groups is a decision, not a drift.
import { expect, test } from "bun:test";

import { isForegroundWait } from "../../plugins/pstack/pi/sleep-wait.ts";
import { useWorld, waitFor } from "./harness.mjs";

const setup = useWorld();

const waits = [
  "sleep 20", "  sleep 2.5 && ls", "npm test; sleep 30", "sleep 5 && gh pr checks 1", "(sleep 30; ls)", "ls\nsleep 10", "sleep 1m", "sleep 2s",
  "until gh pr checks 1; do sleep 30; done", "while true; do sleep 5; done", "for i in 1 2 3; do sleep 10; done", "if ! ready; then sleep 30; fi",
  "env sleep 30", "command sleep 30", "/bin/sleep 30", "time sleep 30", "nohup sleep 30", "FOO=1 sleep 30", "sudo sleep 30",
  "sleep infinity", "sleep 1m30s", "echo $(sleep 30)", "{ sleep 30; }", "! sleep 30", "sleep 30|cat", "sleep 3 || true", "sleep 30 2>&1",
  "\tsleep 30", "sleep 30;", "tail -f log & sleep 30 ; kill %1", "sleep 30 && echo done", "sleep 30 &&\nls",
  "# don't poll\nsleep 30\necho 'done'", "cat <<EOF && sleep 30\nbody\nEOF", "sleep 30 &>/dev/null", "sleep 30 & sleep 30",
];

const notWaits = [
  "sleep 1", "sleep 1.9", "sleep 30 &", "(sleep 30 &)", "sleep 30 & echo started", "sleep 30 &\nwait",
  "grep sleep src", 'echo "sleep 30"', 'echo "x; sleep 30; y"', "echo 'sleep 30'", "./sleep-test.sh 30", "gsleep 30", "sleep", "wait",
  "cat <<EOF > a.sh\nsleep 30\nEOF", "cat <<'EOF'\nsleep 30\nEOF", "ls # then; sleep 30", "sleep 1 && sleep 1", "sleep 30&", "sleep 30 & sleep 1",
  "echo \"it's\" # sleep 30", "cat <<EOF\nsleep 30\nEOF\necho 'ok'",
];

// Documented misses: the shell would wait, the rule lets it through.
const knownMisses = ["bash -c 'sleep 30'", 'sh -c "sleep 30"', "sleep $N", "while true; do sleep 1; done", "eval 'sleep 30'", 'sleep "30"', "sleep '30'"];

// Documented over-blocks: the shell would not wait on the line, the rule blocks it.
const knownOverBlocks = ["(sleep 30; echo done) &", "{ sleep 30; } &", "timeout 5 sleep 30", "sleep 30 >/dev/null &"];

test("a foreground sleep of two seconds or more blocks, anywhere in the line", () => {
  expect(waits.filter((c) => !isForegroundWait(c))).toEqual([]);
});

test("a short sleep, a directly backgrounded sleep, and sleep in a string, comment, heredoc, or other word do not block", () => {
  expect(notWaits.filter((c) => isForegroundWait(c))).toEqual([]);
});

test("the known misses are still misses", () => {
  expect(knownMisses.filter((c) => isForegroundWait(c))).toEqual([]);
});

test("the known over-blocks are still blocked", () => {
  expect(knownOverBlocks.filter((c) => !isForegroundWait(c))).toEqual([]);
});

// The rule runs synchronously inside the tool_call handler, so its cost must
// stay linear in the command's length.
test("a 200 KB adversarial command line classifies in well under a second", () => {
  const n = 200 * 1024;
  const inputs = [
    `cat <<EOF\n${"\n".repeat(n)}`,
    `cat <<EOF\n${"  \n".repeat(n / 3)}`,
    `echo ${"a'".repeat(n / 2)}`,
    `${'"x '.repeat(n / 3)}`,
    `${'"'}${'\\"'.repeat(n / 2)}`,
    `${"cat <<A\n".repeat(n / 8)}`,
    `sleep${" ".repeat(n)};`,
    `${"# ".repeat(n / 2)}`,
    `${"sleep 30 && ".repeat(n / 12)}true`,
  ];
  for (const input of inputs) {
    const started = performance.now();
    isForegroundWait(input);
    expect(performance.now() - started).toBeLessThan(250);
  }
});

test("a foreground sleep is blocked only while a background agent runs", async () => {
  const { pi, ctx } = setup({ script: { default: [{ sleep: 400 }, { reply: "done" }] } });
  const bash = async (command) => (await pi.emit("tool_call", { toolName: "bash", toolCallId: "t", input: { command } }, ctx)).find(Boolean);
  expect(await bash("sleep 20")).toBeUndefined();
  await pi.call("agent", { description: "bg", prompt: "go", run_in_background: true }, ctx);
  expect(await bash("sleep 20")).toMatchObject({ block: true });
  expect(await bash("sleep 1")).toBeUndefined();
  await waitFor(() => pi.messages.length === 1);
  expect(await bash("sleep 20")).toBeUndefined();
});
