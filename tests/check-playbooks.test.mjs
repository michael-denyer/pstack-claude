import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

setDefaultTimeout(30_000);

const script = join(import.meta.dir, "../plugins/pstack/skills/poteto-mode/scripts/check-playbooks.mjs");

function run(playbooks) {
  const root = mkdtempSync(join(tmpdir(), "pstack-check-playbooks-"));
  try {
    mkdirSync(join(root, ".agents/playbooks"), { recursive: true });
    for (const [name, text] of Object.entries(playbooks)) writeFileSync(join(root, ".agents/playbooks", name), text);
    const result = spawnSync("node", [script, root], { encoding: "utf8" });
    return { code: result.status, out: result.stdout + result.stderr };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("project playbooks", () => {
  test("a change anchored on a bundled step passes", () => {
    const result = run({
      "bug-fix.md": '---\nextends: bug-fix\nwhen: Use it for any bug report.\n---\n- **In** "Binary-search the cause": compare with main.\n',
    });
    expect(result).toEqual({ code: 0, out: "Every project playbook matches this pstack's playbooks.\n" });
  });

  test("an unknown base, step text the base does not say, and an unquoted change all fail", () => {
    const result = run({
      "bug-fix.md": '---\nextends: bug-fix\nwhen: Use it for any bug report.\n---\n- **After** "Ask the user to reproduce it": compare with main.\n',
      "ship.md": "---\nextends: shipping-v2\nwhen: Use it to ship.\n---\n",
      "fix.md": "---\nextends: bug-fix\nwhen: Use it to fix.\n---\n- **After** \u201cBinary-search the cause\u201d: compare with main.\n",
    });
    expect(result.code).toBe(1);
    expect(result.out).toContain('.agents/playbooks/bug-fix.md: "Ask the user to reproduce it" is not in any playbook it extends');
    expect(result.out).toContain(".agents/playbooks/ship.md: extends `shipping-v2`, which this pstack has no playbook for");
    expect(result.out).toContain(".agents/playbooks/fix.md: a change has no straight-quoted step text to anchor on");
  });
});
