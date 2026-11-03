import { expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

// A plugin update ships the scripts without node_modules, so the first run of
// each entry point installs commander. --no-install turns off Bun's
// auto-install, which otherwise fetches commander from the registry and hides
// a process that cannot see the node_modules it just installed.
const scriptsDirectory = join(import.meta.dir, "..");

for (const [name, entry] of [
  ["watch-pr", "watch-pr/watch-pr"],
  ["ship-pr", "watch-pr/ship-pr"],
]) {
  it(`${name} --help runs on the first run after an install`, () => {
    const copy = mkdtempSync(join(tmpdir(), "poteto-mode-scripts-"));
    try {
      cpSync(scriptsDirectory, copy, {
        recursive: true,
        filter: (source) => basename(source) !== "node_modules",
      });
      const result = spawnSync(
        process.execPath,
        ["--no-install", join(copy, entry), "--help"],
        { cwd: tmpdir(), encoding: "utf8", timeout: 60_000 }
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain(`Usage: ${name}`);
    } finally {
      rmSync(copy, { recursive: true, force: true });
    }
  }, 90_000);
}
