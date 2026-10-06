import { expect, test } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const logScript = fileURLToPath(new URL("../plugins/pstack/skills/show-me-your-work/scripts/log.sh", import.meta.url));

// A spreadsheet runs a leading = + - @ as a formula, and a quote-aware TSV
// reader unwraps a leading " (or runs an unterminated one into later rows).
test("cells a spreadsheet or TSV reader would reinterpret are written with a leading quote", () => {
  const dir = mkdtempSync(join(tmpdir(), "pstack-log-"));
  try {
    const log = join(dir, "log.tsv");
    const risky = ['"=HYPERLINK(""http://x"")"', '"unterminated', "=1+1", "+1", "-1", "@SUM(A1)"];
    for (const cell of [...risky, "plain"]) {
      execFileSync("bash", [logScript, log, "phase", cell, "why", "evidence", "result"]);
    }
    const rows = readFileSync(log, "utf8").trimEnd().split("\n").slice(1).map((line) => line.split("\t"));
    expect(rows.map((row) => row[2])).toEqual([...risky.map((cell) => `'${cell}`), "plain"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 20 KB cells make each row longer than any stdio buffer, so a row written in
// pieces shows up as a malformed row once writers overlap.
test("40 concurrent writers with 20 KB cells leave every row intact", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pstack-log-"));
  try {
    const log = join(dir, "log.tsv");
    const evidence = "x".repeat(20_000);
    const writers = Array.from({ length: 40 }, (_, i) =>
      spawn("bash", [logScript, log, `p${i}`, `decision ${i}`, "why", evidence, `result ${i}`], { stdio: "inherit" }),
    );
    const exits = await Promise.all(writers.map((writer) => once(writer, "exit")));
    expect(exits.map(([code]) => code)).toEqual(Array(40).fill(0));
    const rows = readFileSync(log, "utf8")
      .trimEnd()
      .split("\n")
      .map((line) => line.split("\t"))
      .filter((row) => row[0] !== "ts");
    expect(rows.filter((row) => row.length !== 6 || row[4] !== evidence).length).toBe(0);
    expect(rows.length).toBe(40);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// PERL_UNICODE puts a :utf8 layer on perl's standard handles, and syswrite
// refuses a handle that has one.
test("a row with non-ASCII cells is appended when PERL_UNICODE is set", () => {
  const dir = mkdtempSync(join(tmpdir(), "pstack-log-"));
  try {
    const log = join(dir, "log.tsv");
    const cells = ["phase", "naïve ✓", "why", "日本語", "result"];
    execFileSync("bash", [logScript, log, ...cells], { env: { ...process.env, PERL_UNICODE: "SDA" } });
    const rows = readFileSync(log, "utf8").trimEnd().split("\n").slice(1).map((line) => line.split("\t"));
    expect(rows.map((row) => row.slice(1))).toEqual([cells]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a row is appended when perl is not installed", () => {
  const dir = mkdtempSync(join(tmpdir(), "pstack-log-"));
  try {
    const log = join(dir, "log.tsv");
    const bin = join(dir, "bin");
    mkdirSync(bin);
    for (const tool of ["dirname", "date", "tr"]) symlinkSync(Bun.which(tool), join(bin, tool));
    const cells = ["phase", "decision", "why", "evidence", "result"];
    execFileSync(Bun.which("bash"), [logScript, log, ...cells], { env: { PATH: bin } });
    const rows = readFileSync(log, "utf8").trimEnd().split("\n").slice(1).map((line) => line.split("\t"));
    expect(rows.map((row) => row.slice(1))).toEqual([cells]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
