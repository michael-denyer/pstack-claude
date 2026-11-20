// The statechart janitor runs detached, so on Windows it has no console. A taskkill it starts without windowsHide gets a console window of its own.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";

const scripts = new URL("../plugins/pstack/skills/statechart/scripts/", import.meta.url);

test("every taskkill spawn in the statechart scripts hides its window", () => {
  const calls = readdirSync(scripts)
    .filter((name) => name.endsWith(".ts"))
    .flatMap((name) => readFileSync(new URL(name, scripts), "utf8").match(/spawn(?:Sync)?\(\s*"taskkill".*$/gm) ?? []);
  expect(calls.length).toBeGreaterThan(0);
  for (const call of calls) expect(call).toContain("windowsHide: true");
});
