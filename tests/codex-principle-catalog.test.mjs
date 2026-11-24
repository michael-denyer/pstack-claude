import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";

test("Codex principle skills require explicit invocation", () => {
  const skills = new URL("../plugins/pstack/skills/", import.meta.url);
  const principles = readdirSync(skills, { withFileTypes: true }).filter(
    (entry) => entry.isDirectory() && entry.name.startsWith("principle-"),
  );
  expect(principles.length).toBeGreaterThan(0);
  for (const { name } of principles) {
    const metadata = new URL(`${name}/agents/openai.yaml`, skills);
    const { policy } = Bun.YAML.parse(readFileSync(metadata, "utf8"));
    expect(policy.allow_implicit_invocation).toBe(false);
  }
});
