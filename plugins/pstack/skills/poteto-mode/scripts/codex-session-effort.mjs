#!/usr/bin/env node
// Read only the current thread's active-turn metadata; never infer from config
// defaults, another thread, or a completed turn. Output contains no transcript.
import { createReadStream, existsSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const levels = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);

export async function activeEffort(stream, threadId) {
  let rest = "";
  let sessionId;
  let turnId;
  let effort;
  const record = (line) => {
    if (!line) return;
    const row = JSON.parse(line);
    const data = row?.payload;
    if (row?.type === "session_meta") sessionId = data?.id;
    if (row?.type === "event_msg" && data?.type === "task_started") {
      turnId = data.turn_id;
      effort = undefined;
    }
    if (row?.type === "turn_context" && turnId && data?.turn_id === turnId) effort = data.effort;
    if (row?.type === "event_msg" && data?.type === "task_complete" && data.turn_id === turnId) {
      turnId = undefined;
      effort = undefined;
    }
  };
  // Split only on LF: JSON strings can contain literal U+2028 and U+2029.
  for await (const chunk of stream) {
    const lines = (rest + chunk).split("\n");
    rest = lines.pop();
    for (const line of lines) record(line);
  }
  if (rest) record(rest);
  if (sessionId !== threadId) throw new Error("runtime log does not identify the current thread");
  if (!turnId || !levels.has(effort)) throw new Error("current turn has no explicit effort metadata");
  return effort;
}

export async function sessionEffort(env = process.env) {
  const threadId = env.CODEX_THREAD_ID;
  if (!threadId || !/^[a-zA-Z0-9_-]+$/.test(threadId)) throw new Error("CODEX_THREAD_ID is unavailable or invalid");
  const root = join(env.CODEX_HOME || join(homedir(), ".codex"), "sessions");
  const matches = [];
  const walk = (directory, depth = 0) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(`-${threadId}.jsonl`)) matches.push(path);
      else if (entry.isDirectory() && depth < 3) walk(path, depth + 1);
    }
  };
  walk(root);
  if (matches.length !== 1) throw new Error("current thread runtime log is missing or ambiguous");
  return activeEffort(createReadStream(matches[0], { encoding: "utf8" }), threadId);
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify({ effort: await sessionEffort() }));
  } catch {
    console.log(JSON.stringify({ effort: null, reason: "Current Codex turn effort is unavailable; choose an explicit effort before dispatching." }));
    process.exitCode = 1;
  }
}
