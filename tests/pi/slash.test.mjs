// slash.ts copies pi's slash expansion, which pi does not export. Its helpers are checked here against the
// installed pi's own, so a pi release that changes them fails instead of drifting.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { expandSlash, parseCommandArgs, stripFrontmatter, substituteArgs } from "../../plugins/pstack/pi/slash.ts";
import { installedPi, PI_FLOOR } from "../../tools/pi-package.mjs";

const installed = installedPi();
const piDir = installed?.dir;
const piModule = (rel) => import(pathToFileURL(join(piDir, rel)).href);
// CI's pi-types job installs Pi and sets this, so there a missing Pi fails instead of skipping.
const required = process.env.PSTACK_PI_REQUIRE_RUNTIME === "1";
if (required && !piDir) throw new Error("The slash expansion checks require an installed Pi package.");
// slash.ts copies the code of Pi PI_FLOOR, and an older Pi's own code differs from it.
const tooOld = installed && !installed.supported;
// bun prints the names of skipped tests only in CI, so say why these did not run.
if (tooOld && !required) console.warn(`tests/pi/slash.test.mjs skips its checks against the installed pi ${installed.version}, which is older than ${PI_FLOOR}. Set PI_PACKAGE_DIR to a newer Pi package to run them.`);

const quoteRules = `--title="fix bug" it's "say \\"hi\\"" 'it\\'s' "a\\b" "open 'quote`;
const argLines = ["", "a b  c", ' --title="fix bug" 42', 'a"b c"d', "it's fine", `'single' "double"`, "tab\tsep\nnewline", 'open "quote here', `x 'a"b' y`, quoteRules, '"ends in an escape\\"'];
const templates = ["$1 $2 $3", "$@|$ARGUMENTS", "${1:-def} ${3:-none}", "${@:-empty}", "${ARGUMENTS:-empty}", "${@:2}", "${@:2:1}", "${@:0}", "$10", "$ARGUMENTS$1"];
const argSets = [[], ["a"], ["a", "b c", "d"]];
const files = ["no frontmatter\n", "---\nname: x\n---\nbody\n", "\uFEFF---\r\nname: x\r\n---\r\n  body  \r\n", "---\nunterminated", "---\na: 1\n----\nbody", "  ---\nx: 1\n---\ny\r"];

describe.skipIf(!installed || (tooOld && !required))(`slash expansion matches the installed pi${tooOld ? ` (pi ${installed.version} is older than the supported ${PI_FLOOR})` : ""}`, () => {
  test("parseCommandArgs", async () => {
    const pi = await piModule("dist/core/prompt-templates.js");
    for (const line of argLines) expect([line, parseCommandArgs(line)]).toEqual([line, pi.parseCommandArgs(line)]);
  });

  test("substituteArgs", async () => {
    const pi = await piModule("dist/core/prompt-templates.js");
    for (const t of templates) for (const args of argSets) expect([t, args, substituteArgs(t, args)]).toEqual([t, args, pi.substituteArgs(t, args)]);
  });

  test("stripFrontmatter", async () => {
    const pi = await piModule("dist/utils/frontmatter.js");
    for (const file of files) expect([file, stripFrontmatter(file)]).toEqual([file, pi.stripFrontmatter(file)]);
  });

  test("a prompt template, read from the file getCommands names", async () => {
    const pi = await piModule("dist/core/prompt-templates.js");
    const dir = mkdtempSync(join(tmpdir(), "pstack-slash-"));
    try {
      const content = "---\ndescription: t\n---\nfirst=$1 rest=${@:2}\n";
      writeFileSync(join(dir, "review.md"), content);
      const commands = [{ name: "review", source: "prompt", sourceInfo: { path: join(dir, "review.md") } }];
      const loaded = [{ name: "review", content: stripFrontmatter(content) }];
      for (const text of ["/review a 'b c' d", "/review", "/review\ta", "/reviewx a", "review a", "/other a"]) {
        expect([text, expandSlash(commands, text)]).toEqual([text, pi.expandPromptTemplate(text, loaded)]);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("an empty quoted argument is kept, as in pi 1.4.0", () => {
  expect(parseCommandArgs(`a "" '' b`)).toEqual(["a", "", "", "b"]);
});

test("a quote opens only at the start of an argument, takes a backslash escape, and is text when it never closes, as in pi 1.5.1", () => {
  expect(parseCommandArgs(quoteRules)).toEqual(['--title="fix', 'bug"', "it's", 'say "hi"', "it's", "a\\b", '"open', "'quote"]);
});
