#!/usr/bin/env bun
// Sync this port forward to a new upstream SHA.
//
//   bun tools/sync.mjs <component> <new-sha> [--dry-run]
//
// Reads tools/upstream.json (remote + per-component pin) and
// tools/substitutions.json (mechanical Cursor->Claude rewrites plus a denylist
// of Cursor-isms that need a human sentence, not a token swap). Each upstream
// file is substituted into its port form and compared three ways:
//
//   - local copy matches the derived OLD upstream text -> clean update, written
//   - local copy is missing -> new file, written
//   - upstream deleted it and local matches the derived OLD text -> deleted
//   - local copy differs (port-specific edits) -> left alone, reported for manual merge
//
// Every written file is denylist-scanned; a hit fails the run with file, line,
// and the hint for that token, leaving the tree for inspection. The pin in
// upstream.json is advanced only when the run succeeds. With --dry-run nothing
// is written and the pin stays; passing the pinned SHA as <new-sha> under
// --dry-run prints the ownership map (which files the port has forked).

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { walk } from "./validate-skills.mjs";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");

export function applySubstitutions(text, rules) {
  const counts = new Map();
  let out = text;
  for (const rule of rules) {
    const n = out.split(rule.pattern).length - 1;
    if (n === 0) continue;
    out = out.split(rule.pattern).join(rule.replacement);
    counts.set(rule.pattern, (counts.get(rule.pattern) ?? 0) + n);
  }
  return { text: out, counts };
}

export function denylistHits(path, text, denylist) {
  const hits = [];
  text.split("\n").forEach((line, i) => {
    for (const { token, hint } of denylist) {
      if (line.includes(token)) hits.push(`${path}:${i + 1}: "${token}" — ${hint}`);
    }
  });
  return hits;
}

const BINARY = /\.(png|jpe?g|gif|webp|ico|woff2?|lock)$/;

// Compare old-upstream vs new-upstream vs local for one component tree.
// `derive(rel, text)` turns substituted upstream text into the port's form;
// the default is identity. Returns the report and, unless dryRun, applies it.
export function syncComponent({ oldDir, newDir, localDir, rules, denylist = [], derive = (_, t) => t, dryRun = false }) {
  const report = { written: [], deleted: [], manual: [], unchanged: 0, counts: new Map(), hits: [] };
  const addCounts = (counts) => counts.forEach((n, p) => report.counts.set(p, (report.counts.get(p) ?? 0) + n));
  const portForm = (rel, raw) => {
    if (BINARY.test(rel)) return { buffer: raw, counts: new Map() };
    const sub = applySubstitutions(raw.toString("utf8"), rules);
    return { buffer: Buffer.from(derive(rel, sub.text)), counts: sub.counts };
  };
  const localMatchesOld = (rel, local) => {
    const oldFile = join(oldDir, rel);
    return existsSync(oldFile) && local.equals(portForm(rel, readFileSync(oldFile)).buffer);
  };
  const write = (rel, kind, next) => {
    const localFile = join(localDir, rel);
    if (!dryRun) {
      mkdirSync(dirname(localFile), { recursive: true });
      writeFileSync(localFile, next);
    }
    report.written.push({ kind, rel });
    if (!BINARY.test(rel)) report.hits.push(...denylistHits(rel, next.toString("utf8"), denylist));
  };

  for (const newFile of walk(newDir)) {
    const rel = relative(newDir, newFile);
    const localFile = join(localDir, rel);
    const next = portForm(rel, readFileSync(newFile));
    if (!existsSync(localFile)) {
      write(rel, "added", next.buffer);
      addCounts(next.counts);
      continue;
    }
    const local = readFileSync(localFile);
    if (local.equals(next.buffer)) {
      report.unchanged++;
    } else if (localMatchesOld(rel, local)) {
      write(rel, "updated", next.buffer);
      addCounts(next.counts);
    } else {
      report.manual.push(rel);
    }
  }

  for (const oldFile of walk(oldDir)) {
    const rel = relative(oldDir, oldFile);
    const localFile = join(localDir, rel);
    if (existsSync(join(newDir, rel)) || !existsSync(localFile)) continue;
    if (localMatchesOld(rel, readFileSync(localFile))) {
      if (!dryRun) unlinkSync(localFile);
      report.deleted.push(rel);
    } else {
      report.manual.push(rel);
    }
  }
  return report;
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
}

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const [component, newSha] = args.filter((a) => a !== "--dry-run");
  const upstreamPath = join(repo, "tools/upstream.json");
  const upstream = JSON.parse(readFileSync(upstreamPath, "utf8"));
  const spec = upstream.components[component];
  if (!spec || !newSha?.match(/^[0-9a-f]{7,40}$/)) {
    console.error(`usage: bun tools/sync.mjs <${Object.keys(upstream.components).join("|")}> <new-sha> [--dry-run]`);
    process.exit(2);
  }
  const { substitutions, denylist } = JSON.parse(readFileSync(join(repo, "tools/substitutions.json"), "utf8"));

  const scratch = mkdtempSync(join(tmpdir(), "pstack-sync-"));
  try {
    console.log(`cloning ${upstream.remote} ...`);
    git(["clone", "--filter=blob:none", upstream.remote, join(scratch, "clone")]);
    const co = (sha, dest) => {
      git(["-C", join(scratch, "clone"), "worktree", "add", "--detach", dest, sha]);
      return join(dest, spec.upstreamPath);
    };
    const oldDir = co(spec.sha, join(scratch, "old"));
    const newDir = co(newSha, join(scratch, "new"));

    const report = syncComponent({
      oldDir,
      newDir,
      localDir: join(repo, spec.localPath),
      rules: substitutions,
      denylist,
      dryRun,
    });

    console.log(`\n${dryRun ? "dry run; " : ""}unchanged: ${report.unchanged} files`);
    for (const { kind, rel } of report.written) console.log(`${kind}: ${rel}`);
    for (const rel of report.deleted) console.log(`deleted: ${rel}`);
    for (const [pattern, n] of report.counts) console.log(`substituted: "${pattern}" x${n}`);
    if (report.manual.length) {
      console.log(`\nneeds manual merge (port-specific edits meet upstream changes):`);
      for (const m of report.manual) console.log(`  ${spec.localPath}/${m}`);
    }
    if (report.hits.length) {
      console.error(`\nFAIL: Cursor-isms in synced files; add a substitution or rewrite by hand, then rerun:`);
      for (const h of report.hits) console.error(`  ${spec.localPath}/${h}`);
      process.exit(1);
    }
    if (dryRun) return;

    upstream.components[component].sha = newSha;
    writeFileSync(upstreamPath, JSON.stringify(upstream, null, 2) + "\n");
    console.log(`\npinned: ${component} -> ${newSha}`);
    console.log("next: review the diff, resolve the manual-merge list, write the CHANGES.md entry from this report, run bun tools/generate.mjs");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
