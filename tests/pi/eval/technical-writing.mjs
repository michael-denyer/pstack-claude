// `technical-writing` on a deploy how-to planted with violations of each layer:
// a title-case topic heading, a background digression, bullets for a sequence,
// passive "should be" steps, a trailing condition, semicolons, an em dash,
// slashes, "(s)", Latin abbreviations, "simply"/"easy"/"quickly", "please",
// "click here", and filler. FACTS are the commands and numbers the rewrite keeps.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { firstUserText, MINUTE, settled, writeFiles } from "../eval-lib.mjs";
import { headings, prose, TELLS, titleCased, violates } from "./unslop.mjs";

const SOURCE = "docs/deploy.md";
const REWRITE = "docs/deploy.rewritten.md";
const fixture = (name) => readFileSync(new URL(`./fixtures/technical-writing/${name}`, import.meta.url), "utf8");

// [requirement, pattern that must not match the rewrite's prose]
const BANNED = [
  ['"Use periods, not semicolons."', /;/],
  ['"Replace an em dash with a new sentence."', /[—–]/],
  ['"No slashes: write a, b, or both"', /\w\/\w/],
  ['"Never form plurals with (s)."', /\(s\)/],
  ['"Skip ... Latin abbreviations" and "Drop etc."', /\b(e\.g|i\.e|etc)\b/i],
  ['never "simply", "easy", or "quickly" in a procedure', /\b(simply|easy|easily|quickly)\b/i],
  ['no "please" in instructions', /\bplease\b/i],
  ['links say where they go, never "click here"', /click here/i],
  ['instructions as commands, never "should be done"', /\bshould be\b/i],
  ['"In order to" is "to"; "use", not "utilize"; "do", not "perform"', /\b(in order to|utiliz\w*|perform(s|ed|ing)?)\b/i],
];

const FACTS = [
  ["make image", /make image/],
  ["deployctl push --env staging", /deployctl push --env staging/],
  ["/healthz", /\/healthz/],
  ["port 8443", /\b8443\b/],
  ["90 seconds", /\b90\b/],
  ["deployctl rollback", /deployctl rollback/],
  ["deployctl promote", /deployctl promote/],
  ["#deploys", /#deploys/],
  ["the same image digest", /image digest/i],
];

const PASSIVE = /\b(is|are|be|been|was|were)\s+(then\s+)?(\w+ed|built|done|run|taken|sent|seen)\b/i;
const numbered = (md) => md.split("\n").filter((l) => /^\s*\d+\.\s/.test(l));

export default {
  name: "technical-writing",
  setup(w) {
    writeFiles(w.work, { [SOURCE]: fixture("deploy.md") });
    w.git("add", ".");
    w.git("commit", "-q", "-m", "Add deploy doc");
  },
  drive: (w, { piPrint }) =>
    piPrint(
      w,
      `/skill:technical-writing ${SOURCE} is the how-to our on-call engineers follow to deploy the service. ` +
        `Rewrite it into a new file, ${REWRITE}, and leave ${SOURCE} as it is. You have full autonomy, so do not ask me anything.`,
      { timeoutMs: 15 * MINUTE },
    ),
  checks({ w, run, t }) {
    const path = join(w.work, REWRITE);
    const out = existsSync(path) ? readFileSync(path, "utf8") : "";
    const text = prose(out);
    const h1s = headings(out).filter((h) => /^#\s/.test(h));
    const steps = numbered(out);
    const rollback = out.split("\n").filter((l) => l.includes("deployctl rollback"));
    return [
      ["pi exited 0 and settled", run.status === 0 && settled(run)],
      ["the prompt carried the skill", firstUserText(t).includes('<skill name="technical-writing"')],
      ["the rewrite exists", out.trim().length > 0],
      ["the source doc is unchanged", w.git("status", "--porcelain", "--", SOURCE) === ""],
      // "Propose a new offender ... as an addition to unslop's abstract-metaphor rule in your reply. Don't edit that skill."
      ["no skill file was edited", !t.allCalls().some((c) => (c.name === "edit" || c.name === "write") && /skills\//.test(String(c.args.path)))],
      ["one h1 per page", h1s.length === 1],
      ['how-to: "Name the guide by the task", a bare verb phrase', h1s.length === 1 && /^#\s+(how to\s+)?deploy\b/i.test(h1s[0])],
      ["headings in sentence case", out !== "" && titleCased(out).length === 0],
      ['how-to: "no digressions, no background ... Link those instead"', out !== "" && !/\b(2019|heroku|billing)\b/i.test(text)],
      ['"Numbered lists for sequences": the steps are numbered', steps.length >= 3 && !text.split("\n").some((l) => /^\s*[-*+]\s.*(make image|deployctl push|deployctl promote)/.test(l))],
      ['"Write procedures as direct commands, never ... in the passive"', steps.length >= 3 && !steps.some((s) => PASSIVE.test(prose(s)))],
      ['"Put the condition before the instruction": no "if" trails deployctl rollback', rollback.length > 0 && !rollback.some((l) => /deployctl rollback[^.]*\bif\b/i.test(l))],
      ...BANNED.map(([req, re]) => [req, out !== "" && !violates(out, re)]),
      // "Apply the unslop skill to every doc this skill touches."
      ["unslop's tells are absent too", out !== "" && TELLS.every(([, , re]) => !violates(out, re))],
      ...FACTS.map(([fact, re]) => [`keeps ${fact}`, re.test(out)]),
    ];
  },
};
