// The bug report form offers every runtime the port supports, so a reporter never has to pick a wrong one.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { RUNTIMES } from "../tools/runtimes.mjs";

const form = Bun.YAML.parse(readFileSync(new URL("../.github/ISSUE_TEMPLATE/bug_report.yml", import.meta.url), "utf8"));
const options = form.body.find((field) => field.id === "runtime").attributes.options;

test("the runtime dropdown lists Claude Code and every runtime in RUNTIMES, in that order", () => {
  const supported = ["Claude Code", ...RUNTIMES.map((runtime) => runtime.name)];
  expect(options.slice(0, supported.length)).toEqual(supported);
});

test("the runtime dropdown ends with the two choices that name no single supported runtime", () => {
  expect(options.slice(RUNTIMES.length + 1)).toEqual([
    "Another harness",
    "More than one, or not specific to a runtime",
  ]);
});
