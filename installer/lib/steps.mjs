import { spawnSync } from "node:child_process";
import {
  cpSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  symlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { which } from "./detect.mjs";
import { withoutNodeModules } from "./bundle.mjs";

export function describeStep(step) {
  switch (step.kind) {
    case "run":
      return `run: ${step.argv.join(" ")}`;
    case "copy":
      return `copy: ${step.from} -> ${step.to}`;
    case "link-skills":
      return `link each skill under ${step.from} into ${step.to}`;
    case "manual":
      return ["in your agent session:", ...step.lines.map((l) => `    ${l}`)].join("\n");
  }
}

// cmd.exe needs one quoted command line for a .cmd or .bat shim.
const winQuote = (arg) => `"${arg.replace(/"/g, '""')}"`;

function spawnArgv(argv, ctx) {
  const [bin, ...args] = argv;
  const file = which(bin, ctx) ?? bin;
  const result =
    ctx.platform === "win32" && /\.(cmd|bat)$/i.test(file)
      ? spawnSync([file, ...args].map(winQuote).join(" "), { stdio: "inherit", shell: true })
      : spawnSync(file, args, { stdio: "inherit" });
  if (result.error) return { ok: false, detail: result.error.message };
  return result.status === 0
    ? { ok: true }
    : { ok: false, detail: `exit ${result.status ?? result.signal}` };
}

const exists = (path) => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

// Each executor returns { ok, skipped?, detail? }.
const EXECUTORS = {
  run: (step, ctx) => spawnArgv(step.argv, ctx),
  manual: () => ({ ok: true, manual: true }),
  copy: (step) => {
    if (exists(step.to)) {
      return { ok: true, skipped: true, detail: `${step.to} already present, see README update steps` };
    }
    mkdirSync(dirname(step.to), { recursive: true });
    cpSync(step.from, step.to, { recursive: true, filter: withoutNodeModules(step.from) });
    return { ok: true };
  },
  "link-skills": (step, ctx) => {
    mkdirSync(step.to, { recursive: true });
    const names = readdirSync(step.from, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    const kept = [];
    for (const name of names) {
      const target = join(step.to, name);
      if (exists(target)) {
        kept.push(name);
        continue;
      }
      symlinkSync(join(step.from, name), target, ctx.platform === "win32" ? "junction" : "dir");
    }
    const linked = names.length - kept.length;
    return {
      ok: true,
      skipped: linked === 0,
      detail: `${linked} linked, ${kept.length} already present`,
    };
  },
};

export function execute(step, ctx) {
  try {
    return EXECUTORS[step.kind](step, ctx);
  } catch (error) {
    return { ok: false, detail: error.message };
  }
}
