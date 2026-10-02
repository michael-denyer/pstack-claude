#!/usr/bin/env node
// Locate the transcript whose opening user prompt carries a fragment.
//
//   node find-transcript.mjs <transcripts-dir> <opening-prompt-fragment>
//
// Prints the newest matching path, or exits 1 with "no transcript". Covers
// Claude Code's three layouts under one per-project directory (flat
// <id>.jsonl, nested <id>/<id>.jsonl, subagent <id>/subagents/<child>.jsonl)
// and Pi's <iso>_<id>.jsonl under its per-cwd sessions directory, told apart
// by Pi's session header line. Each candidate is streamed line by line; a
// Claude Code transcript is abandoned at its first typed `user` record, while a
// Pi session is read to its last entry to find the active branch.
import { createReadStream, readdirSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

// readline also breaks on U+2028 and U+2029, which JSON leaves unescaped.
async function* jsonlLines(stream) {
  let rest = "";
  for await (const chunk of stream) {
    const parts = (rest + chunk).split("\n");
    rest = parts.pop();
    yield* parts;
  }
  if (rest) yield rest;
}

export function candidates(projectsDir, maxDepth = 2) {
  const files = [];
  const walk = (dir, depth) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(full);
      else if (entry.isDirectory() && depth < maxDepth) walk(full, depth + 1);
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

// `user` records Claude Code writes for a local command (/clear, !cmd) and its
// output, not a prompt the user typed. A skill invocation leads with
// <command-message> and is kept: its <command-args> carry what the user typed.
const LOCAL_COMMAND = /^\s*<(?:command-name|local-command-stdout|bash-input)>/u;

// A Pi session opens with this header line; Claude Code transcripts never do.
const isPiHeader = (record) =>
  record?.type === "session" && Number.isInteger(record.version) && typeof record.cwd === "string";

async function* parsed(lines) {
  for await (const line of lines) {
    try {
      yield JSON.parse(line);
    } catch {}
  }
}

async function* prepend(head, rest) {
  yield head;
  yield* rest;
}

// A Claude Code transcript opens with the first prompt the user typed.
async function claudeOpening(records) {
  for await (const record of records) {
    if (record?.type !== "user" || record.isMeta) continue;
    const prompt = text(record.message?.content);
    if (prompt && !LOCAL_COMMAND.test(prompt)) return prompt;
  }
  return null;
}

// Pi branches in place: every entry is appended to one file and linked to its
// parent by id, and the last entry is the current leaf. The opening prompt is
// the first user message on the path from that leaf to its root, which may not
// be the first one in file order.
async function piOpening(records) {
  const entries = new Map();
  let leaf = null;
  for await (const record of records) {
    if (typeof record?.id !== "string") continue;
    const isUser = record.type === "message" && record.message?.role === "user";
    entries.set(record.id, { parentId: record.parentId ?? null, prompt: isUser ? text(record.message.content) || null : null });
    leaf = record.id;
  }
  let prompt = null;
  const seen = new Set();
  for (let id = leaf; entries.has(id) && !seen.has(id); id = entries.get(id).parentId) {
    seen.add(id);
    prompt = entries.get(id).prompt ?? prompt;
  }
  return prompt;
}

export async function openingPrompt(path) {
  const stream = createReadStream(path, { encoding: "utf8" });
  try {
    const records = parsed(jsonlLines(stream));
    const { value: head, done } = await records.next();
    if (done) return null;
    return await (isPiHeader(head) ? piOpening(records) : claudeOpening(prepend(head, records)));
  } finally {
    stream.destroy();
  }
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
    console.error("usage: find-transcript.mjs <transcripts-dir> <opening-prompt-fragment>");
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

// node leaves argv[1] unresolved and may set it to a non-file (`node -e ... arg`).
function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return fileURLToPath(import.meta.url) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  process.exitCode = await main(process.argv.slice(2));
}
