// `unslop` on a short product doc planted with the tells its rules name. Each
// planted tell is a row of TELLS, named by its rule id; FACTS are the numbers and
// names the rewrite must keep, since the skill's step 2 says "Preserve meaning".
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { firstUserText, MINUTE, settled, writeFiles } from "../eval-lib.mjs";

const SOURCE = "docs/cachectl.md";
const REWRITE = "docs/cachectl.unslopped.md";
const fixture = (name) => readFileSync(new URL(`./fixtures/unslop/${name}`, import.meta.url), "utf8");

// The text a reader reads: fenced and inline code become CODE, link targets and
// bare URLs go, so a rule never fires on a command or a path.
export const prose = (md) =>
  md
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`\n]+`/g, "CODE")
    .replace(/\]\([^)]*\)/g, "]")
    .replace(/https?:\/\/\S+/g, "");

const PROPER = new Set(["Redis", "March", "Heroku", "I"]);
export const headings = (md) => prose(md).split("\n").filter((l) => /^#{1,6}\s/.test(l));
// Rule 17 / Google style: sentence case. A capitalized word after the first is a
// violation unless it is a proper noun the doc uses or an acronym.
export const titleCased = (md) =>
  headings(md).filter((h) =>
    h
      .replace(/^#+\s*/, "")
      .split(/\s+/)
      .slice(1)
      .some((word) => /^[A-Z][a-z]/.test(word) && !PROPER.has(word.replace(/\W+$/, ""))),
  );

// [rule, requirement, pattern that must not match the rewrite's prose]
export const TELLS = [
  [3, "no superficial -ing phrases", /\b(ensuring|showcasing|highlighting|reflecting|fostering)\b/i],
  [5, "no vague attributions", /\b(experts believe|industry reports|some critics)\b/i],
  [7, "no AI vocabulary", /\b(additionally|crucial|delve|enduring|enhance|garner|interplay|intricate|landscape|pivotal|showcase|tapestry|testament|underscore|vibrant)\b/i],
  [8, 'no fancy "is" (serves as, stands as, boasts)', /\b(serves as|stands as|boasts)\b/i],
  [9, 'no "not just X, but Y"', /\bnot just\b[^.\n]*\bbut\b/i],
  // Rule 13 bans the dash's substitutes too: "no parentheses, no en dashes, no
  // hyphen-as-dash substitutes. If a thought needs separation, end the sentence
  // or use a comma." A bare acronym gloss such as "(LRU)" separates no thought.
  [13, "no em dash or its substitutes", /[—–]|\s--?\s|\((?![A-Z0-9]{2,6}\))/],
  [16, "no inline-header bold labels", /\*\*[^*\n]+:\*\*|\*\*[^*\n]+\*\*:/],
  [18, "no decorative emojis", /\p{Extended_Pictographic}/u],
  [19, "no curly quotes", /[“”‘’]/],
  [20, "no chatbot phrases", /\b(hope this helps|let me know|of course|certainly)\b/i],
  [22, "no sycophantic tone", /\b(great question|absolutely right)\b/i],
  [23, "no filler phrases", /\b(in order to|due to the fact|it is important to note)\b/i],
  [25, "no generic conclusion", /\bfuture looks bright\b/i],
  [31, "the plain word over the fancy one", /\b(utiliz\w*|leverag\w*|facilitat\w*|numerous)\b/i],
];

// Rule 13's prose lines with their list markers stripped, so "- item" is not a dash.
const lines = (md) => prose(md).split("\n").map((l) => l.replace(/^\s*([-*+]|\d+\.)\s+/, ""));
export const violates = (md, re) => lines(md).some((l) => re.test(l));

// Rule 14: a colon may end a line before a list or introduce an example, never join two clauses.
export const midSentenceColon = (md) => lines(md).some((l) => /:\s*(?!CODE)\S/.test(l.replace(/:\s*$/, "")));

const FACTS = [
  ["cachectl warm", /cachectl warm/],
  ["50 keys", /\b50\b/],
  ["300 seconds", /\b300\b/],
  ["--max-entries", /--max-entries/],
  ["10000", /\b10,?000\b/],
  ["LRU eviction", /\bLRU\b|least[- ]recently[- ]used/i],
  ["Redis 7.2", /Redis 7\.2/],
  ["42 ms", /\b42\s?ms\b/],
  ["6 ms", /\b6\s?ms\b/],
  ["p95", /\bp95\b/i],
];

export default {
  name: "unslop",
  setup(w) {
    writeFiles(w.work, { [SOURCE]: fixture("cachectl.md") });
    w.git("add", ".");
    w.git("commit", "-q", "-m", "Add cachectl doc");
  },
  drive: (w, { piPrint }) =>
    piPrint(
      w,
      `/skill:unslop Rewrite ${SOURCE} into a new file, ${REWRITE}, and leave ${SOURCE} as it is. ` +
        "You have full autonomy, so do not ask me anything.",
      { timeoutMs: 15 * MINUTE },
    ),
  checks({ w, run, t }) {
    const path = join(w.work, REWRITE);
    const out = existsSync(path) ? readFileSync(path, "utf8") : "";
    return [
      ["pi exited 0 and settled", run.status === 0 && settled(run)],
      ["the prompt carried the skill", firstUserText(t).includes('<skill name="unslop"')],
      ["the rewrite exists", out.trim().length > 0],
      ["the source doc is unchanged", w.git("status", "--porcelain", "--", SOURCE) === ""],
      ...TELLS.map(([rule, req, re]) => [`rule ${rule}: ${req}`, out !== "" && !violates(out, re)]),
      ["rule 14: no colon as a mid-sentence connector", out !== "" && !midSentenceColon(out)],
      ["rule 17: headings in sentence case", out !== "" && titleCased(out).length === 0],
      ...FACTS.map(([fact, re]) => [`step 2 preserves meaning: keeps ${fact}`, re.test(out)]),
    ];
  },
};
