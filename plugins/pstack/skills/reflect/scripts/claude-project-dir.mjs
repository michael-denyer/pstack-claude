#!/usr/bin/env node
// Print Claude Code's transcripts directory for a workspace.
//
//   node claude-project-dir.mjs [workspace]
//
// The directory is <config>/projects/<name>, where <config> is
// $CLAUDE_CONFIG_DIR or ~/.claude. Claude Code derives <name> from the
// workspace path by turning every character other than an ASCII letter or digit
// into "-". A name longer than 200 characters keeps its first 200 and gains "-"
// and a base-36 hash of the path. $CLAUDE_CODE_PROJECT_DIR_NAME replaces <name>
// when $CLAUDE_CONFIG_DIR is set too. If the derived directory is missing, the
// one directory that shares the first 200 characters is taken instead, so a hash
// that changes in a later Claude Code release still resolves. Exits 1 when no
// directory exists.
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const MAX_NAME = 200;

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

export function projectDir(workspace, env = process.env) {
  const projects = join(env.CLAUDE_CONFIG_DIR || join(env.HOME || homedir(), ".claude"), "projects");
  const name = (env.CLAUDE_CONFIG_DIR && env.CLAUDE_CODE_PROJECT_DIR_NAME) || projectDirName(workspace);
  if (existsSync(join(projects, name))) return join(projects, name);
  if (name.length <= MAX_NAME) return null;
  const prefix = `${name.slice(0, MAX_NAME)}-`;
  const matches = existsSync(projects) ? readdirSync(projects).filter((entry) => entry.startsWith(prefix)) : [];
  return matches.length === 1 ? join(projects, matches[0]) : null;
}

function main(argv) {
  if (argv.length > 1) {
    console.error("usage: claude-project-dir.mjs [workspace]");
    return 2;
  }
  const workspace = argv[0] ? realpathSync(argv[0]) : process.cwd();
  const dir = projectDir(workspace);
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
