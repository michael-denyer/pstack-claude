import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

import { changes, plan, problems } from "../tools/generate.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

test("an autocrlf checkout keeps generator inputs current and binary assets intact", () => {
  const root = mkdtempSync(join(tmpdir(), "pstack-generate-checkout-"));
  try {
    cpSync(repoRoot, root, { recursive: true, filter: (src) => ![".git", "node_modules"].includes(basename(src)) });
    const binary = Buffer.from([0, 10, 13, 10, 255]);
    writeFileSync(join(root, "binary.dat"), binary);
    const git = (...args) => {
      const result = spawnSync("git", ["-c", "core.autocrlf=true", "-c", "core.attributesFile=", "-C", root, ...args], { encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
      return result;
    };
    git("init");
    git("add", "--all");
    for (const file of git("ls-files", "-z").stdout.split("\0").filter(Boolean)) rmSync(join(root, file));
    git("checkout-index", "--all", "--force");

    expect(readFileSync(join(root, "plugins/pstack/skills/poteto-mode/SKILL.md"), "utf8").includes("\r\n")).toBe(false);
    expect(readFileSync(join(root, "plugins/pstack/hooks/session-start.sh"), "utf8").includes("\r\n")).toBe(false);
    expect(readFileSync(join(root, "binary.dat"))).toEqual(binary);
    expect(changes(root, plan(root))).toEqual([]);
    expect(problems(root)).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
