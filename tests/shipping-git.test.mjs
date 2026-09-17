import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const run = (cwd, ...args) => execFileSync('git', args, {
  cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
}).trim();
function fixture(body) {
  const root = mkdtempSync(join(tmpdir(), 'pstack-shipping-'));
  try {
    run(root, 'init', '-b', 'main');
    run(root, 'config', 'user.email', 'fixture@example.invalid');
    run(root, 'config', 'user.name', 'Fixture');
    const commit = (file, content) => {
      writeFileSync(join(root, file), content);
      run(root, 'add', file);
      run(root, 'commit', '-m', `Update ${file}`);
      return run(root, 'rev-parse', 'HEAD');
    };
    commit('base.txt', 'base\n');
    body(root, commit);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test('after a parent squash, replay only child commits and preserve final content', () => fixture((root, commit) => {
  run(root, 'checkout', '-b', 'parent');
  commit('parent.txt', 'first\n');
  const oldParent = commit('parent.txt', 'parent final\n');
  run(root, 'checkout', '-b', 'child');
  commit('child.txt', 'child only\n');
  run(root, 'checkout', 'main');
  run(root, 'merge', '--squash', 'parent');
  run(root, 'commit', '-m', 'Squash parent');
  const trunk = run(root, 'rev-parse', 'HEAD');
  run(root, 'merge-base', '--is-ancestor', oldParent, 'child');
  run(root, 'rebase', '--onto', trunk, oldParent, 'child');
  assert.equal(run(root, 'rev-list', '--count', `${trunk}..child`), '1');
  assert.equal(run(root, 'diff', '--name-only', `${trunk}..child`), 'child.txt');
  assert.equal(readFileSync(join(root, 'parent.txt'), 'utf8'), 'parent final\n');
  assert.equal(readFileSync(join(root, 'child.txt'), 'utf8'), 'child only\n');
}));

test('explicit pre-rewrite lease refuses concurrent work even after a background fetch', () => fixture((root, commit) => {
  const remote = join(root, 'remote.git');
  run(root, 'init', '--bare', remote);
  run(root, 'remote', 'add', 'origin', remote);
  run(root, 'checkout', '-b', 'child');
  const captured = commit('child.txt', 'original\n');
  run(root, 'push', 'origin', 'child');
  const concurrent = commit('concurrent.txt', 'someone else\n');
  run(root, 'push', 'origin', 'child');
  run(root, 'reset', '--hard', captured);
  commit('child.txt', 'rewritten\n');
  run(root, 'fetch', 'origin');
  const push = spawnSync('git', ['push', `--force-with-lease=refs/heads/child:${captured}`, 'origin', 'HEAD:refs/heads/child'], { cwd: root, encoding: 'utf8' });
  assert.notEqual(push.status, 0);
  assert.match(push.stderr, /stale info/);
  assert.equal(run(root, 'ls-remote', 'origin', 'refs/heads/child').split(/\s/)[0], concurrent);
}));
