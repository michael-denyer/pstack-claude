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
//   - local copy matches the derived OLD text and mode -> clean update, written
//   - upstream did not touch its text or mode and local differs -> forked,
//     left alone, counted
//   - all three differ and git merge-file succeeds -> merged, written
//   - all three differ and the merge conflicts -> conflicted: written with
//     git's `<<<<<<< local` / `=======` / `>>>>>>> upstream` markers and
//     reported with its hunk count under conflicts, alongside upstream symlinks
//     (never followed, never written) and files upstream deleted that the port
//     had edited (kept, and printed as now port-only once the pin moves)
//   - a binary differs all three ways -> the run fails naming it, since a
//     binary cannot carry markers
//   - upstream deleted it and local matches the derived OLD text -> deleted
//
// A written file takes the new upstream file's mode.
//
// Every effective text file, a conflict's marked bytes included, is
// denylist-scanned; a hit fails the run with file, line, and the hint for that
// token. A failed run writes nothing, leaving the tree for inspection.
// The pin in upstream.json is advanced only when the run succeeds, which it
// can with conflicts: the markers are in the tree, and generate.mjs fails on
// any marker line under plugins/pstack, so CI rejects an unresolved sync.
// With --dry-run nothing is written and the pin stays; passing the pinned SHA
// as <new-sha> under --dry-run prints the ownership map.

import { execFileSync, spawnSync } from "node:child_process";
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
    const labels = ["-L", "local", "-L", "base", "-L", "upstream"];
    const args = ["merge-file", "-p", ...labels, join(scratch, "ours"), join(scratch, "base"), join(scratch, "theirs")];
    try {
      const merged = execFileSync("git", args, { stdio: ["ignore", "pipe", "inherit"] });
      return { clean: true, buffer: merged };
    } catch (error) {
      if (!(error.status >= 1 && error.status <= 127)) throw error;
      return { clean: false, hunks: error.status, buffer: error.stdout };
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// Call only on differing bytes. `--no-index` exits 1 when the two differ, and
// also on errors such as an unreadable file, which print no numstat line.
export function changedLines(upstream, localFile) {
  const args = ["diff", "--no-index", "--numstat", "--text", "-", localFile];
  const diff = spawnSync("git", args, { input: upstream, encoding: "utf8" });
  if (diff.status !== 1 || !diff.stdout) throw new Error(`git diff --no-index failed on ${localFile}: ${diff.stderr}`);
  const [added, removed] = diff.stdout.split("\t").map(Number);
  return added + removed;
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
  carriedElsewhere = [],
  derive = (_, t) => t,
  dryRun = false,
}) {
  const report = {
    written: [],
    deleted: [],
    forked: [],
    portOnly: [],
    conflicts: [],
    binaryConflicts: [],
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
    if (old && local.equals(old) && modeOf(localFile) === modeOf(join(oldDir, rel))) {
      planWrite(rel, "updated", next.buffer);
      addCounts(next.counts);
    } else if (old && old.equals(next.buffer) && modeOf(join(oldDir, rel)) === modeOf(newFile)) {
      report.forked.push(
        local.equals(old) ? { rel, changed: 0, modeOnly: true } : { rel, changed: changedLines(old, localFile) },
      );
      scan(rel, local);
    } else if (next.binary) {
      report.binaryConflicts.push(rel);
    } else {
      // A file new upstream that the port already wrote has no common ancestor.
      // An empty base makes every shared line a coincidence, which is what it is.
      const merged = mergeFile(local, old ?? Buffer.alloc(0), next.buffer);
      planWrite(rel, merged.clean ? "merged" : "conflicted", merged.buffer);
      addCounts(next.counts);
      if (!merged.clean) report.conflicts.push({ rel, reason: "conflict", hunks: merged.hunks });
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

  report.forked.sort((a, b) => b.changed - a.changed);
  const upstreamPaths = new Set([...carriedNew, ...carried(oldDir), ...carriedElsewhere]);
  report.portOnly = carried(localDir).filter((rel) => !upstreamPaths.has(rel));

  if (report.hits.length || report.binaryConflicts.length || dryRun) return report;
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

// Relative to `component`'s localPath, and read at each other component's own pin.
function pathsOtherComponentsCarry(clone, components, component) {
  const { localPath } = components[component];
  return Object.entries(components)
    .filter(([name]) => name !== component)
    .flatMap(([, other]) =>
      git(["-C", clone, "ls-tree", "-r", "-z", "--name-only", other.sha, "--", other.upstreamPath])
        .split("\0")
        .filter(Boolean)
        .map((path) => relative(other.upstreamPath, path))
        .filter((rel) => !isExcluded(rel, other.exclude ?? []))
        .map((rel) => relative(localPath, join(other.localPath, rel)))
        .filter((rel) => !rel.startsWith("../")),
    );
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
      carriedElsewhere: pathsOtherComponentsCarry(join(scratch, "clone"), upstream.components, component),
      derive: (rel, text) => deriveSkill(join(spec.localPath, rel), text),
      dryRun,
    });

    console.log(`\n${dryRun ? "dry run; " : ""}unchanged: ${report.unchanged} files, excluded: ${report.excluded}`);
    for (const { kind, rel } of report.written) console.log(`${kind}: ${rel}`);
    for (const rel of report.deleted) console.log(`deleted: ${rel}`);
    for (const [pattern, n] of report.counts) console.log(`substituted: "${pattern}" x${n}`);
    if (report.forked.length) {
      const total = report.forked.reduce((sum, fork) => sum + fork.changed, 0);
      const width = Math.max("mode".length, String(total).length);
      console.log(`\nforked (upstream untouched): ${report.forked.length}`);
      for (const { rel, changed, modeOnly } of report.forked) {
        console.log(`  ${String(modeOnly ? "mode" : changed).padStart(width)} ${spec.localPath}/${rel}`);
      }
      console.log(`  ${String(total).padStart(width)} total changed lines`);
    }
    if (report.portOnly.length) {
      console.log(`\nport-only: ${report.portOnly.length} files`);
      for (const rel of report.portOnly) console.log(`  ${spec.localPath}/${rel}`);
    }
    if (report.conflicts.length) {
      console.log(`\nneeds a human: ${report.conflicts.length} (a conflict is written with git's markers):`);
      for (const c of report.conflicts) {
        const detail = c.reason === "conflict" ? `conflict, ${c.hunks} hunk${c.hunks === 1 ? "" : "s"}` : c.reason;
        console.log(`  ${spec.localPath}/${c.rel} (${detail})`);
      }
    }
    if (report.binaryConflicts.length) {
      console.error(`\nFAIL: binary files changed upstream and in the port cannot carry conflict markers;`);
      console.error(`replace each with upstream's version or add it to exclude in tools/upstream.json, then rerun:`);
      for (const rel of report.binaryConflicts) console.error(`  ${spec.localPath}/${rel}`);
    }
    if (report.hits.length) {
      console.error(`\nFAIL: Cursor-isms in synced files; add a substitution or rewrite by hand, then rerun:`);
      for (const h of report.hits) console.error(`  ${spec.localPath}/${h}`);
    }
    if (report.binaryConflicts.length || report.hits.length) {
      process.exitCode = 1;
      return;
    }
    if (dryRun) return;

    upstream.components[component].sha = newSha;
    writeFileSync(upstreamPath, JSON.stringify(upstream, null, 2) + "\n");
    console.log(`\npinned: ${component} -> ${newSha}`);
    for (const c of report.conflicts) {
      if (c.reason === "removed-upstream") console.log(`  now port-only: ${spec.localPath}/${c.rel}`);
    }
    console.log("next: resolve the conflict markers, review the diff, write the CHANGES.md entry from this report (name each now port-only file), run bun tools/generate.mjs (it fails while a marker remains)");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
