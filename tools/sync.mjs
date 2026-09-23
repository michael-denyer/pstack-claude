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
//   - local copy matches the derived NEW text and mode -> unchanged
//   - local copy matches the derived OLD text -> clean update, written
//   - upstream did not touch its text or mode and local differs -> forked,
//     left alone, counted
//   - all three differ and git merge-file succeeds -> merged, written
//   - all three differ and the merge conflicts -> left alone, reported with its
//     hunk count under conflicts, alongside binaries, upstream symlinks (never
//     followed), and files upstream deleted that the port had edited
//   - upstream deleted it and local matches the derived OLD text -> deleted
//
// A written file takes the new upstream file's mode.
//
// Every effective text file is denylist-scanned; a hit fails the run with file,
// line, and the hint for that token, leaving the tree for inspection. The pin
// in upstream.json is advanced only when the run succeeds. With --dry-run
// nothing is written and the pin stays; passing the pinned SHA as <new-sha>
// under --dry-run prints the ownership map (which files the port has forked).

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { deriveSkill } from "./generate.mjs";
import { walk } from "./validate-skills.mjs";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");

// A rule matches a literal `pattern` or a `regex`, optionally only in files
// whose upstream-relative path matches `files`. The replacement is always
// literal, and counts are keyed by the pattern or regex source.
export function applySubstitutions(text, rules, rel = "") {
  const counts = new Map();
  let out = text;
  for (const rule of rules) {
    if (rule.files && !new RegExp(rule.files).test(rel)) continue;
    let n = 0;
    out = out.replaceAll(rule.pattern ?? new RegExp(rule.regex, "g"), () => {
      n++;
      return rule.replacement;
    });
    const key = rule.pattern ?? rule.regex;
    if (n) counts.set(key, (counts.get(key) ?? 0) + n);
  }
  return { text: out, counts };
}

// An entry is a literal `token` or a `regex`; either fails the line it matches.
export function denylistHits(path, text, denylist) {
  const hits = [];
  text.split("\n").forEach((line, i) => {
    for (const { token, regex, hint } of denylist) {
      if (token ? line.includes(token) : new RegExp(regex).test(line)) {
        hits.push(`${path}:${i + 1}: "${token ?? regex}" — ${hint}`);
      }
    }
  });
  return hits;
}

const BINARY = /\.(png|jpe?g|gif|webp|ico|woff2?|lock)$/;

// Binary by extension, by a NUL byte (git's own test), or by bytes that are
// not UTF-8, which a decode and re-encode would replace with U+FFFD.
const isBinary = (rel, raw) => BINARY.test(rel) || raw.includes(0) || !Buffer.from(raw.toString("utf8")).equals(raw);

// Three-way merge one file's text. `git merge-file -p` prints the result and
// exits with the conflict count, capped at 127, so status 0 is a clean merge and
// 1-127 is that many hunks. Git's own errors exit above 127 (-1 for "Cannot
// merge binary files" reads as 255, a usage error as 129); those and a missing
// git are errors, not conflicts, and rethrow.
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
      if (!(error.status >= 1 && error.status <= 127)) throw error;
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
    if (isBinary(rel, raw)) return { buffer: raw, counts: new Map(), binary: true };
    const sub = applySubstitutions(raw.toString("utf8"), rules, rel);
    return { buffer: Buffer.from(derive(rel, sub.text)), counts: sub.counts };
  };
  const derivedOld = (rel) => {
    const oldFile = join(oldDir, rel);
    return lstatSync(oldFile, { throwIfNoEntry: false })?.isFile() ? portForm(rel, readFileSync(oldFile)).buffer : null;
  };
  const modeOf = (file) => statSync(file).mode & 0o777;
  const scan = (rel, buffer) => {
    if (!isBinary(rel, buffer)) report.hits.push(...denylistHits(rel, buffer.toString("utf8"), denylist));
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
    // Following a link would copy whatever it points at, even outside the
    // clone, into the port.
    if (lstatSync(newFile).isSymbolicLink()) {
      report.conflicts.push({ rel, reason: "symlink" });
      continue;
    }
    const next = portForm(rel, readFileSync(newFile));
    if (!existsSync(localFile)) {
      planWrite(rel, "added", next.buffer);
      addCounts(next.counts);
      continue;
    }
    const local = readFileSync(localFile);
    if (local.equals(next.buffer) && modeOf(localFile) === modeOf(newFile)) {
      report.unchanged++;
      scan(rel, next.buffer);
      continue;
    }
    const old = derivedOld(rel);
    if (old && local.equals(old)) {
      planWrite(rel, "updated", next.buffer);
      addCounts(next.counts);
    } else if (old && old.equals(next.buffer) && modeOf(join(oldDir, rel)) === modeOf(newFile)) {
      report.forked.push(rel);
      scan(rel, local);
    } else if (next.binary) {
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
    if (carriedNew.includes(rel) || !existsSync(localFile)) continue;
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
      chmodSync(localFile, modeOf(join(newDir, operation.rel)));
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
      process.exitCode = 1;
      return;
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
