#!/usr/bin/env bun
// Sync this port forward to a new upstream SHA.
//
//   bun tools/sync.mjs <component> <new-sha>     e.g. bun tools/sync.mjs pstack abc1234
//
// Reads tools/upstream.json (remote + per-component pin) and
// tools/substitutions.json (mechanical Cursor->Claude rewrites plus a denylist
// of Cursor-isms that need a human sentence, not a token swap). For each file
// that changed upstream between the pinned SHA and the new one:
//
//   - local copy matches the substituted OLD upstream text -> clean update, written
//   - local copy is missing -> new file, written
//   - local copy differs (port-specific edits) -> left alone, reported for manual merge
//
// Every written file is then denylist-scanned; a hit fails the run with file,
// line, and the hint for that token, leaving the tree for inspection. The pin
// in upstream.json is advanced only when the run succeeds. The printed report
// (files written, per-rule substitution counts, manual-merge list) is the raw
// material for the CHANGES.md entry.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");

export function applySubstitutions(text, rules) {
  const counts = new Map();
  let out = text;
  for (const rule of rules) {
    const before = out;
    out = out.split(rule.pattern).join(rule.replacement);
    if (out !== before) {
      const n = before.split(rule.pattern).length - 1;
      counts.set(rule.pattern, (counts.get(rule.pattern) ?? 0) + n);
    }
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

function listFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (entry === ".git" || entry === "node_modules") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listFiles(full));
    else out.push(full);
  }
  return out;
}

// Compare old-upstream vs new-upstream vs local for one component tree.
// Returns { written, manual, unchanged, counts } and writes clean updates.
export function syncComponent({ oldDir, newDir, localDir, rules, write }) {
  const report = { written: [], manual: [], unchanged: 0, counts: new Map() };
  for (const newFile of listFiles(newDir)) {
    const rel = relative(newDir, newFile);
    const localFile = join(localDir, rel);
    const oldFile = join(oldDir, rel);
    const newRaw = readFileSync(newFile);
    const isText = !rel.match(/\.(png|jpg|gif|lock)$/);
    const subNew = isText ? applySubstitutions(newRaw.toString("utf8"), rules) : null;

    if (!existsSync(localFile)) {
      if (write) {
        mkdirSync(dirname(localFile), { recursive: true });
        writeFileSync(localFile, subNew ? subNew.text : newRaw);
      }
      report.written.push(`added: ${rel}`);
      subNew?.counts.forEach((n, p) => report.counts.set(p, (report.counts.get(p) ?? 0) + n));
      continue;
    }
    const local = readFileSync(localFile);
    const newTarget = subNew ? Buffer.from(subNew.text) : newRaw;
    if (local.equals(newTarget)) {
      report.unchanged++;
      continue;
    }
    // Did the port edit this file beyond the mechanical substitutions? Judge
    // against the substituted OLD upstream text; equality there means every
    // local difference came from upstream drift, so the update is clean.
    let cleanBase = false;
    if (existsSync(oldFile) && isText) {
      const subOld = applySubstitutions(readFileSync(oldFile, "utf8"), rules);
      cleanBase = local.toString("utf8") === subOld.text;
    }
    if (cleanBase) {
      if (write) writeFileSync(localFile, newTarget);
      report.written.push(`updated: ${rel}`);
      subNew?.counts.forEach((n, p) => report.counts.set(p, (report.counts.get(p) ?? 0) + n));
    } else {
      report.manual.push(rel);
    }
  }
  return report;
}

function git(args, opts = {}) {
  return execFileSync("git", args, { encoding: "utf8", ...opts });
}

function main() {
  const [component, newSha] = process.argv.slice(2);
  const upstreamPath = join(repo, "tools/upstream.json");
  const upstream = JSON.parse(readFileSync(upstreamPath, "utf8"));
  const spec = upstream.components[component];
  if (!spec || !newSha?.match(/^[0-9a-f]{7,40}$/)) {
    console.error(`usage: bun tools/sync.mjs <${Object.keys(upstream.components).join("|")}> <new-sha>`);
    process.exit(2);
  }
  const { substitutions, denylist } = JSON.parse(readFileSync(join(repo, "tools/substitutions.json"), "utf8"));

  const scratch = mkdtempSync(join(tmpdir(), "pstack-sync-"));
  try {
    console.log(`cloning ${upstream.remote} ...`);
    git(["clone", "--quiet", upstream.remote, join(scratch, "clone")]);
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
      write: true,
    });

    const hits = report.written.flatMap((entry) => {
      const rel = entry.replace(/^(added|updated): /, "");
      const path = join(spec.localPath, rel);
      return denylistHits(path, readFileSync(join(repo, path), "utf8"), denylist);
    });

    console.log(`\nunchanged: ${report.unchanged} files`);
    for (const w of report.written) console.log(w);
    for (const [pattern, n] of report.counts) console.log(`substituted: "${pattern}" x${n}`);
    if (report.manual.length) {
      console.log(`\nneeds manual merge (port-specific edits meet upstream changes):`);
      for (const m of report.manual) console.log(`  ${spec.localPath}/${m}`);
    }
    if (hits.length) {
      console.error(`\nFAIL: Cursor-isms in synced files; add a substitution or rewrite by hand, then rerun:`);
      for (const h of hits) console.error(`  ${h}`);
      process.exit(1);
    }

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
