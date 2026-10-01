// `deslop` on an uncommitted change on a branch: applyCoupon arrives with one
// instance of each Focus Area the skill names (narrating comments, a defensive
// try/catch, an `as any` cast, nesting that early returns flatten). main's
// subtotal and its comment sit outside the diff and must stay as they are.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { firstUserText, isEdit, MINUTE, node, settled, writeFiles } from "../eval-lib.mjs";

const SUBTOTAL = `export type Item = { sku: string; price: number; qty: number };

// Prices are integer cents, so a total never picks up float error.
export function subtotal(items: Item[]): number {
  return items.reduce((sum, i) => sum + i.price * i.qty, 0);
}
`;

const MAIN = {
  "package.json": `{ "type": "module", "scripts": { "test": "node --test" } }\n`,
  "src/cart.ts": SUBTOTAL,
  "src/cart.test.ts": `import assert from "node:assert/strict";
import { test } from "node:test";

import { subtotal } from "./cart.ts";

const items = [{ sku: "a", price: 250, qty: 2 }, { sku: "b", price: 99, qty: 1 }];

test("subtotal sums price times quantity", () => {
  assert.equal(subtotal(items), 599);
});
`,
};

const NARRATION = [
  "// This function applies the coupon to the subtotal",
  "// Calculate the subtotal first",
  "// Compute the discount amount",
  "// Just in case something goes wrong",
  "// Return the total",
];

const APPLY_COUPON = `
export type Coupon = { code: string; percentOff: number };

${NARRATION[0]}
export function applyCoupon(items: Item[], coupon: Coupon | undefined): number {
  ${NARRATION[1]}
  const total = subtotal(items);
  if (coupon) {
    if (coupon.percentOff > 0) {
      if (coupon.percentOff <= 100) {
        try {
          ${NARRATION[2]}
          const discount = Math.round((total * (coupon.percentOff as any)) / 100);
          return total - discount;
        } catch (error) {
          ${NARRATION[3]}
          console.error(error);
          return total;
        }
      }
    }
  }
  ${NARRATION[4]}
  return total;
}
`;

const COUPON_TESTS = `
import { applyCoupon } from "./cart.ts";

test("applyCoupon takes a percentage off", () => {
  assert.equal(applyCoupon(items, { code: "TEN", percentOff: 10 }), 539);
});

test("applyCoupon ignores a missing or out-of-range coupon", () => {
  assert.equal(applyCoupon(items, undefined), 599);
  assert.equal(applyCoupon(items, { code: "BAD", percentOff: 150 }), 599);
});
`;

// Inputs the branch's tests do not cover, with what the planted code returns for each.
const PROBE = [
  [null, 599],
  [0, 599],
  [-5, 599],
  [33, 401],
  [100, 0],
  [101, 599],
];
const probeScript = `import("./src/cart.ts").then(({ applyCoupon }) => {
  const items = [{ sku: "a", price: 250, qty: 2 }, { sku: "b", price: 99, qty: 1 }];
  const cases = ${JSON.stringify(PROBE.map(([p]) => p))};
  process.stdout.write(JSON.stringify(cases.map((p) => applyCoupon(items, p === null ? undefined : { code: "X", percentOff: p }))));
})`;

// The deepest brace nesting inside applyCoupon, counting its own body as 1.
function maxDepth(src) {
  const start = src.search(/applyCoupon\s*[=(]/);
  if (start < 0) return Infinity;
  let depth = 0;
  let max = 0;
  for (const ch of src.slice(start)) {
    if (ch === "{") max = Math.max(max, ++depth);
    if (ch === "}" && --depth === 0) break;
  }
  return max;
}

// Sentences in a reply: code is one word, and every line or terminal mark ends one.
const sentences = (text) =>
  text
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`\n]+`/g, "code")
    .split(/(?<=[.!?])\s+|\n+/)
    .filter((s) => /[a-z]/i.test(s));

export default {
  name: "deslop",
  setup(w) {
    writeFiles(w.work, MAIN);
    w.git("add", ".");
    w.git("commit", "-q", "-m", "Add cart subtotal");
    w.git("checkout", "-q", "-b", "coupons");
    writeFiles(w.work, { "src/cart.ts": SUBTOTAL + APPLY_COUPON, "src/cart.test.ts": MAIN["src/cart.test.ts"] + COUPON_TESTS });
  },
  drive: (w, { piPrint }) => piPrint(w, "/skill:deslop You have full autonomy, so do not ask me anything.", { timeoutMs: 15 * MINUTE }),
  checks({ w, run, t }) {
    const cart = readFileSync(join(w.work, "src/cart.ts"), "utf8");
    const firstEdit = Math.min(...t.allCalls().filter((c) => isEdit(c, "cart.ts")).map((c) => c.at));
    const diffed = t.calls(t.parent).some((c) => c.name === "bash" && /\bgit\b[^|;&]*\bdiff\b[^|;&]*\bmain\b/.test(String(c.args.command)) && c.resultAt <= firstEdit);
    const probe = node(w.work, "--input-type=module", "-e", probeScript);
    return [
      ["pi exited 0 and settled", run.status === 0 && settled(run)],
      ["the prompt carried the skill", firstUserText(t).includes('<skill name="deslop"')],
      ['"Check the diff against main" before the first edit', diffed],
      ["focus area: the diff's narrating comments are gone", NARRATION.every((c) => !cart.includes(c))],
      ["focus area: the defensive try/catch is gone", !/\btry\s*\{/.test(cart) && !cart.includes("console.error")],
      ["focus area: the cast to any is gone", !/\bas\s+any\b/.test(cart)],
      ["focus area: early returns flatten the nested ifs", maxDepth(cart) <= 2],
      ["slop is judged in the branch's diff only: main's subtotal and its comment are unchanged", cart.includes(SUBTOTAL)],
      ['"Keep behavior unchanged": the tests pass', node(w.work, "--test").status === 0],
      ['"Keep behavior unchanged": untested inputs return what they did', probe.stdout === JSON.stringify(PROBE.map(([, want]) => want))],
      ['"Keep the final summary concise (1-3 sentences)"', t.finalText !== "" && sentences(t.finalText).length <= 3],
    ];
  },
};
