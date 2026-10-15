#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function profileBinding(model) {
  if (typeof model !== "string" || !model || /[\s\x00-\x1f\x7f]/u.test(model) || ["auto", "inherit-parent"].includes(model)) {
    throw new Error("model must be a concrete, nonempty UID without whitespace or control characters");
  }
  const name = `pstack-model-${createHash("sha256").update(model).digest("hex").slice(0, 24)}`;
  const content = `---
name: ${name}
description: Executes a complete pstack task on the configured model
model: ${JSON.stringify(model)}
---

Follow the workflow and role instructions at the absolute paths in your task.
Read those files in full before working. The task must supply its full brief,
working directory, write permissions, and expected result. If a required detail
is missing, report it to the parent instead of guessing. Keep your work inside
the assigned worktree. Do not spawn nested subagents unless this profile is
explicitly configured for nesting and the task authorizes it.
`;
  return { name, content: Buffer.from(content) };
}

export function ensureDevinProfile({ model, agentsDir }) {
  const { name, content } = profileBinding(model);
  if (typeof agentsDir !== "string" || !agentsDir.trim()) throw new Error("agentsDir must be a nonempty directory path");
  const path = join(agentsDir, `${name}.md`);
  mkdirSync(agentsDir, { recursive: true });
  try {
    writeFileSync(path, content, { flag: "wx" });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    if (!readFileSync(path).equals(content)) throw new Error(`profile conflict at ${path}; existing file was preserved`);
  }
  return { name, path };
}

function main(args) {
  const usage = "usage: devin-profile.mjs --model UID (--agents-dir DIR | --name-only)";
  let model, agentsDir, nameOnly = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--name-only" && !nameOnly) nameOnly = true;
    else if (arg === "--model" && model === undefined && args[i + 1] && !args[i + 1].startsWith("--")) model = args[++i];
    else if (arg === "--agents-dir" && agentsDir === undefined && args[i + 1] && !args[i + 1].startsWith("--")) agentsDir = args[++i];
    else throw new Error(usage);
  }
  if (!model || (nameOnly ? agentsDir !== undefined : agentsDir === undefined)) throw new Error(usage);
  console.log(nameOnly ? profileBinding(model).name : ensureDevinProfile({ model, agentsDir }).name);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
