#!/usr/bin/env node
// Locate the transcript whose opening user prompt carries a fragment.
//
//   node find-transcript.mjs <projects-dir> <opening-prompt-fragment>
//
// Prints the newest matching path, or exits 1 with "no transcript". Covers the
// three layouts under one per-project directory: flat <id>.jsonl, nested
// <id>/<id>.jsonl, and subagent <id>/subagents/<child>.jsonl. Each candidate is
// streamed line by line and abandoned at its first `user` record; the first
// line is session metadata and files run to megabytes.
import { createReadStream, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

export function candidates(projectsDir) {
  const files = [];
  const walk = (dir, depth) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(full);
      else if (entry.isDirectory() && depth < 2) walk(full, depth + 1);
    }
  };
  walk(projectsDir, 0);
  return files
    .map((path) => ({ path, mtime: statSync(path).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .map(({ path }) => path);
}

function text(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((block) => typeof block?.text === "string")
      .map((block) => block.text)
      .join("\n");
  }
  return null;
}

export async function openingPrompt(path) {
  const stream = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (record?.type === "user") return text(record.message?.content);
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  return null;
}

export async function findTranscript(projectsDir, fragment) {
  for (const path of candidates(projectsDir)) {
    const prompt = await openingPrompt(path);
    if (prompt?.includes(fragment)) return path;
  }
  return null;
}

async function main(argv) {
  const [projectsDir, fragment] = argv;
  if (!projectsDir || !fragment) {
    console.error("usage: find-transcript.mjs <projects-dir> <opening-prompt-fragment>");
    return 2;
  }
  const path = await findTranscript(projectsDir, fragment);
  if (!path) {
    console.error(`no transcript under ${projectsDir} opens with ${JSON.stringify(fragment)}`);
    return 1;
  }
  console.log(path);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
