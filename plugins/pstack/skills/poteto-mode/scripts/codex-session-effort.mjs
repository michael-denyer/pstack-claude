#!/usr/bin/env node
// Read only the current thread's active-turn metadata; never infer from config
// defaults, another thread, or a completed turn. Output contains no transcript.
import { createReadStream, existsSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
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

async function currentRollout(threadId, home) {
  const databases = readdirSync(home).filter((name) => /^state_\d+\.sqlite$/.test(name));
  if (databases.length > 1) throw new Error("current thread state database is ambiguous");
  const sqlite = databases.length === 1 ? await import("node:sqlite").catch(() => null) : null;
  if (sqlite) {
    const db = new sqlite.DatabaseSync(join(home, databases[0]), { readOnly: true });
    try {
      const row = db.prepare("SELECT rollout_path FROM threads WHERE id = ?").get(threadId);
      if (row) {
        const path = row.rollout_path;
        if (typeof path !== "string" || !isAbsolute(path) || !path.endsWith(".jsonl")) {
          throw new Error("current thread runtime log is unavailable");
        }
        return path;
      }
    } finally {
      db.close();
    }
  }

  const root = join(home, "sessions");
  const matches = [];
  const suffix = new RegExp(`-${threadId}(?:_[a-zA-Z0-9-]+)?\\.jsonl(?:\\.zst)?$`);
  const walk = (directory, depth = 0) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isFile() && entry.name.startsWith("rollout-") && suffix.test(entry.name)) matches.push(path);
      else if (entry.isDirectory() && depth < 3) walk(path, depth + 1);
    }
  };
  walk(root);
  if (matches.length !== 1 || !matches[0].endsWith(`-${threadId}.jsonl`)) {
    throw new Error("current thread runtime log is missing or ambiguous");
  }
  return matches[0];
}

export async function sessionEffort(threadId = process.env.CODEX_THREAD_ID, codexHome = process.env.CODEX_HOME) {
  if (!threadId || !/^[a-zA-Z0-9_-]+$/.test(threadId)) throw new Error("CODEX_THREAD_ID is unavailable or invalid");
  const home = codexHome || join(homedir(), ".codex");
  const path = await currentRollout(threadId, home);
  return activeEffort(createReadStream(path, { encoding: "utf8" }), threadId);
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify({ effort: await sessionEffort() }));
  } catch {
    console.log(JSON.stringify({ effort: null, reason: "Current Codex turn effort is unavailable; choose an explicit effort before dispatching." }));
    process.exitCode = 1;
  }
}
