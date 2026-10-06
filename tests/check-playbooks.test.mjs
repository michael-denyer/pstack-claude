import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkPlaybooks } from "../plugins/pstack/skills/poteto-mode/scripts/check-playbooks.mjs";

setDefaultTimeout(30_000);

const script = join(import.meta.dir, "../plugins/pstack/skills/poteto-mode/scripts/check-playbooks.mjs");

function run(playbooks, { throughSymlink = false, cwd = ".", args = ["."] } = {}) {
  // The script reports the resolved working directory; macOS tmpdir() sits behind the /var symlink.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pstack-check-playbooks-")));
  try {
    if (playbooks) {
      mkdirSync(join(root, ".agents/playbooks"), { recursive: true });
      for (const [name, text] of Object.entries(playbooks)) writeFileSync(join(root, ".agents/playbooks", name), text);
    }
    const workingDirectory = join(root, cwd);
    mkdirSync(workingDirectory, { recursive: true });
    let entry = script;
    if (throughSymlink) {
      entry = join(root, "check-playbooks.mjs");
      symlinkSync(script, entry);
    }
    const result = spawnSync("node", [entry, ...args.map((arg) => join(root, arg))], { encoding: "utf8", cwd: workingDirectory });
    return { code: result.status, out: (result.stdout + result.stderr).replaceAll(root, "<root>") };
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

  test("the check still runs when the script is reached through a symlink", () => {
    const result = run(
      { "ship.md": "---\nextends: shipping-v2\nwhen: Use it to ship.\n---\n" },
      { throughSymlink: true },
    );
    expect(result).toEqual({
      code: 1,
      out: ".agents/playbooks/ship.md: extends `shipping-v2`, which this pstack has no playbook for\n",
    });
  });

  test("a numbered change is checked like a bulleted one", () => {
    const result = run({
      "bug-fix.md": '---\nextends: bug-fix\nwhen: Use it for any bug report.\n---\n1. **After** "Ask the user to reproduce it": compare with main.\n2. **Before** Binary-search the cause: compare with main.\n',
    });
    expect(result.code).toBe(1);
    expect(result.out).toContain('.agents/playbooks/bug-fix.md: "Ask the user to reproduce it" is not in any playbook it extends');
    expect(result.out).toContain(".agents/playbooks/bug-fix.md: a change has no straight-quoted step text to anchor on");
  });

  test("a playbook saved with CRLF line endings passes", () => {
    const result = run({
      "bug-fix.md": '---\r\nextends: bug-fix\r\nwhen: Use it for any bug report.\r\n---\r\n- **In** "Binary-search the cause": compare with main.\r\n',
    });
    expect(result).toEqual({ code: 0, out: "Every project playbook matches this pstack's playbooks.\n" });
  });

  test("a playbook saved with a UTF-8 byte-order mark passes", () => {
    const result = run({
      "bug-fix.md": '\uFEFF---\r\nextends: bug-fix\r\nwhen: Use it for any bug report.\r\n---\r\n- **In** "Binary-search the cause": compare with main.\r\n',
    });
    expect(result).toEqual({ code: 0, out: "Every project playbook matches this pstack's playbooks.\n" });
  });

  test("with no argument the root is the working directory", () => {
    const result = run({ "ship.md": "---\nextends: shipping-v2\nwhen: Use it to ship.\n---\n" }, { args: [] });
    expect(result).toEqual({
      code: 1,
      out: ".agents/playbooks/ship.md: extends `shipping-v2`, which this pstack has no playbook for\n",
    });
  });

  test("a root with no .agents/playbooks directory passes and the check says so", () => {
    expect(run(null)).toEqual({
      code: 0,
      out: "No project playbooks to check: <root>/.agents/playbooks does not exist.\n",
    });
  });

  test("from a subdirectory the check names the directory it looked for and does not report a match", () => {
    const result = run({ "ship.md": "---\nextends: shipping-v2\nwhen: Use it to ship.\n---\n" }, { cwd: "src", args: [] });
    expect(result).toEqual({
      code: 0,
      out: "No project playbooks to check: <root>/src/.agents/playbooks does not exist.\n",
    });
  });

  test("a root that does not exist is an error", () => {
    expect(run(null, { args: ["nope"] })).toEqual({ code: 1, out: "<root>/nope is not a directory\n" });
  });

  test("a root that is a file is an error", () => {
    expect(run({ "ship.md": "" }, { args: [".agents/playbooks/ship.md"] })).toEqual({
      code: 1,
      out: "<root>/.agents/playbooks/ship.md is not a directory\n",
    });
  });

  test("an extends stem that leaves the playbooks directory is not a playbook", () => {
    const result = run({ "ship.md": "---\nextends: ../SKILL\nwhen: Use it to ship.\n---\n" });
    expect(result).toEqual({
      code: 1,
      out: ".agents/playbooks/ship.md: extends `../SKILL`, which this pstack has no playbook for\n",
    });
  });

  test("an extends stem with either path separator is not a playbook, even where that file exists", () => {
    const root = mkdtempSync(join(tmpdir(), "pstack-check-playbooks-"));
    try {
      const bundled = join(root, "bundled");
      mkdirSync(join(bundled, "sub"), { recursive: true });
      // On POSIX the second path is a file named `sub\x.md`. On Windows both paths are sub/x.md.
      for (const file of ["sub/x.md", "sub\\x.md"]) writeFileSync(join(bundled, file), "");
      mkdirSync(join(root, ".agents/playbooks"), { recursive: true });
      writeFileSync(join(root, ".agents/playbooks/ship.md"), "---\nextends: sub/x, sub\\x\nwhen: Use it to ship.\n---\n");
      expect(checkPlaybooks(root, bundled)).toEqual([
        ".agents/playbooks/ship.md: extends `sub/x`, which this pstack has no playbook for",
        ".agents/playbooks/ship.md: extends `sub\\x`, which this pstack has no playbook for",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
