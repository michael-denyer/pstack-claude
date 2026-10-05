// A bare `bun test` at the repository root must load the same files as CI's
// `bun test tests/`. The vendored poteto-mode scripts import packages that
// only their own `bun install` provides, so loading them from the root fails
// until some earlier run has installed them.
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

function loadedFiles(...paths) {
  const result = spawnSync(process.execPath, ["test", "--test-name-pattern", "^pstack-no-such-test$", ...paths], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  const output = result.stdout + result.stderr;
  expect(result.status, output).toBe(0);
  return Number(output.match(/across (\d+) files?/)?.[1]);
}

test("a bare bun test at the root loads the same files as bun test tests/", () => {
  expect(loadedFiles()).toBe(loadedFiles("tests/"));
});
