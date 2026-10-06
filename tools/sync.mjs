#!/usr/bin/env bun
// Sync this port forward to a new upstream SHA.
//
//   bun tools/sync.mjs <component> <new-sha> [--dry-run]
//
// Reads tools/upstream.json (remote, per-component pin, and the `exclude`
// list of upstream paths the port deliberately does not carry) and
// tools/substitutions.json (mechanical Cursor->Claude rewrites plus a denylist
// of Cursor-isms that need a human sentence, not a token swap), and
// tools/forks.json (each path the port forks on purpose). Each upstream
// file is derived into its port form (substitutions, then the port's own
// frontmatter and generator stamps via deriveSkill) and compared three ways:
//
//   - local copy is missing -> new file, written
//   - local copy matches the derived NEW text and mode -> unchanged
//   - local copy matches the derived OLD text and mode -> clean update, written
//   - upstream did not touch its text or mode and local differs -> forked,
//     left alone, counted
//   - all three differ and git merge-file succeeds -> updated when the result
//     matches new upstream's text and mode, else merged; written in either case
//   - all three differ and the merge conflicts -> conflicted: written with
//     git's `<<<<<<< local` / `=======` / `>>>>>>> upstream` markers and
//     reported with its hunk count under conflicts, alongside symlinks on
//     either side of an upstream path or in the port at a directory above one
//     (never followed, never written) and files upstream deleted that the port
//     had edited (kept, and printed as now port-only once the pin moves)
//   - a binary upstream or port copy differs all three ways -> the run fails
//     naming it, since a binary cannot carry markers
//   - a port file where upstream has a directory, a port directory where
//     upstream has a file, or a port entry spelled another way that this
//     filesystem finds for upstream's path, because it folds case or
//     normalises Unicode -> the run fails naming each port path, since the
//     write would land on that entry
//   - upstream deleted it and local matches the derived OLD text and mode ->
//     deleted
//
// Modes compare as git records them, executable or not. A written file takes
// the new upstream file's mode, except that a merged or conflicted file keeps
// the port's when upstream left it alone. A write grants no permission that
// the file's own bits or the umask withhold. A new file is created through the
// umask. An existing file changes only its execute bits, and only when git's
// mode has to change. They are set where the file is readable, or all cleared.
//
// Every effective text file, a conflict's marked bytes included, is
// denylist-scanned; a hit fails the run with file, line, and the hint for that
// token. A forked, merged, or conflicted path with no forks.json entry fails
// the run too, and an entry whose path is no longer forked prints a warning.
// A failed run writes nothing, leaving the tree for inspection.
// The pin in upstream.json is advanced only when the run succeeds, which it
// can with conflicts: the markers are in the tree, and generate.mjs fails on
// any marker line under plugins/pstack, so CI rejects an unresolved sync.
// With --dry-run nothing is written and the pin stays; passing the pinned SHA
// as <new-sha> under --dry-run prints the ownership map. At the pin an upstream
// file the port lacks fails the run, since a sync to a new SHA would write it
// back.

import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { deriveSkill, loadLeadLines, loadModels } from "./generate.mjs";
import { walk } from "./validate-skills.mjs";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");

const RULE_FIELDS = new Set(["pattern", "regex", "files", "replacement", "rationale"]);

// A rule matches a literal `pattern` or a `regex`, optionally only in files
// whose upstream-relative path matches `files`, and rewrites each match to the
// literal `replacement`. Its count is keyed by the pattern, or by the regex and
// its `files` scope.
export function parseRule(rule, i) {
  const fail = (message) => {
    throw new Error(`substitutions[${i}]: ${message}`);
  };
  const unknown = Object.keys(rule).filter((field) => !RULE_FIELDS.has(field));
  if (unknown.length) fail(`unknown field ${unknown.map((f) => `"${f}"`).join(", ")}`);
  const { pattern, regex, files, replacement, rationale } = rule;
  const source = pattern ?? regex;
  if ((pattern == null) === (regex == null) || typeof source !== "string" || !source) {
    fail("needs exactly one of a non-empty pattern or regex");
  }
  if (typeof replacement !== "string") fail("needs a replacement string");
  if (typeof rationale !== "string" || !rationale) fail("needs a rationale");
  if (files != null && typeof files !== "string") fail("files must be a regex source string");
  return {
    key: pattern ?? (files ? `${regex} in ${files}` : regex),
    match: pattern ?? new RegExp(regex, "g"),
    files: files ? new RegExp(files) : null,
    replacement,
  };
}

// Rules apply in order, each to the output of the ones before it, so a rule
// whose pattern contains an earlier rule's pattern could never match. Such a
// pair fails here: put the longer, more specific pattern first.
export function parseSubstitutions({ substitutions, denylist }) {
  const rules = substitutions.map(parseRule);
  substitutions.forEach((later, j) => {
    const earlier = substitutions.slice(0, j).findIndex((r) => r.pattern && later.pattern?.includes(r.pattern));
    if (earlier !== -1) {
      throw new Error(
        `substitutions[${j}] "${later.pattern}" contains substitutions[${earlier}] "${substitutions[earlier].pattern}", ` +
          "which runs first and consumes it; move it above",
      );
    }
  });
  return { substitutions: rules, denylist };
}

const FORK_FIELDS = ["kind", "why", "since", "upstream"];
const FORK_KINDS = new Set(["port-feature", "policy"]);
const UPSTREAM_LINK = /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/(pull|issues)\/\d+$/;

// tools/forks.json maps each component to the repo-relative paths it forks on
// purpose. Returns, per component, a Map from the component-relative path the
// sync compares to that path's entry.
export function parseForks(registry, components) {
  return Object.fromEntries(
    Object.entries(registry).map(([component, entries]) => {
      const spec = components[component];
      if (!spec) throw new Error(`forks.json: unknown component "${component}"`);
      const prefix = `${spec.localPath}/`;
      const forks = new Map();
      for (const [path, entry] of Object.entries(entries)) {
        const fail = (message) => {
          throw new Error(`forks.json ${component} "${path}": ${message}`);
        };
        if (!path.startsWith(prefix)) fail(`not under ${spec.localPath}`);
        if (entry === null || typeof entry !== "object" || Array.isArray(entry)) fail("must be an object");
        const unknown = Object.keys(entry).filter((field) => !FORK_FIELDS.includes(field));
        if (unknown.length) fail(`unknown field ${unknown.map((f) => `"${f}"`).join(", ")}`);
        const missing = FORK_FIELDS.filter((field) => entry[field] == null);
        if (missing.length) fail(`missing field ${missing.map((f) => `"${f}"`).join(", ")}`);
        if (!FORK_KINDS.has(entry.kind)) fail(`unknown kind "${entry.kind}"; use port-feature or policy`);
        if (typeof entry.why !== "string" || !entry.why.trim()) fail("why must be a sentence");
        if (!/^\d+\.\d+\.\d+$/.test(entry.since)) fail(`since "${entry.since}" is not a version`);
        if (entry.upstream !== "not-proposed" && !UPSTREAM_LINK.test(entry.upstream)) {
          fail(`upstream "${entry.upstream}" is neither not-proposed nor a GitHub pull or issue URL`);
        }
        forks.set(path.slice(prefix.length), entry);
      }
      return [component, forks];
    }),
  );
}

// `rules` come from parseSubstitutions.
export function applySubstitutions(text, rules, rel = "") {
  const counts = new Map();
  let out = text;
  for (const rule of rules) {
    if (rule.files && !rule.files.test(rel)) continue;
    let n = 0;
    out = out.replaceAll(rule.match, () => {
      n++;
      return rule.replacement;
    });
    if (n) counts.set(rule.key, (counts.get(rule.key) ?? 0) + n);
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
// git are errors, not conflicts, and rethrow. `--no-diff3` resets the conflict
// style after git has read the user's merge.conflictStyle, so a diff3 or zdiff3
// setting cannot add a `|||||||` base section. `-c merge.conflictStyle=merge`
// does not hold outside a repository, where git 2.54 still applies the global
// setting.
export function mergeFile(ours, base, theirs) {
  const scratch = mkdtempSync(join(tmpdir(), "pstack-merge-"));
  try {
    const paths = { ours, base, theirs };
    for (const [name, buffer] of Object.entries(paths)) writeFileSync(join(scratch, name), buffer);
    const labels = ["-L", "local", "-L", "base", "-L", "upstream"];
    const args = ["merge-file", "-p", "--no-diff3", ...labels, join(scratch, "ours"), join(scratch, "base"), join(scratch, "theirs")];
    try {
      const merged = execFileSync("git", args, { stdio: ["ignore", "pipe", "inherit"] });
      return { clean: true, buffer: merged };
    } catch (error) {
      if (!(error.status >= 1 && error.status <= 127)) throw error;
      if (!error.stdout?.includes("<<<<<<< local")) {
        throw new Error(`git merge-file reported conflicts (exit ${error.status}) but printed no markers`, { cause: error });
      }
      return { clean: false, hunks: error.status, buffer: error.stdout };
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// Call only on differing bytes. `--no-index` exits 1 when the two differ, and
// also on errors, which print no numstat line.
export function changedLines(base, kept) {
  const scratch = mkdtempSync(join(tmpdir(), "pstack-diff-"));
  try {
    writeFileSync(join(scratch, "kept"), kept);
    const args = ["diff", "--no-index", "--numstat", "--text", "-", join(scratch, "kept")];
    const diff = spawnSync("git", args, { input: base, encoding: "utf8" });
    if (diff.status !== 1 || !diff.stdout) throw new Error(`git diff --no-index failed: ${diff.stderr}`);
    const [added, removed] = diff.stdout.split("\t").map(Number);
    return added + removed;
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

const gitMode = (mode) => (mode & 0o100 ? 0o755 : 0o644);

const lazyFile = (mode, load) => {
  let loaded;
  return {
    mode,
    get bytes() { return (loaded ??= load()).bytes; },
    get counts() { return (loaded ??= load()).counts; },
    get binary() { return (loaded ??= load()).binary; },
  };
};

const same = (a, b) => Boolean(a?.bytes && b?.bytes?.equals(a.bytes) && a.mode === b.mode);
// A file new upstream that the port already wrote has no common ancestor.
// An empty base makes every shared line a coincidence, which is what it is.
const NO_COMMON_ANCESTOR = Buffer.alloc(0);

// Decide one path's fate from its old upstream, new upstream, and local
// versions, at least one of old and new present. A version is null when
// absent, `{ symlink: true }` for a link, or a file `{ mode, bytes, binary }`
// whose upstream form adds substitution `counts`. A file reads and derives its
// bytes on first access, so an early return leaves the rest unread.
// Returns null when there is nothing to report, else `{ kind }` plus
// `write: { bytes, mode }` and `counts` for a file to write, `kept` for local
// bytes left in place, `changed` for a fork's changed-line count, and `hunks`
// for a conflict.
export function classify({ old = null, new: next = null, local = null }) {
  if (next?.symlink || local?.symlink) return { kind: "symlink" };
  if (!next) {
    if (!local) return null;
    return same(old, local) ? { kind: "deleted" } : { kind: "removed-upstream", kept: local.bytes };
  }
  const writing = (kind, bytes = next.bytes, mode = next.mode) => ({ kind, write: { bytes, mode }, counts: next.counts });
  if (!local) return writing("added");
  if (same(local, next)) return { kind: "unchanged", kept: local.bytes };
  if (same(local, old)) return writing("updated");
  if (same(old, next)) {
    if (local.bytes.equals(old.bytes)) return { kind: "mode-only", kept: local.bytes };
    return { kind: "forked", kept: local.bytes, changed: changedLines(old.bytes, local.bytes) };
  }
  if (next.binary || local.binary) return { kind: "binary-conflict" };
  const merged = mergeFile(local.bytes, old?.bytes ?? NO_COMMON_ANCESTOR, next.bytes);
  const mode = next.mode === old?.mode ? local.mode : next.mode;
  if (merged.clean) {
    const kind = same({ bytes: merged.buffer, mode }, next) ? "updated" : "merged";
    return writing(kind, merged.buffer, mode);
  }
  return { ...writing("conflicted", merged.buffer, mode), hunks: merged.hunks };
}

// Outcomes that leave port edits on top of upstream's text or mode.
const FORK_OUTCOMES = new Set(["forked", "mode-only", "merged", "conflicted"]);

// What the filesystem finds at `name` in `dir`, a link itself and never its
// target. Where the filesystem folds case or normalises Unicode, that can be
// an entry `dir` lists under another spelling.
const lstatIn = (dir, name) => lstatSync(join(dir, name), { throwIfNoEntry: false });

// Compare old-upstream vs new-upstream vs local for one component tree.
// `derive(rel, text)` turns substituted upstream text into the port's form;
// the default is identity. `forks`, from parseForks, adds the registry check:
// an undeclared fork lands in `undeclared` and blocks every write, and an entry
// whose path is not forked lands in `stale`. A stale entry blocks every write
// only when `atPin`: at a new SHA it is a fork upstream just absorbed, so the
// sync goes ahead. `lookUp` is the one question whose answer depends on how
// the filesystem folds names, so a test can stand in for a filesystem that
// folds. Returns the report and, unless dryRun, applies it.
export function syncComponent({
  oldDir,
  newDir,
  localDir,
  rules,
  denylist = [],
  exclude = [],
  carriedElsewhere = [],
  derive = (_, t) => t,
  forks = null,
  atPin = false,
  dryRun = false,
  lookUp = lstatIn,
}) {
  const report = {
    written: [],
    deleted: [],
    forked: [],
    portOnly: [],
    conflicts: [],
    binaryConflicts: [],
    collisions: [],
    undeclared: [],
    stale: [],
    unchanged: 0,
    excluded: 0,
    counts: new Map(),
    hits: [],
  };
  const portForm = (rel, raw) => {
    if (isBinary(rel, raw)) return { bytes: raw, counts: new Map(), binary: true };
    const sub = applySubstitutions(raw.toString("utf8"), rules, rel);
    return { bytes: Buffer.from(derive(rel, sub.text)), counts: sub.counts };
  };
  const listed = (dir) => new Set(walk(dir).map((file) => relative(dir, file)));
  const [oldPaths, newPaths, localPaths] = [listed(oldDir), listed(newDir), listed(localDir)];
  const upstream = (dir, paths, rel) => {
    if (!paths.has(rel)) return null;
    const file = join(dir, rel);
    const stat = lstatSync(file);
    // Following a link would copy whatever it points at, even outside the
    // clone, into the port.
    if (stat.isSymbolicLink()) return { symlink: true };
    return lazyFile(gitMode(stat.mode), () => portForm(rel, readFileSync(file)));
  };
  const portCopy = (rel) => {
    // The walk decides what exists. Where the filesystem folds case it answers
    // for Foo.md when asked about foo.md, and anywhere it answers for a
    // directory when asked about a file.
    if (!localPaths.has(rel)) return null;
    const file = join(localDir, rel);
    const stat = lstatSync(file);
    // Writing through a link would change, or create, its target.
    if (stat.isSymbolicLink()) return { symlink: true };
    return lazyFile(gitMode(stat.mode), () => {
      const bytes = readFileSync(file);
      return { bytes, binary: isBinary(rel, bytes) };
    });
  };
  const elsewhere = new Set(carriedElsewhere);
  // A port link where upstream has a directory is reported at the link, and
  // nothing under it is read or written, since each write would land in its target.
  const dirsAbove = (rel) => rel.split("/").slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join("/"));
  const upstreamDirs = new Set([...oldPaths, ...newPaths].filter((rel) => !isExcluded(rel, exclude)).flatMap(dirsAbove));
  const isLink = (rel) => localPaths.has(rel) && lstatSync(join(localDir, rel)).isSymbolicLink();
  const outcomeOf = (rel) => {
    if (isExcluded(rel, exclude)) return newPaths.has(rel) ? { kind: "excluded" } : null;
    if (dirsAbove(rel).some(isLink)) return null;
    if (!oldPaths.has(rel) && !newPaths.has(rel)) {
      if (upstreamDirs.has(rel) && isLink(rel)) return { kind: "symlink" };
      return elsewhere.has(rel) ? null : { kind: "port-only" };
    }
    try {
      return classify({ old: upstream(oldDir, oldPaths, rel), new: upstream(newDir, newPaths, rel), local: portCopy(rel) });
    } catch (error) {
      throw new Error(`${rel}: ${error.message}`, { cause: error });
    }
  };
  const outcomes = [...new Set([...newPaths, ...oldPaths, ...localPaths])].flatMap((rel) => {
    const outcome = outcomeOf(rel);
    return outcome ? [{ rel, ...outcome }] : [];
  });

  // A write reaches the tree by upstream's spelling, and the filesystem picks
  // the entry. Where it folds case or normalises Unicode that can be one
  // spelled another way, which the write would overwrite and a delete in the
  // same run could then remove. So each part of a written path must be absent,
  // or listed under exactly that spelling with the type the write needs. How a
  // filesystem folds is its own business, so it is asked and never modelled. A
  // deleted path needs no check, since it comes from the walk and every part
  // of it is a listed name.
  const blockerOf = (rel) => {
    const parts = rel.split("/");
    let dir = localDir;
    for (const [i, part] of parts.entries()) {
      const pathTo = (name) => [...parts.slice(0, i), name].join("/");
      const entries = readdirSync(dir, { withFileTypes: true });
      const entry = entries.find(({ name }) => name === part);
      if (!entry) {
        const found = lookUp(dir, part);
        if (!found) return null;
        const twin = entries.find(({ name }) => lstatSync(join(dir, name)).ino === found.ino);
        return [pathTo(twin?.name ?? part), `the same entry as upstream's ${pathTo(part)} on this filesystem`];
      }
      const last = i === parts.length - 1;
      if (last && entry.isDirectory()) return [pathTo(part), "a directory where upstream has a file"];
      if (!last && !entry.isDirectory()) return [pathTo(part), "a file where upstream has a directory"];
      dir = join(dir, part);
    }
    return null;
  };
  const collisions = new Map();
  for (const { rel, write } of outcomes) {
    const blocker = write && blockerOf(rel);
    if (blocker) collisions.set(...blocker);
  }
  report.collisions = [...collisions].map(([rel, reason]) => ({ rel, reason })).sort((a, b) => a.rel.localeCompare(b.rel));

  for (const { rel, kind, write, kept, counts, changed, hunks } of outcomes) {
    const scanned = write?.bytes ?? kept;
    if (scanned && !isBinary(rel, scanned)) report.hits.push(...denylistHits(rel, scanned.toString("utf8"), denylist));
    if (write) {
      report.written.push({ kind, rel });
      counts.forEach((n, p) => report.counts.set(p, (report.counts.get(p) ?? 0) + n));
    }
    if (kind === "unchanged") report.unchanged++;
    else if (kind === "excluded") report.excluded++;
    else if (kind === "forked") report.forked.push({ rel, changed });
    else if (kind === "mode-only") report.forked.push({ rel, changed: 0, modeOnly: true });
    else if (kind === "conflicted") report.conflicts.push({ rel, reason: "conflict", hunks });
    else if (kind === "symlink" || kind === "removed-upstream") report.conflicts.push({ rel, reason: kind });
    else if (kind === "binary-conflict") report.binaryConflicts.push(rel);
    else if (kind === "deleted") report.deleted.push(rel);
    else if (kind === "port-only") report.portOnly.push(rel);
    else if (!["added", "updated", "merged"].includes(kind)) throw new Error(`${rel}: no report entry for ${kind}`);
  }
  report.forked.sort((a, b) => b.changed - a.changed);
  if (forks) {
    const outcomeOfPath = new Map(outcomes.map(({ rel, kind }) => [rel, kind]));
    report.undeclared = outcomes.filter(({ rel, kind }) => FORK_OUTCOMES.has(kind) && !forks.has(rel)).map(({ rel }) => rel);
    for (const rel of forks.keys()) {
      const kind = outcomeOfPath.get(rel);
      if (FORK_OUTCOMES.has(kind)) continue;
      const reason = localPaths.has(rel) ? `is no longer forked${kind ? ` (${kind})` : ""}` : "no longer exists";
      report.stale.push({ rel, reason });
    }
  }

  if (report.hits.length || report.binaryConflicts.length || report.collisions.length || report.undeclared.length || (atPin && (report.stale.length || report.written.length)) || dryRun) return report;
  for (const { rel, kind, write } of outcomes) {
    const localFile = join(localDir, rel);
    if (write) {
      mkdirSync(dirname(localFile), { recursive: true });
      const held = lstatSync(localFile, { throwIfNoEntry: false });
      writeFileSync(localFile, write.bytes, { mode: write.mode });
      if (held && gitMode(held.mode) !== write.mode) {
        const bits = held.mode & 0o777;
        chmodSync(localFile, write.mode === 0o755 ? bits | ((bits & 0o444) >> 2) : bits & ~0o111);
      }
    } else if (kind === "deleted") {
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
  const [component, newSha, ...stray] = args.filter((a) => a !== "--dry-run");
  const upstreamPath = join(repo, "tools/upstream.json");
  const upstream = JSON.parse(readFileSync(upstreamPath, "utf8"));
  const spec = upstream.components[component];
  if (stray.length || !spec || !newSha?.match(/^[0-9a-f]{7,40}$/)) {
    for (const arg of stray) console.error(`unexpected argument: ${JSON.stringify(arg)}`);
    console.error(`usage: bun tools/sync.mjs <${Object.keys(upstream.components).join("|")}> <new-sha> [--dry-run]`);
    process.exit(2);
  }
  const { substitutions, denylist } = parseSubstitutions(
    JSON.parse(readFileSync(join(repo, "tools/substitutions.json"), "utf8")),
  );
  const forks =
    parseForks(JSON.parse(readFileSync(join(repo, "tools/forks.json"), "utf8")), upstream.components)[component] ??
    new Map();
  const models = loadModels(repo);
  const leads = loadLeadLines(repo);

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
    const atPin = git(["-C", oldDir, "rev-parse", "HEAD"]) === git(["-C", newDir, "rev-parse", "HEAD"]);

    const report = syncComponent({
      oldDir,
      newDir,
      localDir: join(repo, spec.localPath),
      rules: substitutions,
      denylist,
      exclude: spec.exclude ?? [],
      carriedElsewhere: pathsOtherComponentsCarry(join(scratch, "clone"), upstream.components, component),
      derive: (rel, text) => deriveSkill(join(spec.localPath, rel), text, models, leads),
      forks,
      atPin,
      dryRun,
    });

    console.log(`\n${dryRun ? "dry run; " : ""}unchanged: ${report.unchanged} files, excluded: ${report.excluded}`);
    for (const { kind, rel } of report.written) console.log(`${kind}: ${rel}`);
    for (const rel of report.deleted) console.log(`deleted: ${rel}`);
    for (const [pattern, n] of report.counts) console.log(`substituted: "${pattern}" x${n}`);
    if (report.forked.length) {
      const total = report.forked.reduce((sum, fork) => sum + fork.changed, 0);
      const width = Math.max("mode".length, String(total).length);
      const kindOf = (rel) => forks.get(rel)?.kind ?? "undeclared";
      const kindWidth = Math.max(...report.forked.map(({ rel }) => kindOf(rel).length));
      console.log(`\nforked (upstream untouched): ${report.forked.length}`);
      for (const { rel, changed, modeOnly } of report.forked) {
        const count = String(modeOnly ? "mode" : changed).padStart(width);
        console.log(`  ${count} ${kindOf(rel).padEnd(kindWidth)} ${spec.localPath}/${rel}`);
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
    if (report.collisions.length) {
      console.error(`\nFAIL: port paths the tree cannot hold next to upstream's; rename or delete each, then rerun:`);
      for (const { rel, reason } of report.collisions) console.error(`  ${spec.localPath}/${rel} (${reason})`);
    }
    if (report.hits.length) {
      console.error(`\nFAIL: Cursor-isms in synced files; add a substitution or rewrite by hand, then rerun:`);
      for (const h of report.hits) console.error(`  ${spec.localPath}/${h}`);
    }
    if (atPin && report.stale.length) {
      console.error(`\nFAIL: tools/forks.json declares paths under ${component} that are not forked at the pinned SHA; delete each entry, then rerun:`);
      for (const { rel, reason } of report.stale) console.error(`  ${spec.localPath}/${rel} ${reason}`);
    } else {
      for (const { rel, reason } of report.stale) {
        console.error(`warning: tools/forks.json declares ${spec.localPath}/${rel} under ${component}, but it ${reason}; delete the entry`);
      }
    }
    if (atPin && report.written.length) {
      console.error(`\nFAIL: upstream files the port lacks at the pinned SHA; restore each or add it to exclude in tools/upstream.json, then rerun:`);
      for (const { rel } of report.written) console.error(`  ${spec.localPath}/${rel}`);
    }
    if (report.undeclared.length) {
      console.error(`\nFAIL: forks with no entry under ${component} in tools/forks.json; declare each or restore upstream's form, then rerun:`);
      for (const rel of report.undeclared) console.error(`  ${spec.localPath}/${rel}`);
    }
    if (report.binaryConflicts.length || report.collisions.length || report.hits.length || report.undeclared.length || (atPin && (report.stale.length || report.written.length))) {
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
