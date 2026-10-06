import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const workflow = Bun.YAML.parse(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"));
const step = workflow.jobs.forks.steps.find(({ name }) => name === "Check every fork from upstream is declared");

// GitHub runs a step body as `bash -e <file>`. The bun on the path is a stub
// that records each sync it is asked for and fails for one component.
function runStep(upstream, { failing = "" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pstack-forks-step-"));
  try {
    const calls = join(dir, "calls");
    mkdirSync(join(dir, "tools"));
    mkdirSync(join(dir, "bin"));
    if (upstream !== null) writeFileSync(join(dir, "tools/upstream.json"), upstream);
    writeFileSync(join(dir, "step.sh"), step.run);
    writeFileSync(join(dir, "bin/bun"), '#!/bin/bash\necho "$2 $3" >> "$CALLS"\n[ "$2" != "$FAILING" ]\n', { mode: 0o755 });
    const { status, stdout } = spawnSync("bash", ["-e", "step.sh"], {
      cwd: dir,
      env: { PATH: `${join(dir, "bin")}:${process.env.PATH}`, RUNNER_TEMP: dir, CALLS: calls, FAILING: failing },
      encoding: "utf8",
    });
    return { passed: status === 0, stdout, synced: existsSync(calls) ? readFileSync(calls, "utf8").trimEnd().split("\n") : [] };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const pins = JSON.stringify({ components: { a: { sha: "111" }, b: { sha: "222" } } });

test.skipIf(!Bun.which("jq"))("the fork check syncs every pinned component and passes when each sync passes", () => {
  expect(runStep(pins)).toEqual({ passed: true, stdout: "", synced: ["a 111", "b 222"] });
});

test.skipIf(!Bun.which("jq"))("the fork check fails when one sync fails, and still runs the rest", () => {
  expect(runStep(pins, { failing: "a" })).toEqual({ passed: false, stdout: "", synced: ["a 111", "b 222"] });
});

test.skipIf(!Bun.which("jq")).each([
  ["is not JSON", '{"components": {'],
  ["has no components key", "{}"],
  ["holds a component that is not an object", '{"components":{"a":{"sha":"111"},"b":"oops"}}'],
  ["is missing", null],
])("the fork check fails without a sync when tools/upstream.json %s", (_, upstream) => {
  expect(runStep(upstream)).toEqual({ passed: false, stdout: "", synced: [] });
});

test.skipIf(!Bun.which("jq"))("the fork check fails when tools/upstream.json lists no component", () => {
  expect(runStep('{"components":{}}')).toEqual({ passed: false, stdout: "tools/upstream.json lists no components\n", synced: [] });
});
