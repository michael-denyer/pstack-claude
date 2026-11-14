import { test } from "bun:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";

import { audit } from "../plugins/pstack/skills/poteto-mode/scripts/worktree-audit.mjs";

const git = (cwd, ...args) => execFileSync("git", [
  "-c", "protocol.file.allow=always", "-c", "commit.gpgsign=false",
  "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-C", cwd, ...args,
], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

// Each submodule is cloned into the linked worktree, not borrowed from the seed.
// Removing that worktree therefore removes its own local-only files too.
function withSubmodule(run, { nested = false, initialize = true, submodule = true } = {}) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "pstack-submodule-output-")));
  try {
    const component = join(root, "component");
    const seed = join(root, "seed");
    for (const repo of [component, seed]) {
      git(root, "init", "--initial-branch=main", repo);
      writeFileSync(join(repo, ".gitignore"), ".env\nbuild/\n");
      git(repo, "add", ".gitignore");
      git(repo, "commit", "-m", "base");
    }
    if (nested) {
      const leaf = join(root, "leaf");
      git(root, "clone", component, leaf);
      git(component, "submodule", "add", leaf, "nested");
      git(component, "commit", "-am", "add nested component");
    }
    if (submodule) {
      git(seed, "submodule", "add", component, "component");
      git(seed, "commit", "-am", "add component");
    }
    const remote = join(root, "remote.git");
    const repo = join(root, "repo");
    const worktree = join(root, "worktree").replaceAll(sep, "/");
    const transcripts = join(root, "transcripts");
    git(root, "clone", "--bare", seed, remote);
    git(root, "clone", remote, repo);
    git(repo, "worktree", "add", "-b", "topic", worktree);
    if (submodule && initialize) git(worktree, "submodule", "update", "--init", "--recursive");
    mkdirSync(transcripts);
    const inspect = () => {
      const warnings = [];
      const output = audit({ repo, transcripts: [transcripts], gh: () => "[]", warn: (line) => warnings.push(line) });
      assert.deepEqual(warnings, []);
      const [header, ...rows] = output.trimEnd().split("\n").map((line) => line.split("\t"));
      const row = rows.find((fields) => fields.at(-1) === worktree);
      assert.ok(row);
      return Object.fromEntries(header.map((name, i) => [name, row[i]]));
    };
    run({ repo, worktree, inspect });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function write(path, content = "local-only fixture\n") {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

test("holds a worktree with an ignored .env in its initialized submodule", () => withSubmodule(({ worktree, inspect }) => {
  write(join(worktree, "component", ".env"));
  assert.equal(git(worktree, "status", "--porcelain", "--ignored=matching", "--ignore-submodules=none"), "");
  const row = inspect();
  assert.equal(row.BUCKET, "hold-ignored");
  assert.equal(row.DIRTY, "ignored:1");
}));

test("does not offer submodule-local output to the cleanup playbook's force removal", () => withSubmodule(({ repo, worktree, inspect }) => {
  const output = join(worktree, "component", ".env");
  write(output);
  if (inspect().BUCKET === "safe") git(repo, "worktree", "remove", "--force", worktree);
  assert.equal(existsSync(output), true, "safe caused the documented removal command to delete the only copy");
  assert.equal(readFileSync(output, "utf8"), "local-only fixture\n");
}));

test("includes ignored output in recursive submodules", () => withSubmodule(({ worktree, inspect }) => {
  write(join(worktree, "component", "nested", ".env"));
  assert.equal(inspect().BUCKET, "hold-ignored");
}, { nested: true }));

test("counts ignored output at the top level and inside submodules without creating tracked WIP", () => withSubmodule(({ worktree, inspect }) => {
  write(join(worktree, ".env"));
  write(join(worktree, "component", ".env"));
  const row = inspect();
  assert.equal(row.BUCKET, "hold-ignored");
  assert.equal(row.DIRTY, "ignored:2");
}));

test("does not hold a clean initialized submodule", () => withSubmodule(({ inspect }) => {
  assert.equal(inspect().BUCKET, "safe");
}));

test("keeps the existing disposable build-output policy inside a submodule", () => withSubmodule(({ worktree, inspect }) => {
  write(join(worktree, "component", "build", "generated.js"));
  assert.equal(inspect().BUCKET, "safe");
}));

test("does not require uninitialized submodules to be fetched", () => withSubmodule(({ inspect }) => {
  assert.equal(inspect().BUCKET, "safe");
}, { initialize: false }));

test("keeps the tracked-work hold when ignored submodule output is also present", () => withSubmodule(({ worktree, inspect }) => {
  write(join(worktree, ".gitignore"), ".env\nbuild/\nextra/\n");
  write(join(worktree, "component", ".env"));
  const row = inspect();
  assert.equal(row.BUCKET, "hold-wip");
  assert.equal(row.DIRTY, "wip:1,ignored:1");
}));

test("plain repositories keep their clean and ignored-output behavior", () => withSubmodule(({ worktree, inspect }) => {
  assert.equal(inspect().BUCKET, "safe");
  write(join(worktree, ".env"));
  assert.equal(inspect().BUCKET, "hold-ignored");
}, { submodule: false }));
