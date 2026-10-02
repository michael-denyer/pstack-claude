// PiChild against small scripted children, for stream edge cases the fake pi
// cannot produce.
import { expect, test } from "bun:test";

import { PiChild } from "../../plugins/pstack/pi/child.ts";
import { sleep } from "./harness.mjs";

const opts = { cwd: process.cwd(), env: process.env, exitGraceMs: 1000 };
const scripted = (script) => new PiChild(process.execPath, ["-e", script], opts, "p");

test("a command written to a child that closed its stdin resolves undefined once it exits", async () => {
  const child = scripted("process.stdin.destroy(); setTimeout(() => {}, 400)");
  await sleep(150);
  expect(await child.command({ type: "steer", message: "m" })).toBeUndefined();
  expect((await child.exited).exitCode).toBe(0);
});

test("a response whose success is not a boolean settles its command as failed instead of waiting for exit", async () => {
  const child = scripted(
    'process.stdin.setEncoding("utf8"); let b = ""; process.stdin.on("data", (d) => { b += d; const lines = b.split("\\n"); b = lines.pop();' +
      ' for (const l of lines) { const c = JSON.parse(l); process.stdout.write(JSON.stringify({ id: c.id, type: "response", command: c.type, success: c.type === "prompt" ? true : "nope", data: { disposition: "started" } }) + "\\n"); } });' +
      " setTimeout(() => process.exit(0), 3000)",
  );
  await sleep(200);
  const response = await child.command({ type: "steer", message: "m" });
  expect(response.success).toBe(false);
  child.close();
  await child.exited;
});

// Answers each command; a steer's response is `before` or `after` the settle, in one write.
const steerAndSettle = (order) =>
  'process.stdin.setEncoding("utf8"); let b = ""; process.stdin.on("end", () => process.exit(0)); process.stdin.on("data", (d) => { b += d; const lines = b.split("\\n"); b = lines.pop();' +
  ' for (const l of lines) { const c = JSON.parse(l); const r = JSON.stringify({ id: c.id, type: "response", command: c.type, success: true }) + "\\n";' +
  ` const s = JSON.stringify({ type: "agent_settled" }) + "\\n"; process.stdout.write(c.type === "steer" ? ${order === "before" ? "r + s" : "s + r"} : r); } });`;

test("a steer answered before the run settles was taken, even when the settle follows in the same chunk", async () => {
  const child = scripted(steerAndSettle("before"));
  expect((await child.steer("m")).taken).toBe(true);
  await child.exited;
});

test("a steer answered after the run settled was not taken", async () => {
  const child = scripted(steerAndSettle("after"));
  expect((await child.steer("m")).taken).toBe(false);
  await child.exited;
});

test("a multibyte character split across two stdout chunks reaches the final text intact", async () => {
  const lines = [
    { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "café ok" }], stopReason: "stop" } },
    { type: "agent_settled" },
  ].map((e) => `${JSON.stringify(e)}\n`).join("");
  const cut = Buffer.byteLength(lines.slice(0, lines.indexOf("é"))) + 1;
  const child = scripted(
    `const b = Buffer.from(${JSON.stringify(lines)}); process.stdout.write(b.subarray(0, ${cut}));` +
      `setTimeout(() => process.stdout.write(b.subarray(${cut})), 100); process.stdin.resume(); process.stdin.on("end", () => process.exit(0))`,
  );
  const exit = await child.exited;
  expect(exit.finalText).toBe("café ok");
  expect(exit.settled).toBe(true);
});
