import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { walk } from "../tools/validate-skills.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const PLUGINS = "${CLAUDE_CODE_PLUGIN_CACHE_DIR:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins}/";
const CONFIG = "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/";
// CONFIG becomes this marker, so a plugins path that skips PLUGINS still shows.
const AT_CONFIG = "\0/";
const CLAUDE_DIR = new RegExp(
  [
    /(?:\.claude|CLAUDE_CONFIG_DIR)\}?\/(?:projects|shell-snapshots)\b/,
    /(?:~|(?<![A-Z_])HOME\}?|CLAUDE_CONFIG_DIR\}?)\/(?:\.claude\}?\/)?(?:skills|plugins)\b/,
    /\0\/plugins\b/,
    // pstack's own orchestrate store and setup-pstack's resolved include line stay under ~/.claude.
    /(?:~|(?<![A-Z_])\$\{?HOME\}?)\/\.claude\/(?!orchestrate\b|pstack-models\.md\b)/,
  ]
    .map((pattern) => pattern.source)
    .join("|"),
);
const SLASH_ONLY_ENCODING = /`\/` → `-`|leading slash dropped/;
const HISTORY = new Set(["CHANGES.md"]);

function linesMatching(pattern) {
  const hits = [];
  for (const file of walk(repoRoot)) {
    const rel = relative(repoRoot, file);
    if (HISTORY.has(rel) || rel.split(sep)[0] === "tests") continue;
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, i) => {
        if (pattern.test(line.replaceAll(PLUGINS, "").replaceAll(CONFIG, AT_CONFIG))) hits.push(`${rel}:${i + 1}`);
      });
  }
  return hits;
}

test("Claude Code's config paths read ${CLAUDE_CONFIG_DIR:-$HOME/.claude}/, and plugins honour CLAUDE_CODE_PLUGIN_CACHE_DIR", () => {
  expect(linesMatching(CLAUDE_DIR)).toEqual([]);
});

test("<encoded-cwd> turns every character other than a letter or digit into -", () => {
  expect(linesMatching(SLASH_ONLY_ENCODING)).toEqual([]);
});

// The system prompt's primary working directory follows the shell, so passing it
// can name another project; without an argument the script finds the session by id.
test("skills never pass the primary working directory to claude-project-dir.mjs", () => {
  expect(linesMatching(/claude-project-dir\.mjs +\\?"<primary working directory>/)).toEqual([]);
});
