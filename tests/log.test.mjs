import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
