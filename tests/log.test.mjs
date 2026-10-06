import { expect, test } from "bun:test";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

test("cells holding % and backslash sequences are written as given", () => {
  const dir = mkdtempSync(join(tmpdir(), "pstack-log-"));
  try {
    const log = join(dir, "log.tsv");
    const cells = ["100%", "%s %d %n %%", "\\n \\t \\\\ \\0", "why", "result"];
    execFileSync("bash", [logScript, log, ...cells]);
    const rows = readFileSync(log, "utf8").trimEnd().split("\n").slice(1).map((line) => line.split("\t"));
    expect(rows.map((row) => row.slice(1))).toEqual([cells]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A shell printf on Linux writes 4 KiB at a time. Before the single write, 20 KB
// rows interleaved there in 12 of 20 runs and 400 KB rows in 100 of 100.
test("40 concurrent writers with 400 KB rows leave every row intact", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pstack-log-"));
  try {
    const log = join(dir, "log.tsv");
    const manyStdioBuffers = "x".repeat(100_000);
    const writers = Array.from({ length: 40 }, (_, i) =>
      spawn("bash", [logScript, log, `p${i}`, ...Array(4).fill(manyStdioBuffers)], { stdio: "inherit" }),
    );
    const exits = await Promise.all(writers.map((writer) => once(writer, "exit")));
    expect(exits.map(([code]) => code)).toEqual(Array(40).fill(0));
    const rows = readFileSync(log, "utf8")
      .trimEnd()
      .split("\n")
      .map((line) => line.split("\t"))
      .filter((row) => row[0] !== "ts");
    expect(rows.filter((row) => row.length === 6 && row.slice(2).every((cell) => cell === manyStdioBuffers)).length).toBe(40);
    expect(rows.length).toBe(40);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

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

test("a 200 KB row is appended, though Linux caps one argument at 128 KiB", () => {
  const dir = mkdtempSync(join(tmpdir(), "pstack-log-"));
  try {
    const log = join(dir, "log.tsv");
    const underTheCap = "x".repeat(100_000);
    execFileSync("bash", [logScript, log, "phase", "decision", "why", underTheCap, underTheCap]);
    const rows = readFileSync(log, "utf8").trimEnd().split("\n").slice(1).map((line) => line.split("\t"));
    expect(rows.map((row) => row.slice(1))).toEqual([["phase", "decision", "why", underTheCap, underTheCap]]);
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

const drainsItsStdin = "#!/bin/sh\nwhile read -r _; do :; done\n";

for (const [state, shim, env] of [
  ["is a shim that exits 3", "#!/bin/sh\necho 'perl: broken shim' >&2\nexit 3\n", {}],
  ["is a shim that exits 0 and writes nothing", drainsItsStdin, {}],
  ["cannot load a module PERL5OPT names", null, { PERL5OPT: "-Mpstack_no_such_module" }],
]) test(`a row is appended, with nothing on stderr, when perl ${state}`, () => {
  const dir = mkdtempSync(join(tmpdir(), "pstack-log-"));
  try {
    const log = join(dir, "log.tsv");
    const bin = join(dir, "bin");
    mkdirSync(bin);
    if (shim) writeFileSync(join(bin, "perl"), shim, { mode: 0o755 });
    const cells = ["phase", "naïve ✓ 100%s", "why", "日本語", "result"];
    const { status, stderr } = spawnSync("bash", [logScript, log, ...cells], {
      env: { ...process.env, ...env, PATH: `${bin}:${process.env.PATH}` },
      encoding: "utf8",
    });
    const rows = readFileSync(log, "utf8").trimEnd().split("\n").slice(1).map((line) => line.split("\t"));
    expect({ status, stderr, rows: rows.map((row) => row.slice(1)) }).toEqual({ status: 0, stderr: "", rows: [cells] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the caller's stdin is left unread when perl is a shim that drains its own", () => {
  const dir = mkdtempSync(join(tmpdir(), "pstack-log-"));
  try {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "perl"), drainsItsStdin, { mode: 0o755 });
    const { stdout } = spawnSync(
      "bash",
      ["-c", 'bash "$@" && cat', "bash", logScript, join(dir, "log.tsv"), "phase", "decision", "why", "evidence", "result"],
      { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, input: "caller stdin\n", encoding: "utf8" },
    );
    expect(stdout).toBe("caller stdin\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a short write fails and says how many bytes of the row were appended", () => {
  const dir = mkdtempSync(join(tmpdir(), "pstack-log-"));
  try {
    const pastTheCap = "y".repeat(3000);
    const { status, stderr } = spawnSync(
      "bash",
      ["-c", 'ulimit -f 1 && exec bash "$@"', "bash", logScript, join(dir, "log.tsv"), "phase", "decision", "why", pastTheCap, "result"],
      { encoding: "utf8" },
    );
    expect(stderr).toMatch(/^log\.sh: short write, appended \d+ of 30\d\d bytes of the row\n$/);
    expect(status).not.toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
