import assert from "node:assert/strict";
import { test } from "node:test";
import { childEnv } from "../run.ts";

test("a child gets the named variables and nothing else this process holds", () => {
  process.env.STATECHART_CHILD_ENV_PROBE = "secret";
  try {
    const env = childEnv({ MISE_CEILING_PATHS: "/work" });
    assert.equal(env.PATH, process.env.PATH);
    assert.equal(env.MISE_CEILING_PATHS, "/work");
    assert.equal("STATECHART_CHILD_ENV_PROBE" in env, false);
  } finally {
    delete process.env.STATECHART_CHILD_ENV_PROBE;
  }
});
