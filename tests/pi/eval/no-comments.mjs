// `no-comments` on an uncommitted slugify module: its diff against main carries
// comment-sicko's meat (a banner, narration, commented-out code) and one of each
// keep-list exception that applies to a JS package (a license header, a doc
// comment on the package's public entry point, `// prettier-ignore`). main's
// clock.js has a narrating comment outside the scope that must survive.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { agentPrompt, firstUserText, MINUTE, node, readPiTools, settled, writeFiles } from "../eval-lib.mjs";

const CLOCK_COMMENT = "// returns the current time in milliseconds";

const MAIN = {
  "package.json": `{ "name": "slugkit", "type": "module", "exports": "./src/slug.js", "scripts": { "test": "node --test" } }\n`,
  "src/clock.js": `${CLOCK_COMMENT}\nexport const now = () => Date.now();\n`,
};

const LICENSE = ["// SPDX-License-Identifier: MIT", "// Copyright 2026 Slugkit contributors"];
const BANNER = ["// ==========================================", "// ============ SLUG HELPERS ================", "// =========================================="];
const API_DOC = `/**
 * Turns a title into a URL slug.
 * @param {string} title Any text.
 * @returns {string} Lowercase ASCII words joined by "-", at most 60 characters.
 */`;
const PRETTIER = "// prettier-ignore";
const MEAT = [
  ...BANNER,
  "// normalize the string",
  "// lowercase it",
  "// old approach, kept for reference:",
  '// const words = lower.split(" ").filter(Boolean);',
  '// return words.join("-");',
  "// then we truncate to the max length",
];

const SLUG = `${LICENSE.join("\n")}

${BANNER.join("\n")}

const MAX = 60;

${API_DOC}
export function slugify(title) {
  ${MEAT[3]}
  const ascii = title.normalize("NFKD").replace(/[\\u0300-\\u036f]/g, "");
  ${MEAT[4]}
  const lower = ascii.toLowerCase();
  ${MEAT[5]}
  ${MEAT[6]}
  ${MEAT[7]}
  const words = lower.split(/[^a-z0-9]+/).filter(Boolean);
  ${PRETTIER}
  const joined = words.join(  "-"  );
  ${MEAT[8]}
  return joined.slice(0, MAX).replace(/-+$/, "");
}
`;

const SLUG_TEST = `import assert from "node:assert/strict";
import { test } from "node:test";

import { slugify } from "./slug.js";

test("slugify lowercases and joins words with dashes", () => {
  assert.equal(slugify("Hello, World"), "hello-world");
});
`;

// Inputs the test does not cover, with what the planted slugify returns for each.
const PROBE = [
  ["Crème Brûlée: A Recipe!", "creme-brulee-a-recipe"],
  [`${"x".repeat(59)} y`, "x".repeat(59)],
  ["  --  ", ""],
];
const probeScript = `import("./src/slug.js").then(({ slugify }) => process.stdout.write(JSON.stringify(${JSON.stringify(PROBE.map(([i]) => i))}.map(slugify))))`;

// A deletion count is a number beside any deletion verb: "deleted 9", "Removed 9 comment lines", "nine comments killed".
const COUNT = String.raw`\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b`;
const DELETED = String.raw`\b(delet|remov|kill|cut|drop|strip)\w*`;
const DELETION_COUNT = new RegExp(`${COUNT}[^\\n]{0,60}${DELETED}|${DELETED}[^\\n]{0,60}${COUNT}`, "i");

export default {
  name: "no-comments",
  setup(w) {
    writeFiles(w.work, MAIN);
    w.git("add", ".");
    w.git("commit", "-q", "-m", "Add slugkit package with a clock helper");
    w.git("checkout", "-q", "-b", "slugs");
    writeFiles(w.work, { "src/slug.js": SLUG, "src/slug.test.js": SLUG_TEST });
    // Intent-to-add puts the new files in `git diff main`, the skill's default scope.
    w.git("add", "-N", "src/slug.js", "src/slug.test.js");
  },
  drive: (w, { piPrint }) => piPrint(w, "/skill:no-comments You have full autonomy, so do not ask me anything.", { timeoutMs: 20 * MINUTE }),
  checks({ w, run, t }) {
    const slug = readFileSync(join(w.work, "src/slug.js"), "utf8");
    const clock = readFileSync(join(w.work, "src/clock.js"), "utf8");
    const sickos = t.records.filter((r) => r.subagentType === "pstack:comment-sicko");
    const probe = node(w.work, "--input-type=module", "-e", probeScript);
    return [
      ["pi exited 0 and settled", run.status === 0 && settled(run)],
      ["the prompt carried the skill and its Pi preamble", firstUserText(t).includes('<skill name="no-comments"') && firstUserText(t).includes("On Pi, read the [platform mapping]")],
      ["the lead read pi-tools.md", readPiTools(t)],
      ['step 1: the lead spawned an agent with subagent_type "pstack:comment-sicko"', sickos.length >= 1],
      ["step 2: at most one rerun of comment-sicko", sickos.length <= 2],
      ["step 1: each comment-sicko prompt passes the scope", sickos.length > 0 && sickos.every((r) => /slug\.js|\bdiff\b/i.test(agentPrompt(t, r)))],
      ["step 1: no comment-sicko prompt restates its keep list", sickos.length > 0 && sickos.every((r) => !/prettier-ignore|licen[cs]e|legal|public API contract|eslint-disable|ts-ignore/i.test(agentPrompt(t, r)))],
      // comment-sicko.md: "My first output when spawned is exactly this. Yes... Ha ha ha... Yes!"
      ["comment-sicko ran from its agent file: its first output is its greeting", sickos.length > 0 && sickos.every((r) => (t.texts(t.sessionOf(r))[0]?.text ?? "").includes("Yes... Ha ha ha... Yes!"))],
      ["every comment-sicko completed", sickos.length > 0 && sickos.every((r) => r.status === "completed")],
      ["the banner, narration, and commented-out code are gone", MEAT.every((c) => !slug.includes(c))],
      ["keep list: the license header survives", LICENSE.every((c) => slug.includes(c))],
      ["keep list: the public API doc comment survives verbatim", slug.includes(API_DOC)],
      ["keep list: // prettier-ignore survives", slug.includes(PRETTIER)],
      ["scope is the diff against main: clock.js's comment survives", clock.includes(CLOCK_COMMENT)],
      ["the tests pass", node(w.work, "--test").status === 0],
      ["slugify returns what it did on untested inputs", probe.stdout === JSON.stringify(PROBE.map(([, want]) => want))],
      ["step 6: the report names the deletion count", DELETION_COUNT.test(t.finalText)],
    ];
  },
};
