#!/usr/bin/env bun
// Runs pstack workflows on real pi and checks each run against what its skill
// requires, read from pi's own session files and the repo afterwards. Costs
// real model calls, so it is a script, not a test.
//
//   bun tests/pi/eval.mjs [--only interrogate,how] [--runs 3] [--jobs 3] [--keep] [--guards]
//
// Scenarios come from eval-scenarios.mjs and every tests/pi/eval/*.mjs; the
// contract is in eval-lib.mjs. --guards builds one world per selected scenario,
// prints the GitHub writes it refused, and runs no model.
//
// Picks models like the live suite: PSTACK_PI_LIVE_PROVIDER and
// PSTACK_PI_LIVE_MODELS. A run with a failed check keeps its directory.
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { guardCheck, makeWorld, piPrint, trace } from "./eval-lib.mjs";
import { scenarios as builtIn } from "./eval-scenarios.mjs";
import { PiRpc } from "./harness.mjs";

const { values: opts } = parseArgs({
  options: {
    only: { type: "string" },
    runs: { type: "string", default: "3" },
    jobs: { type: "string", default: "3" },
    keep: { type: "boolean", default: false },
    guards: { type: "boolean", default: false },
  },
});

const evalDir = fileURLToPath(new URL("./eval/", import.meta.url));
const files = existsSync(evalDir) ? readdirSync(evalDir).filter((f) => f.endsWith(".mjs")).sort() : [];
const scenarios = [...builtIn];
for (const f of files) scenarios.push(...[(await import(join(evalDir, f))).default].flat());
const dupes = scenarios.map((s) => s.name).filter((n, i, all) => all.indexOf(n) !== i);
if (dupes.length) throw new Error(`duplicate scenario names: ${dupes.join(", ")}`);

const only = opts.only?.split(",");
const selected = scenarios.filter((s) => !only || only.includes(s.name));
if (only && selected.length < only.length) throw new Error(`unknown scenario in --only; known: ${scenarios.map((s) => s.name).join(", ")}`);

if (opts.guards) {
  for (const s of selected) {
    const w = await makeWorld(s);
    for (const a of guardCheck(w)) console.log(`[${s.name}] ${a.refused ? "refused" : "ALLOWED"}  $ ${a.command}  (exit ${a.status})\n    ${a.output.replaceAll("\n", "\n    ")}`);
    rmSync(w.root, { recursive: true, force: true });
  }
  process.exit(0);
}

async function pool(items, size, fn) {
  const queue = [...items];
  await Promise.all(Array.from({ length: size }, async () => {
    while (queue.length) await fn(queue.shift());
  }));
}

const runs = Number(opts.runs);
const results = [];
await pool(
  selected.flatMap((s) => Array.from({ length: runs }, (_, i) => ({ s, n: i + 1 }))),
  Number(opts.jobs),
  async ({ s, n }) => {
    const started = Date.now();
    let w;
    let checks;
    let error;
    try {
      w = await makeWorld(s);
      await s.setup?.(w);
      const run = await s.drive(w, { piPrint, PiRpc });
      checks = await s.checks({ w, run, t: trace(w) });
    } catch (e) {
      error = e;
      checks = [["the run finished without an error", false]];
    }
    const failed = checks.filter(([, ok]) => !ok);
    results.push({ s: s.name, n, checks });
    const kept = w && (failed.length || opts.keep);
    console.log(
      `[${s.name} #${n}] ${checks.length - failed.length}/${checks.length} checks in ${Math.round((Date.now() - started) / 1000)} s` +
        (kept ? `, kept ${w.root}` : ""),
    );
    for (const [name] of failed) console.log(`    FAIL  ${name}`);
    if (error) console.log(`    ${error.stack}`);
    if (w && !kept) rmSync(w.root, { recursive: true, force: true });
  },
);

console.log("\nscenario       passes  check");
let allPassed = true;
for (const s of selected) {
  const mine = results.filter((r) => r.s === s.name);
  const names = [...new Set(mine.flatMap((r) => r.checks.map(([name]) => name)))];
  for (const name of names) {
    const passes = mine.filter((r) => r.checks.some(([c, ok]) => c === name && ok)).length;
    if (passes < mine.length) allPassed = false;
    console.log(`${s.name.padEnd(14)} ${`${passes}/${mine.length}`.padEnd(7)} ${name}`);
  }
}
process.exit(allPassed ? 0 : 1);
