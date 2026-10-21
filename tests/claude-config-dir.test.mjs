import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { walk } from "../tools/validate-skills.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const CLAUDE_DIR =
  /(?:\.claude|CLAUDE_CONFIG_DIR)\}?\/(?:projects|shell-snapshots)\b|(?:~|(?<![A-Z_])HOME\}?|CLAUDE_CONFIG_DIR\}?)\/(?:\.claude\}?\/)?(?:skills|plugins)\b/;
const SPELLING = "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/";
const SLASH_ONLY_ENCODING = /`\/` → `-`|leading slash dropped/;
const HISTORY = new Set(["CHANGES.md"]);

const linesMatching = (pattern) =>
  walk(repoRoot)
    .filter((file) => {
      const rel = relative(repoRoot, file);
      return !HISTORY.has(rel) && rel.split(sep)[0] !== "tests";
    })
    .flatMap((file) =>
      readFileSync(file, "utf8")
        .split("\n")
        .flatMap((line, i) => (pattern.test(line.replaceAll(SPELLING, "")) ? [`${relative(repoRoot, file)}:${i + 1}`] : [])),
    );

test("Claude Code's projects, shell-snapshots, skills, and plugins paths read ${CLAUDE_CONFIG_DIR:-$HOME/.claude}/", () => {
  expect(linesMatching(CLAUDE_DIR)).toEqual([]);
});

test("<encoded-cwd> turns every character other than a letter or digit into -", () => {
  expect(linesMatching(SLASH_ONLY_ENCODING)).toEqual([]);
});
