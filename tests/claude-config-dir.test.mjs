import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

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

function linesMatching(pattern, root = repoRoot) {
  const hits = [];
  const files = execFileSync("git", ["-C", root, "ls-files", "--cached", "--others", "--exclude-standard", "-z"], { encoding: "utf8" });
  for (const rel of files.split("\0").filter(Boolean)) {
    if (HISTORY.has(rel) || rel.split("/")[0] === "tests") continue;
    const file = join(root, rel);
    if (!existsSync(file)) continue;
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, i) => {
        if (pattern.test(line.replaceAll(PLUGINS, "").replaceAll(CONFIG, AT_CONFIG))) hits.push(`${rel}:${i + 1}`);
      });
  }
  return hits;
}

test("the scan includes tracked and untracked source, but not ignored session backups", () => {
  const root = mkdtempSync(join(tmpdir(), "pstack-config-scan-"));
  try {
    execFileSync("git", ["init", "-q", root]);
    writeFileSync(join(root, ".gitignore"), ".remember/\n");
    writeFileSync(join(root, "tracked.md"), "bad path\n");
    execFileSync("git", ["-C", root, "add", "tracked.md"]);
    writeFileSync(join(root, "new.md"), "bad path\n");
    mkdirSync(join(root, ".remember"));
    writeFileSync(join(root, ".remember", "backup.tar"), "bad path\n");
    expect(linesMatching(/bad path/, root).sort()).toEqual(["new.md:1", "tracked.md:1"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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
