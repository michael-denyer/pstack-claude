#!/usr/bin/env node
// Locate the transcript whose opening user prompt carries a fragment.
//
//   node find-transcript.mjs <transcripts-dir> <opening-prompt-fragment> [workspace]
//
// Prints the newest matching path, or exits 1 with "no transcript". Covers
// Claude Code's three layouts under one per-project directory (flat
// <id>.jsonl, nested <id>/<id>.jsonl, subagent <id>/subagents/<child>.jsonl)
// Pi's <iso>_<id>.jsonl under its per-cwd sessions directory, and GitHub
// Copilot's <id>/events.jsonl under its session-state directory, told apart by
// Pi's session header line and Copilot's session.start event. Each candidate is
// streamed line by line; a Claude Code or Copilot transcript is abandoned at its
// first typed user record. Copilot searches compare the session header's cwd
// with the workspace (the current directory by default) before reading user
// messages. A Pi session is read to its last entry to find
// the active branch. A Codex rollout is refused by name rather than read as an
// empty Claude transcript.
import { createReadStream, readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
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

// Session cleanup can delete a transcript or its session directory while a
// search runs. Anything under the root that vanishes after it was listed is
// skipped; a missing root still throws.
export function rethrowUnlessRemoved(error) {
  if (error.code !== "ENOENT") throw error;
}

export function candidates(projectsDir, maxDepth = 2) {
  const files = [];
  const walk = (dir, depth) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(full);
      else if (entry.isDirectory() && depth < maxDepth) {
        try {
          walk(full, depth + 1);
        } catch (error) {
          rethrowUnlessRemoved(error);
        }
      }
    }
  };
  walk(projectsDir, 0);
  return files
    .flatMap((path) => {
      const stat = statSync(path, { throwIfNoEntry: false });
      return stat ? [{ path, mtime: stat.mtimeMs }] : [];
    })
    .sort((a, b) => b.mtime - a.mtime);
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
// A Codex rollout opens with its session metadata.
const isCodexHeader = (record) => record?.type === "session_meta";

// A Copilot events.jsonl opens with this event and records each prompt the
// user typed as a `user.message` event.
const isCopilotHeader = (record) => record?.type === "session.start" && typeof record.data === "object";

async function copilotOpening(head, records, workspace) {
  if (workspace !== undefined) {
    const cwd = head.data?.context?.cwd;
    if (typeof cwd !== "string" || !isAbsolute(cwd)) return null;
    try {
      if (realpathSync(cwd) !== realpathSync(workspace)) return null;
    } catch {
      // A removed or inaccessible workspace cannot identify this session.
      return null;
    }
  }
  for await (const record of records) {
    if (record?.type !== "user.message") continue;
    const prompt = text(record.data?.content);
    if (prompt) return prompt;
  }
  return null;
}

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

// Readers by opening record. Claude Code writes no header, so its row is last
// and takes every file the others do not claim.
const READERS = [
  [isPiHeader, (head, rest) => piOpening(rest)],
  [isCopilotHeader, (head, rest, path, workspace) => copilotOpening(head, rest, workspace)],
  [isCodexHeader, (head, rest, path) => {
    throw new Error(`${path} is a Codex rollout, which find-transcript does not read; pass the session digest instead`);
  }],
  [() => true, (head, rest) => claudeOpening(prepend(head, rest))],
];

export async function openingPrompt(path, workspace) {
  const stream = createReadStream(path, { encoding: "utf8" });
  try {
    const records = parsed(jsonlLines(stream));
    const { value: head, done } = await records.next();
    if (done) return null;
    const [, read] = READERS.find(([matches]) => matches(head));
    return await read(head, records, path, workspace);
  } finally {
    stream.destroy();
  }
}

export async function findTranscript(projectsDir, fragment, workspace = process.cwd()) {
  for (const { path } of candidates(projectsDir)) {
    try {
      const prompt = await openingPrompt(path, workspace);
      if (prompt?.includes(fragment)) return path;
    } catch (error) {
      rethrowUnlessRemoved(error);
    }
  }
  return null;
}

async function main(argv) {
  const [projectsDir, fragment, workspace] = argv;
  if (!projectsDir || !fragment || argv.length > 3) {
    console.error("usage: find-transcript.mjs <transcripts-dir> <opening-prompt-fragment> [workspace]");
    return 2;
  }
  const path = await findTranscript(projectsDir, fragment, workspace);
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
