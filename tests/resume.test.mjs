import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../plugins/pstack/skills/poteto-mode/scripts/resume.mjs', import.meta.url));
function fixture(body) {
  // resume.mjs reports resolved paths; macOS tmpdir() sits behind the /var symlink.
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'resume-project-')));
  const git = (...args) => execFileSync('git', ['-C', project, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const run = (...args) => {
    const result = spawnSync('node', [cli, ...args, '--project', project], { encoding: 'utf8' });
    return { status: result.status, value: JSON.parse(result.stdout) };
  };
  try {
    git('init', '-b', 'main');
    git('config', 'user.name', 'Fixture');
    git('config', 'user.email', 'fixture@example.invalid');
    git('commit', '--allow-empty', '-m', 'Initial');
    body({ project, run, git });
  } finally { rmSync(project, { recursive: true, force: true }); }
}
function note(run, text = '1. Who owns retries?\n2. What survives restart?\n') {
  const { value } = run('begin');
  const artifact = join(value.directory, 'questions.md');
  const note = join(value.directory, 'resume.md');
  writeFileSync(artifact, text);
  writeFileSync(note, 'Start with [the questions](questions.md).\n');
  return { note, artifact, text };
}

test('a cold process finds all ordered artifacts using only project identity', () => fixture(({ run }) => {
  const questions = Array.from({ length: 10 }, (_, i) => `${i + 1}. Question ${i + 1}?`).join('\n') + '\n';
  const saved = note(run, questions);
  assert.equal(run('publish', '--note', saved.note, '--artifact', saved.artifact).status, 0);
  const cold = run('read');
  assert.equal(cold.status, 0);
  assert.equal(cold.value.kind, 'checkpoint');
  assert.equal(readFileSync(cold.value.checkpoint.artifacts[0].path, 'utf8'), questions);
  assert.equal(readFileSync(cold.value.checkpoint.note.path, 'utf8'), 'Start with [the questions](questions.md).\n');
}));

test('failed publication leaves the last complete pointer intact', () => fixture(({ run }) => {
  const first = note(run);
  assert.equal(run('publish', '--note', first.note, '--artifact', first.artifact).status, 0);
  const second = note(run);
  rmSync(second.artifact);
  assert.equal(run('publish', '--note', second.note, '--artifact', second.artifact).status, 1);
  assert.equal(run('read').value.checkpoint.note.path, first.note);
}));

test('changed or missing artifacts are errors, not a transcript fallback', () => fixture(({ run }) => {
  const saved = note(run);
  run('publish', '--note', saved.note, '--artifact', saved.artifact);
  writeFileSync(saved.artifact, 'truncated');
  const changed = run('read');
  assert.equal(changed.status, 1);
  assert.match(changed.value.detail, /changed/);
  rmSync(saved.artifact);
  assert.equal(run('read').status, 1);
}));

test('a project with no checkpoint reports missing separately', () => fixture(({ run }) => {
  const cold = run('read');
  assert.equal(cold.status, 2);
  assert.deepEqual(cold.value, { kind: 'missing' });
}));

test('a different worktree locates the same checkpoint without its path', () => fixture(({ project, run, git }) => {
  const saved = note(run);
  run('publish', '--note', saved.note, '--artifact', saved.artifact);
  const worktree = join(project, 'other-worktree');
  git('worktree', 'add', '-b', 'other', worktree);
  const cold = JSON.parse(execFileSync('node', [cli, 'read', '--project', worktree], { encoding: 'utf8' }));
  assert.equal(cold.checkpoint.note.path, saved.note);
  assert.equal(readFileSync(cold.checkpoint.artifacts[0].path, 'utf8'), saved.text);
}));

test('reuses a project artifact without making a competing copy', () => fixture(({ project, run }) => {
  const directory = run('begin').value.directory;
  const artifact = join(project, 'questions.md');
  const resume = join(directory, 'resume.md');
  writeFileSync(artifact, 'Which errors are final?\n');
  writeFileSync(resume, `[Questions](${artifact})\n`);
  assert.equal(run('publish', '--note', resume, '--artifact', artifact).status, 0);
  assert.equal(run('read').value.checkpoint.artifacts[0].path, artifact);
}));

test('rejects symlink artifacts outside the project', () => fixture(({ run }) => {
  const saved = note(run);
  rmSync(saved.artifact);
  symlinkSync('/etc/hosts', saved.artifact);
  const result = run('publish', '--note', saved.note, '--artifact', saved.artifact);
  assert.equal(result.status, 1);
  assert.match(result.value.detail, /must belong to this project/);
}));
