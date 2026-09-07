#!/usr/bin/env bun
// Sync this port forward to a new upstream SHA.
//
//   bun tools/sync.mjs <component> <new-sha> [--dry-run]
//
// Reads tools/upstream.json (remote, per-component pin, and the `exclude`
// list of upstream paths the port deliberately does not carry) and
// tools/substitutions.json (mechanical Cursor->Claude rewrites plus a denylist
// of Cursor-isms that need a human sentence, not a token swap). Each upstream
// file is derived into its port form (substitutions, then the port's own
// frontmatter and generator stamps via deriveSkill) and compared three ways:
//
//   - local copy is missing -> new file, written
//   - local copy matches the derived NEW text -> unchanged
//   - local copy matches the derived OLD text -> clean update, written
//   - upstream did not touch it and local differs -> forked, left alone, counted
//   - all three differ and git merge-file succeeds -> merged, written
//   - all three differ and the merge conflicts -> left alone, reported with its
//     hunk count under conflicts, alongside binaries and files upstream deleted
//     that the port had edited
//   - upstream deleted it and local matches the derived OLD text -> deleted
//
// Every effective text file is denylist-scanned; a hit fails the run with file,
// line, and the hint for that token, leaving the tree for inspection. The pin
// in upstream.json is advanced only when the run succeeds. With --dry-run
// nothing is written and the pin stays; passing the pinned SHA as <new-sha>
// under --dry-run prints the ownership map (which files the port has forked).

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { deriveSkill } from "./generate.mjs";
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

// Three-way merge one file's text. `git merge-file -p` prints the result and
// exits with the conflict count, so status 0 is a clean merge and a positive
// status is that many hunks. A negative status or a missing git is an error,
// not a conflict, and rethrows.
export function mergeFile(ours, base, theirs) {
  const scratch = mkdtempSync(join(tmpdir(), "pstack-merge-"));
  try {
    const paths = { ours, base, theirs };
    for (const [name, buffer] of Object.entries(paths)) writeFileSync(join(scratch, name), buffer);
    const args = ["merge-file", "-p", join(scratch, "ours"), join(scratch, "base"), join(scratch, "theirs")];
    try {
      const merged = execFileSync("git", args, { stdio: ["ignore", "pipe", "inherit"] });
      return { clean: true, buffer: merged };
    } catch (error) {
      if (!(error.status > 0)) throw error;
      return { clean: false, hunks: error.status };
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// Paths the port deliberately does not carry (upstream.json `exclude`). An
// entry matches a path relative to the component root exactly or as its
// directory prefix; a trailing slash is optional and changes nothing.
export function isExcluded(rel, exclude) {
  return exclude.some((entry) => {
    const prefix = entry.replace(/\/$/, "");
    return rel === prefix || rel.startsWith(`${prefix}/`);
  });
}

// Compare old-upstream vs new-upstream vs local for one component tree.
// `derive(rel, text)` turns substituted upstream text into the port's form;
// the default is identity. Returns the report and, unless dryRun, applies it.
export function syncComponent({
  oldDir,
  newDir,
  localDir,
  rules,
  denylist = [],
  exclude = [],
  derive = (_, t) => t,
  dryRun = false,
}) {
  const report = {
    written: [],
    deleted: [],
    forked: [],
    conflicts: [],
    unchanged: 0,
    excluded: 0,
    counts: new Map(),
    hits: [],
  };
  const operations = [];
  const addCounts = (counts) => counts.forEach((n, p) => report.counts.set(p, (report.counts.get(p) ?? 0) + n));
  const portForm = (rel, raw) => {
    if (BINARY.test(rel)) return { buffer: raw, counts: new Map() };
    const sub = applySubstitutions(raw.toString("utf8"), rules);
    return { buffer: Buffer.from(derive(rel, sub.text)), counts: sub.counts };
  };
  const derivedOld = (rel) => {
    const oldFile = join(oldDir, rel);
    return existsSync(oldFile) ? portForm(rel, readFileSync(oldFile)).buffer : null;
  };
  const scan = (rel, buffer) => {
    if (!BINARY.test(rel)) report.hits.push(...denylistHits(rel, buffer.toString("utf8"), denylist));
  };
  const planWrite = (rel, kind, next) => {
    operations.push({ kind: "write", rel, buffer: next });
    report.written.push({ kind, rel });
    scan(rel, next);
  };

  const carried = (dir) => walk(dir).map((file) => relative(dir, file)).filter((rel) => !isExcluded(rel, exclude));
  const carriedNew = carried(newDir);
  report.excluded = walk(newDir).length - carriedNew.length;

  for (const rel of carriedNew) {
    const localFile = join(localDir, rel);
    const newFile = join(newDir, rel);
    const next = portForm(rel, readFileSync(newFile));
    if (!existsSync(localFile)) {
      planWrite(rel, "added", next.buffer);
      addCounts(next.counts);
      continue;
    }
    const local = readFileSync(localFile);
    const old = derivedOld(rel);
    if (local.equals(next.buffer)) {
      report.unchanged++;
      scan(rel, next.buffer);
    } else if (old && local.equals(old)) {
      planWrite(rel, "updated", next.buffer);
      addCounts(next.counts);
    } else if (old && old.equals(next.buffer)) {
      report.forked.push(rel);
      scan(rel, local);
    } else if (BINARY.test(rel)) {
      report.conflicts.push({ rel, reason: "binary" });
    } else {
      // A file new upstream that the port already wrote has no common ancestor.
      // An empty base makes every shared line a coincidence, which is what it is.
      const merged = mergeFile(local, old ?? Buffer.alloc(0), next.buffer);
      if (merged.clean) {
        planWrite(rel, "merged", merged.buffer);
        addCounts(next.counts);
      } else {
        report.conflicts.push({ rel, reason: "conflict", hunks: merged.hunks });
        scan(rel, local);
      }
    }
  }

  for (const rel of carried(oldDir)) {
    const localFile = join(localDir, rel);
    if (existsSync(join(newDir, rel)) || !existsSync(localFile)) continue;
    const local = readFileSync(localFile);
    const old = derivedOld(rel);
    if (old && local.equals(old)) {
      operations.push({ kind: "delete", rel });
      report.deleted.push(rel);
    } else {
      report.conflicts.push({ rel, reason: "removed-upstream" });
      scan(rel, local);
    }
  }

  if (report.hits.length || dryRun) return report;
  for (const operation of operations) {
    const localFile = join(localDir, operation.rel);
    if (operation.kind === "write") {
      mkdirSync(dirname(localFile), { recursive: true });
      writeFileSync(localFile, operation.buffer);
    } else {
      unlinkSync(localFile);
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
      exclude: spec.exclude ?? [],
      derive: (rel, text) => deriveSkill(join(spec.localPath, rel), text),
      dryRun,
    });

    console.log(`\n${dryRun ? "dry run; " : ""}unchanged: ${report.unchanged} files, excluded: ${report.excluded}`);
    for (const { kind, rel } of report.written) console.log(`${kind}: ${rel}`);
    for (const rel of report.deleted) console.log(`deleted: ${rel}`);
    for (const [pattern, n] of report.counts) console.log(`substituted: "${pattern}" x${n}`);
    if (report.forked.length) {
      console.log(`\nforked (upstream untouched): ${report.forked.length}`);
      for (const rel of report.forked) console.log(`  ${spec.localPath}/${rel}`);
    }
    if (report.conflicts.length) {
      console.log(`\nneeds a human (port-specific edits the tool could not merge):`);
      for (const c of report.conflicts) {
        const detail = c.reason === "conflict" ? `conflict, ${c.hunks} hunk${c.hunks === 1 ? "" : "s"}` : c.reason;
        console.log(`  ${spec.localPath}/${c.rel} (${detail})`);
      }
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
    console.log("next: review the diff, resolve the conflicts list, write the CHANGES.md entry from this report, run bun tools/generate.mjs");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
