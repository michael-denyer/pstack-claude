import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

import { bundledPluginSource, stableDir, stagePlugin } from "./bundle.mjs";
import { detect } from "./detect.mjs";
import { HARNESSES } from "./harnesses.mjs";
import { describeStep, execute } from "./steps.mjs";

const USAGE = `Usage: open-pstack [options]

Install pstack into the agent harnesses on this machine.

Options:
  --only <ids>   comma list of harness ids to install into
  --yes          install into every detected harness, no prompt
  --dry-run      print every step, run nothing, write nothing
  --list         show the harnesses and which are detected
  --version      print the version
  --help         show this help

Harness ids: ${HARNESSES.map((h) => h.id).join(", ")}
Run in a terminal for an interactive picker, or pass --only or --yes.
`;

function version() {
  const packageJson = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
  return JSON.parse(readFileSync(packageJson, "utf8")).version;
}

class UsageError extends Error {}

const idList = (value) =>
  value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

function parseArgs(argv) {
  const opts = { only: null, yes: false, dryRun: false, list: false, version: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--only") {
      const value = argv[++i];
      if (!value) throw new UsageError("--only needs a comma list of ids");
      opts.only = idList(value);
    } else if (arg.startsWith("--only=")) {
      opts.only = idList(arg.slice(7));
      if (opts.only.length === 0) throw new UsageError("--only needs a comma list of ids");
    }
    else if (arg === "--yes" || arg === "-y") opts.yes = true;
    else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--list") opts.list = true;
    else if (arg === "--version") opts.version = true;
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else throw new UsageError(`unknown argument: ${arg}`);
  }
  return opts;
}

function pickByIds(ids) {
  const unknown = ids.filter((id) => !HARNESSES.some((h) => h.id === id));
  if (unknown.length) throw new UsageError(`unknown harness id: ${unknown.join(", ")}`);
  return HARNESSES.filter((h) => ids.includes(h.id));
}

function printList(detected) {
  HARNESSES.forEach((h, i) => {
    const mark = detected.has(h.id) ? "x" : " ";
    console.log(`  ${String(i + 1).padStart(2)}. [${mark}] ${h.id.padEnd(9)} ${h.name}`);
  });
}

async function chooseInteractively(detected, rl) {
  console.log("Agent harnesses ([x] = found on PATH):");
  printList(detected);
  const answer = (
    await rl.question("Install into [Enter = detected, a = all, or numbers/ids like 1,3,pi]: ")
  ).trim();
  if (answer === "") return HARNESSES.filter((h) => detected.has(h.id));
  if (answer === "a") return HARNESSES;
  const tokens = answer.split(/[,\s]+/).filter(Boolean);
  return pickByIds(tokens.map((t) => HARNESSES[Number(t) - 1]?.id ?? t));
}

// Runs one harness's steps, stopping at its first failure.
function installHarness(harness, ctx, detected) {
  if (harness.bin !== null && !detected.has(harness.id)) {
    return { status: "failed", detail: `${harness.bin} not found on PATH` };
  }
  const outcomes = [];
  for (const step of harness.steps(ctx)) {
    console.log(`  ${describeStep(step)}`);
    const outcome = execute(step, ctx);
    if (outcome.detail) console.log(`  ${outcome.detail}`);
    if (!outcome.ok) return { status: "failed", detail: outcome.detail };
    outcomes.push(outcome);
  }
  if (outcomes.some((o) => o.manual)) return { status: "manual" };
  if (outcomes.every((o) => o.skipped)) return { status: "skipped" };
  return { status: "ok" };
}

// The only variables the installer reads; nothing else is looked at or passed on.
function readEnv() {
  const { PATH, Path, PATHEXT, XDG_DATA_HOME, MINIMAX_DATA_DIR } = process.env;
  const env = { PATH, Path, PATHEXT, XDG_DATA_HOME, MINIMAX_DATA_DIR };
  return Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined));
}

export async function main(argv) {
  const env = readEnv();
  const platform = process.platform;
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (error) {
    console.error(`${error.message}\n\n${USAGE}`);
    return 2;
  }
  if (opts.help) {
    console.log(USAGE);
    return 0;
  }
  if (opts.version) {
    console.log(version());
    return 0;
  }

  const ctx = { home: homedir(), env, platform, pluginDir: null };
  ctx.pluginDir = stableDir(ctx);
  const detected = new Set(HARNESSES.filter((h) => detect(h, ctx)).map((h) => h.id));
  if (opts.list) {
    printList(detected);
    return 0;
  }

  const interactive = !opts.only && !opts.yes;
  if (interactive && !(process.stdin.isTTY && process.stdout.isTTY)) {
    console.error(`No terminal to ask in.\n\n${USAGE}`);
    return 2;
  }

  let selected;
  let rl = null;
  try {
    if (opts.only) selected = pickByIds(opts.only);
    else if (opts.yes) selected = HARNESSES.filter((h) => detected.has(h.id));
    else {
      rl = createInterface({ input: process.stdin, output: process.stdout });
      selected = await chooseInteractively(detected, rl);
    }
  } catch (error) {
    rl?.close();
    if (!(error instanceof UsageError)) throw error;
    console.error(`${error.message}\n\n${USAGE}`);
    return 2;
  }

  if (selected.length === 0) {
    rl?.close();
    console.log("Nothing selected.");
    return 0;
  }

  const needsBundle = selected.some((h) => h.needsBundle);
  const source = needsBundle ? bundledPluginSource() : null;
  console.log(opts.dryRun ? "\nPlanned steps (dry run, nothing will change):" : "\nPlanned steps:");
  if (needsBundle) console.log(`\nstage the bundled plugin: ${source} -> ${ctx.pluginDir}`);
  for (const h of selected) {
    console.log(`\n${h.id} (${h.name})`);
    for (const step of h.steps(ctx)) console.log(`  ${describeStep(step)}`);
  }

  if (opts.dryRun) {
    rl?.close();
    return 0;
  }
  if (rl) {
    const go = (await rl.question("\nProceed? [Y/n] ")).trim().toLowerCase();
    rl.close();
    if (go !== "" && go !== "y" && go !== "yes") {
      console.log("Cancelled.");
      return 0;
    }
  }

  if (needsBundle) {
    console.log(`\nStaging the bundled plugin at ${ctx.pluginDir}`);
    try {
      stagePlugin(source, ctx.pluginDir);
    } catch (error) {
      console.error(`Could not stage the plugin at ${ctx.pluginDir}: ${error.message}`);
      return 1;
    }
  }

  const results = [];
  for (const h of selected) {
    console.log(`\n== ${h.id} ==`);
    results.push([h, installHarness(h, ctx, detected)]);
  }

  console.log("\nSummary");
  for (const [h, r] of results) {
    console.log(`  ${h.id.padEnd(9)} ${r.status}${r.detail ? ` (${r.detail})` : ""}`);
  }
  return results.some(([, r]) => r.status === "failed") ? 1 : 0;
}
