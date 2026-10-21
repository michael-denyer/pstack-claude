#!/usr/bin/env node
// Print Claude Code's transcripts directory for this session.
//
//   node claude-project-dir.mjs [workspace]
//
// The directory is <config>/projects/<name>, where <config> is
// $CLAUDE_CONFIG_DIR or ~/.claude. Claude Code sets $CLAUDE_CODE_SESSION_ID in
// its shell, so the directory holding <id>.jsonl or <id>/<id>.jsonl is this
// session's, wherever the shell has moved since; only names are read. With a
// workspace argument, or without a session id, <name> is derived from the
// workspace, the current directory by default, which must be the directory the
// session started in. Claude Code
// derives <name> from that path by turning every character other than an ASCII
// letter or digit into "-". A name longer than 200 characters keeps its first 200 and gains "-"
// and a base-36 hash of the path. $CLAUDE_CODE_PROJECT_DIR_NAME replaces <name>
// when $CLAUDE_CONFIG_DIR is set too and the name is 1 to 64 letters, digits,
// "_" or "-" other than a Windows reserved device name. If the derived
// directory is missing, the one directory that shares the first 200 characters
// is taken instead, so a hash that changes in a later Claude Code release still
// resolves. Exits 1 when no directory exists.
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const MAX_NAME = 200;
// The names Claude Code 2.1.296 accepts from CLAUDE_CODE_PROJECT_DIR_NAME.
const CHOSEN_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const RESERVED_NAME = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;
// A session id names a file, so it never holds a path separator or "..".
const SESSION_ID = /^[A-Za-z0-9-]+$/;

// Claude Code 2.1.296's string hash, a 32-bit Java-style hash.
function hash(text) {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = ((h << 5) - h + text.charCodeAt(i)) | 0;
  return h;
}

export function projectDirName(workspace) {
  const name = workspace.replace(/[^a-zA-Z0-9]/g, "-");
  if (name.length <= MAX_NAME) return name;
  return `${name.slice(0, MAX_NAME)}-${Math.abs(hash(workspace)).toString(36)}`;
}

function sessionDir(projects, sessionId) {
  if (!sessionId || !SESSION_ID.test(sessionId) || !existsSync(projects)) return null;
  const dirs = readdirSync(projects, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(projects, entry.name));
  // A bare <id>/ is not enough: Claude Code's Workflow tool creates one under
  // the shell's current project, which may be another project.
  const transcript = (dir) =>
    existsSync(join(dir, `${sessionId}.jsonl`)) || existsSync(join(dir, sessionId, `${sessionId}.jsonl`));
  return dirs.find(transcript) ?? null;
}

export function projectDir(workspace, env = process.env) {
  const config = env.CLAUDE_CONFIG_DIR;
  const projects = join(config || join(env.HOME || homedir(), ".claude"), "projects");
  const session = sessionDir(projects, env.CLAUDE_CODE_SESSION_ID);
  if (session) return session;
  const chosen = config ? env.CLAUDE_CODE_PROJECT_DIR_NAME : undefined;
  const valid = chosen && CHOSEN_NAME.test(chosen) && !RESERVED_NAME.test(chosen);
  const name = valid ? chosen : projectDirName(workspace);
  const derived = join(projects, name);
  if (existsSync(derived)) return derived;
  if (name.length <= MAX_NAME) return null;
  const prefix = `${name.slice(0, MAX_NAME)}-`;
  const matches = existsSync(projects) ? readdirSync(projects).filter((entry) => entry.startsWith(prefix)) : [];
  return matches.length === 1 ? join(projects, matches[0]) : null;
}

// Claude Code names a session by its start directory's real path, and keeps the
// path as given when that directory has since been removed.
function resolvedPath(path) {
  try {
    return realpathSync(path);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return resolve(path);
  }
}

function main(argv) {
  if (argv.length > 1) {
    console.error("usage: claude-project-dir.mjs [workspace]");
    return 2;
  }
  const workspace = argv[0] ? resolvedPath(argv[0]) : process.cwd();
  // A directory argument asks for that workspace's sessions, not this session's.
  const env = argv[0] ? { ...process.env, CLAUDE_CODE_SESSION_ID: undefined, CLAUDE_CODE_PROJECT_DIR_NAME: undefined } : process.env;
  const dir = projectDir(workspace, env);
  if (!dir) {
    console.error(`no Claude Code transcripts directory for ${workspace}`);
    return 1;
  }
  console.log(dir);
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
  process.exitCode = main(process.argv.slice(2));
}
