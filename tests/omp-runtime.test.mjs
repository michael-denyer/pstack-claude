import { expect, test } from "bun:test";
import { RUNTIMES, validateOmpPackage } from "../tools/runtimes.mjs";

const manifest = { name: "pstack", version: "1", omp: { extensions: ["./omp/index.mjs"] } };
const marketplace = { plugins: [{ name: "pstack", source: "./plugins/pstack", version: "1" }] };
const required = new Set([
  "plugins/pstack/omp/index.mjs",
  "plugins/pstack/skills/poteto-mode/SKILL.md",
  "plugins/pstack/hooks/session-start-context.md",
]);
const options = { marketplace, pathExists: (path) => required.has(path) };

test("OMP registry owns its versioned package and model mapping", () => {
  const runtime = RUNTIMES.find((r) => r.name === "OMP");
  expect(runtime.manifest).toBe("plugins/pstack/package.json");
  expect(runtime.tools).toEndWith("/omp-tools.md");
  expect(runtime.modelNames()).toContain("task.agentModelOverrides");
});

test("OMP validates the marketplace, extension and required files", () => {
  expect(() => validateOmpPackage(manifest, options)).not.toThrow();
  expect(() => validateOmpPackage({ ...manifest, name: "other" }, options)).toThrow("marketplace entry");
  expect(() => validateOmpPackage({ ...manifest, version: "2" }, options)).toThrow("marketplace entry");
  expect(() => validateOmpPackage({ ...manifest, omp: { extensions: [] } }, options)).toThrow("omp/index.mjs");
  for (const path of required) {
    expect(() => validateOmpPackage(manifest, { ...options, pathExists: (name) => name !== path })).toThrow("OMP package missing");
  }
});
