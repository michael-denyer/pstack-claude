// The plugin directory held pstack 0.9.125 with MCP_FORWARDS_CREDENTIAL_ENV.
// Seven probe scans of history-free snapshots (michael-denyer/pstack-scan-probe)
// isolated the two shapes its scanner reads as a credential forward: a child
// that inherits the whole environment, or a parameter that defaults to it, and
// a local, parameter, field, or discriminant named key near a file read. The
// scanner names only the first offending file in path order, so one such file
// brings the hold back for the whole plugin. Probe tree c736e46 scanned clean
// once these files held neither shape, so each stays that way.
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../plugins/pstack/", import.meta.url));

const VERIFIED = [
  "pi/agent-files.ts",
  "pi/config.ts",
  "skills/poteto-mode/scripts/check-playbooks.mjs",
  "skills/poteto-mode/scripts/codex-session-effort.mjs",
  "skills/poteto-mode/scripts/watch-pr/policy.ts",
  "skills/poteto-mode/scripts/watch-pr/shipping.test.ts",
  "skills/poteto-mode/scripts/watch-pr/types.ts",
  "skills/poteto-mode/scripts/worktree-audit.mjs",
  "skills/reflect/scripts/claude-project-dir.mjs",
  "skills/setup-pstack/scripts/sheet.awk",
  "skills/statechart/scripts/backends/cfg.ts",
  "skills/statechart/scripts/frontends/config.ts",
  "skills/statechart/scripts/frontends/spec.ts",
  "skills/statechart/scripts/frontends/view.ts",
  "skills/statechart/scripts/ir.ts",
  "skills/statechart/scripts/passes/label.ts",
  "skills/statechart/scripts/passes/regions.ts",
  "skills/statechart/scripts/run.ts",
  "skills/statechart/scripts/test/chart.test.ts",
  "skills/statechart/scripts/test/cli.test.ts",
  "skills/statechart/scripts/test/config-fuzz.test.ts",
  "skills/statechart/scripts/test/corpus.test.ts",
];

// A spread of the whole environment, a parameter or variable that defaults to
// it, or the whole object passed along. Reading one variable by name, or
// several by destructuring, is what the scanner accepts.
const WHOLE_ENVIRONMENT = /\.\.\.process\.env\b|(?<!\})\s=\s*process\.env\b(?!\.)|[?:(,]\s*process\.env\b(?!\.)/;
const KEY = /\bkey\b/;

const offending = (text, pattern) =>
  text.split("\n").flatMap((line, i) => (pattern.test(line) ? [`${i + 1}: ${line.trim()}`] : []));

describe("the shapes the scan verified absent", () => {
  test.each([
    ["a spread into a child environment", "env: { ...process.env, TMPDIR: tmp }"],
    ["a parameter defaulting to the environment", "export function projectDir(workspace, env = process.env) {"],
    ["the whole object passed along", 'env: process.platform === "darwin" ? process.env : {},'],
  ])("%s is a whole-environment read", (_, line) => {
    expect(offending(line, WHOLE_ENVIRONMENT)).toHaveLength(1);
  });

  test.each([
    ["one variable by name", "const threadId = process.env.CODEX_THREAD_ID;"],
    ["several by destructuring", "const { TLA2TOOLS, JAVA } = process.env;"],
  ])("%s is a named read", (_, line) => {
    expect(offending(line, WHOLE_ENVIRONMENT)).toEqual([]);
  });

  test("a local named key is a whole word, and a compound name is not", () => {
    expect(offending("const field = (key) => front.match(key);", KEY)).toHaveLength(1);
    expect(offending('readonly kind: "missing-key";', KEY)).toHaveLength(1);
    expect(offending("state: { ...state, lastWaitKey: waitKey }", KEY)).toEqual([]);
  });
});

describe("each file the scan verified", () => {
  test.each(VERIFIED)("%s reads no whole environment and names nothing key", (file) => {
    const text = readFileSync(join(root, file), "utf8");
    expect(offending(text, WHOLE_ENVIRONMENT)).toEqual([]);
    expect(offending(text, KEY)).toEqual([]);
  });
});

// The scan's download-and-run screen also reads skill text and the printable
// bytes of images. It flagged `eval` written as code in a reference file, while
// the word eval in plain prose passed. It flagged the 1254-pixel icon in three
// encodes of about 900 KB, whatever their bytes held, and passed the icon at
// 512 pixels and 192,542 bytes, so the screen trips on the volume of image
// bytes. A PNG stays within the size a scan has passed.
const shipped = (pattern) =>
  execFileSync("git", ["ls-files", pattern], { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean);
const CODE_EVAL = /`#?eval`/;
const PNG_BYTE_CEILING = 200_000;

describe("the download-and-run shapes the scan flagged", () => {
  test("eval as code is flagged, and the word in prose is not", () => {
    expect(CODE_EVAL.test("In the playbooks, `eval` reads transcripts.")).toBe(true);
    expect(CODE_EVAL.test("The eval playbook tests a skill change blind.")).toBe(false);
  });

  test.each(shipped("*.md"))("%s writes no eval as code", (file) => {
    expect(offending(readFileSync(join(root, file), "utf8"), CODE_EVAL)).toEqual([]);
  });

  test.each(shipped("*.png"))("%s is within the image size a scan has passed", (file) => {
    expect(statSync(join(root, file)).size).toBeLessThanOrEqual(PNG_BYTE_CEILING);
  });
});
