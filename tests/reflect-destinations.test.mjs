// reflect copies an edited pstack skill to `.claude/skills/<skill>/` or Claude
// Code's personal skills folder. Pi and Codex load neither, so their mappings
// name the folders each runtime does load (#496; OMP's row is in omp.test.mjs).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const references = fileURLToPath(new URL("../plugins/pstack/skills/poteto-mode/references", import.meta.url));

function reflectRow(file) {
  const rows = readFileSync(join(references, file), "utf8").split("\n");
  return rows.find((line) => line.startsWith("| `reflect` |")) ?? "";
}

describe("reflect's copy destinations", () => {
  test.each([
    [
      "pi-tools.md",
      [
        "never edit the installed package",
        "`.pi/skills/<skill>/`",
        "`$PI_CODING_AGENT_DIR/skills/`",
        "`~/.pi/agent/skills/`",
        "only in a trusted project",
        "it replaces the package's copy",
      ],
    ],
    [
      "codex-tools.md",
      [
        "never edit the installed plugin under `${CODEX_HOME:-~/.codex}/plugins/cache/`",
        "`.agents/skills/<skill>/`",
        "`${CODEX_HOME:-~/.codex}/skills/<skill>/`",
        "do not copy to or edit through it",
        "`pstack:<skill>`",
      ],
    ],
  ])("%s sends the edited copy to a folder the runtime loads", (file, phrases) => {
    const row = reflectRow(file);
    expect(row).not.toBe("");
    expect(phrases.filter((phrase) => !row.includes(phrase))).toEqual([]);
  });
});
