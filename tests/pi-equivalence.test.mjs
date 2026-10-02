import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const STATUSES = new Set(["native", "extension", "script", "mapping", "difference", "n/a"]);
const LIVE = new Set(["VERIFIED", "n/a"]);

function equivalenceRows(markdown) {
  const rows = [];
  for (const line of markdown.split("\n")) {
    if (!/^\| [A-Z]\d{2}[a-z]? \|/.test(line)) continue;
    const cells = line.slice(1, -1).split(" | ").map((c) => c.trim());
    const [id, , , status, evidence, live] = cells;
    rows.push({ id, status, evidence, live, cells: cells.length });
  }
  return rows;
}

function testTitles() {
  const titles = new Set();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".test.mjs")) {
        for (const m of readFileSync(path, "utf8").matchAll(/\btest(?:\.\w+\([^)]*\))?\(\s*(["'`])((?:\\.|(?!\1).)*)\1/g)) {
          titles.add(m[2].replace(/\\(.)/g, "$1"));
        }
      }
    }
  };
  walk(join(root, "tests"));
  return titles;
}

describe("docs/pi-equivalence.md", () => {
  const rows = equivalenceRows(readFileSync(join(root, "docs/pi-equivalence.md"), "utf8"));
  const titles = testTitles();

  test("lists every mechanism once, with six cells", () => {
    expect(rows.length).toBe(62);
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
    for (const r of rows) expect(r.cells).toBe(6);
  });

  test("every row has a known status and live verdict", () => {
    for (const r of rows) {
      expect(STATUSES.has(r.status)).toBe(true);
      expect(LIVE.has(r.live)).toBe(true);
    }
  });

  test("every extension or script row names a test that exists", () => {
    const missing = rows
      .filter((r) => r.status === "extension" || r.status === "script")
      .filter((r) => !titles.has(r.evidence.replace(/^`|`$/g, "")))
      .map((r) => `${r.id}: ${r.evidence}`);
    expect(missing).toEqual([]);
  });
});
