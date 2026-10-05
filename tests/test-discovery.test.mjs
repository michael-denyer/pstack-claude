// A bare `bun test` at the repository root must load the same files as CI's
// `bun test tests/`. The vendored poteto-mode scripts import packages that
// only their own `bun install` provides, so loading them from the root fails
// until some earlier run has installed them.
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

test("a bare bun test at the root loads only the files under tests/", () => {
  const testFiles = readdirSync(fileURLToPath(new URL(".", import.meta.url)), { recursive: true })
    .filter((file) => /\.(test|spec)\.|_(test|spec)\./.test(file));
  const result = spawnSync(process.execPath, ["test", "--test-name-pattern", "^pstack-no-such-test$"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  const output = result.stdout + result.stderr;
  expect(output).toContain(`across ${testFiles.length} files`);
  expect(result.status).toBe(0);
});
