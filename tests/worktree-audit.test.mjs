import { afterEach, test } from 'bun:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const auditScript = join(
  process.cwd(),
  'plugins/pstack/skills/poteto-mode/scripts/worktree-audit.sh',
);
const fixtures = [];
afterEach(() => {
  for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true });
});

const git = (...args) => execFileSync('/usr/bin/git', args, {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
}).trim();

function createStubs(root) {
  const bin = join(root, 'bin');
  const realGit = `#!/bin/sh
if [ "$1" = -C ] && [ "$3" = status ] && [ -n "$AUDIT_FAIL_STATUS_PATH" ] && [ "$2" = "$AUDIT_FAIL_STATUS_PATH" ]; then
  exit 1
fi
if [ "$1" = fetch ]; then
  exit "\${AUDIT_FAIL_FETCH:-0}"
fi
exec /usr/bin/git "$@"
`;
  const gh = `#!/bin/sh
if [ "$AUDIT_FAIL_GH" = 1 ]; then exit 1; fi
printf '%s\\n' "$AUDIT_GH_RESPONSE"
`;
  const jq = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const branch = args[args.indexOf('--arg') + 2];
const records = JSON.parse(fs.readFileSync(0, 'utf8'));
const match = records.find((record) => record.headRefName === branch);
if (match) console.log([match.number, match.state, match.headRefOid ?? ''].join('\\t'));
`;
  const rg = `#!/bin/sh
if [ "$AUDIT_FAIL_RG" = 2 ]; then exit 2; fi
if [ -n "$AUDIT_RG_MATCH" ]; then
  printf '%s\\n' "$AUDIT_RG_MATCH"
fi
if [ -n "$AUDIT_RG_MATCH" ]; then exit 0; fi
exit 1
`;
  execFileSync('/bin/mkdir', ['-p', bin]);
  writeFileSync(join(bin, 'git'), realGit);
  writeFileSync(join(bin, 'gh'), gh);
  writeFileSync(join(bin, 'jq'), jq);
  writeFileSync(join(bin, 'rg'), rg);
  for (const name of ['git', 'gh', 'jq', 'rg']) {
    chmodSync(join(bin, name), 0o755);
  }
  return bin;
}

function createRepo() {
  const root = mkdtempSync(join(tmpdir(), 'worktree-audit-test-'));
  fixtures.push(root);
  const repo = join(root, 'repo');
  const transcripts = join(root, 'transcripts');
  mkdirSync(transcripts);
  git('init', '--initial-branch=main', repo);
  git('-C', repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '--allow-empty', '-m', 'base');
  git('-C', repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  return { root, repo, transcripts, bin: createStubs(root) };
}

function addWorktree(fixture, name, branch) {
  const path = join(fixture.root, name);
  git('-C', fixture.repo, 'worktree', 'add', '-b', branch, path);
  return path;
}

function commit(worktree, message, filename = `${message.replaceAll(' ', '-')}.txt`) {
  writeFileSync(join(worktree, filename), `${message}\n`);
  git('-C', worktree, 'add', filename);
  git('-C', worktree, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '-m', message);
}

function runAudit(fixture, prs = [], extraEnv = {}) {
  const result = execFileSync('/bin/bash', [auditScript, fixture.repo, fixture.transcripts], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${fixture.bin}:${process.env.PATH}`,
      AUDIT_GH_RESPONSE: JSON.stringify(prs),
      AUDIT_RG_MATCH: '',
      AUDIT_FAIL_STATUS_PATH: '',
      AUDIT_FAIL_FETCH: '0',
      AUDIT_FAIL_GH: '0',
      AUDIT_FAIL_RG: '0',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return result;
}

function rows(output) {
  return output.trim().split('\n').slice(1).map((line) => line.split('\t'));
}

function rowFor(output, worktree) {
  const row = rows(output).find((fields) => fields.at(-1) === worktree);
  assert.ok(row, `missing row for ${worktree}\n${output}`);
  return row;
}

function pr(number, state, headRefName, headRefOid) {
  return { number, state, headRefName, headRefOid };
}

test('preserves spaced worktree paths and rejects closed PRs as safe evidence', () => {
  const fixture = createRepo();
  const candidate = addWorktree(fixture, 'candidate', 'candidate');
  commit(candidate, 'candidate work');
  const spaced = addWorktree(fixture, 'candidate with spaces', 'spaced-candidate');
  const output = runAudit(fixture, [pr(99, 'CLOSED', 'candidate', git('-C', candidate, 'rev-parse', 'HEAD'))]);
  const candidateRow = rowFor(output, candidate);
  const spacedRow = rowFor(output, spaced);
  assert.equal(candidateRow[5], '#99/CLOSED');
  assert.equal(candidateRow[7], 'review');
  assert.equal(spacedRow[8], spaced);
  assert.notEqual(candidateRow[8], spacedRow[8]);
});

test('marks an actual origin/main ancestor safe', () => {
  const fixture = createRepo();
  const ancestor = addWorktree(fixture, 'ancestor', 'ancestor');
  commit(ancestor, 'merged into main');
  git('-C', fixture.repo, 'update-ref', 'refs/remotes/origin/main', `${git('-C', ancestor, 'rev-parse', 'HEAD')}`);
  const output = runAudit(fixture);
  const row = rowFor(output, ancestor);
  assert.equal(row[2], 'YES');
  assert.equal(row[7], 'safe');
});

test('holds tracked dirty work', () => {
  const fixture = createRepo();
  const dirty = addWorktree(fixture, 'dirty', 'dirty');
  writeFileSync(join(dirty, 'tracked.txt'), 'tracked\n');
  git('-C', dirty, 'add', 'tracked.txt');
  git('-C', dirty, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '-m', 'tracked base');
  writeFileSync(join(dirty, 'tracked.txt'), 'tracked change\n');
  const output = runAudit(fixture);
  const row = rowFor(output, dirty);
  assert.match(row[3], /^wip:/);
  assert.equal(row[7], 'hold-wip');
});

test('holds an open PR', () => {
  const fixture = createRepo();
  const open = addWorktree(fixture, 'open', 'open');
  const head = git('-C', open, 'rev-parse', 'HEAD');
  const output = runAudit(fixture, [pr(7, 'OPEN', 'open', head)]);
  const row = rowFor(output, open);
  assert.equal(row[5], '#7/OPEN');
  assert.equal(row[7], 'hold-open-pr');
});

test('accepts a merged PR whose head matches the worktree HEAD', () => {
  const fixture = createRepo();
  const merged = addWorktree(fixture, 'merged', 'merged');
  commit(merged, 'squash merged');
  const mergedHead = git('-C', merged, 'rev-parse', 'HEAD');
  const output = runAudit(fixture, [pr(8, 'MERGED', 'merged', mergedHead)]);
  const row = rowFor(output, merged);
  assert.equal(row[5], '#8/MERGED');
  assert.equal(row[7], 'safe');
});

test('reviews commits added beyond a merged PR head', () => {
  const fixture = createRepo();
  const changed = addWorktree(fixture, 'changed', 'changed');
  commit(changed, 'merged commit');
  const mergedHead = git('-C', changed, 'rev-parse', 'HEAD');
  commit(changed, 'new commit');
  const output = runAudit(fixture, [pr(9, 'MERGED', 'changed', mergedHead)]);
  const row = rowFor(output, changed);
  assert.equal(row[7], 'review');
});

test('reviews a worktree when its status probe fails', () => {
  const fixture = createRepo();
  const failed = addWorktree(fixture, 'failed-status', 'failed-status');
  const head = git('-C', failed, 'rev-parse', 'HEAD');
  const output = runAudit(
    fixture,
    [pr(10, 'MERGED', 'failed-status', head)],
    { AUDIT_FAIL_STATUS_PATH: failed },
  );
  const row = rowFor(output, failed);
  assert.equal(row[3], 'unknown');
  assert.equal(row[7], 'review');
});

for (const probe of ['AUDIT_FAIL_FETCH', 'AUDIT_FAIL_GH']) {
  test(`reviews an ancestor when discovery fails: ${probe}`, () => {
    const fixture = createRepo();
    const candidate = addWorktree(fixture, 'candidate', 'candidate');
    const row = rowFor(runAudit(fixture, [], { [probe]: '1' }), candidate);
    assert.equal(row[2], 'YES');
    assert.equal(row[7], 'review');
  });
}

test('reviews an ancestor when transcript search fails', () => {
  const fixture = createRepo();
  const candidate = addWorktree(fixture, 'candidate', 'candidate');
  const row = rowFor(runAudit(fixture, [], { AUDIT_FAIL_RG: '2' }), candidate);
  assert.equal(row[7], 'review');
});

test('keeps the recent-chat hold with an isolated transcript fixture', () => {
  const fixture = createRepo();
  const candidate = addWorktree(fixture, 'candidate', 'candidate');
  const transcript = join(fixture.transcripts, 'fixture.jsonl');
  writeFileSync(transcript, '{}\n');
  const row = rowFor(runAudit(fixture, [], { AUDIT_RG_MATCH: transcript }), candidate);
  assert.equal(row[7], 'verify-recent-chat');
});
