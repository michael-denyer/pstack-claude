import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

// A worktree under /tmp on macOS reaches every tool through a symlink, and
// node leaves that symlink in argv[1].
test.each(["validate-skills.mjs", "sync.mjs"])("%s runs when its path crosses a symlink", (tool) => {
  const dir = mkdtempSync(join(tmpdir(), "pstack-linked-repo-"));
  try {
    const linked = join(dir, "repo");
    symlinkSync(repoRoot, linked);
    const result = spawnSync("node", [join(linked, "tools", tool)], { encoding: "utf8" });
    expect(result.error).toBeUndefined();
    expect({ status: result.status, stdout: result.stdout }).toEqual({ status: 2, stdout: "" });
    expect(result.stderr).toContain(`tools/${tool}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
