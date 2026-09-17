#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';

function git(project, ...args) {
  return execFileSync('git', ['-C', project, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function identity(project) {
  return {
    worktree: realpathSync(git(project, 'rev-parse', '--show-toplevel')),
    gitDir: realpathSync(git(project, 'rev-parse', '--path-format=absolute', '--git-common-dir')),
  };
}
function inside(root, file) {
  const path = relative(root, file);
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`));
}
function string(value, name) {
  if (typeof value !== 'string' || !value) throw new Error(`missing ${name}`);
  return value;
}
function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`invalid ${name}`);
  return value;
}
function fileInfo(path, roots) {
  const canonical = realpathSync(path);
  if (!roots.some(root => inside(root, canonical)) || !statSync(canonical).isFile())
    throw new Error(`checkpoint file must belong to this project: ${path}`);
  return { path: canonical, sha256: createHash('sha256').update(readFileSync(canonical)).digest('hex') };
}
function verifyFile(value, roots) {
  const record = object(value, 'file record');
  const file = fileInfo(string(record.path, 'file path'), roots);
  if (file.sha256 !== string(record.sha256, 'file digest')) throw new Error(`checkpoint file changed: ${file.path}`);
  return file;
}
function verifyLinks(note, artifacts) {
  const content = readFileSync(note.path, 'utf8');
  const paths = [...content.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)]
    .map(match => match[1])
    .filter(target => !/^(?:[a-z]+:|#)/i.test(target))
    .map(target => realpathSync(resolve(dirname(note.path), decodeURIComponent(target.split('#')[0]))));
  for (const artifact of artifacts)
    if (!paths.includes(artifact.path)) throw new Error(`note must link requested artifact: ${artifact.path}`);
  for (const path of paths)
    if (path !== note.path && !artifacts.some(artifact => artifact.path === path))
      throw new Error(`register every local note link with --artifact: ${path}`);
}
function load(store, project) {
  const pointer = join(store, 'latest.json');
  fileInfo(pointer, [store]);
  const record = object(JSON.parse(readFileSync(pointer, 'utf8')), 'checkpoint');
  if (record.schemaVersion !== 1 || record.gitDir !== project.gitDir) throw new Error('checkpoint project mismatch');
  const worktree = string(record.worktree, 'worktree');
  const roots = [store, project.worktree];
  if (worktree !== project.worktree) {
    try {
      if (identity(worktree).gitDir === project.gitDir) roots.push(realpathSync(worktree));
    } catch { /* Removed worktrees cannot supply artifacts; store files remain readable. */ }
  }
  const note = verifyFile(record.note, [store]);
  if (!Array.isArray(record.artifacts)) throw new Error('invalid artifact list');
  const artifacts = record.artifacts.map(value => verifyFile(value, roots));
  const branch = record.branch === null ? null : string(record.branch, 'branch');
  const createdAt = string(record.createdAt, 'timestamp');
  if (!Number.isFinite(Date.parse(createdAt))) throw new Error('invalid checkpoint timestamp');
  verifyLinks(note, artifacts);
  return { schemaVersion: 1, gitDir: project.gitDir, worktree, branch, createdAt, note, artifacts };
}

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      project: { type: 'string', default: '.' },
      note: { type: 'string' },
      artifact: { type: 'string', multiple: true, default: [] },
    },
  });
  const [operation] = positionals;
  if (positionals.length !== 1 || !['begin', 'publish', 'read'].includes(operation))
    throw new Error('usage: resume.mjs begin|publish|read --project <directory> [--note <file> --artifact <file> ...]');
  if (operation !== 'publish' && (values.note || values.artifact.length)) throw new Error('only publish accepts files');
  const project = identity(values.project);
  const store = join(project.gitDir, 'pstack', 'resume');
  if (operation === 'read') {
    try {
      lstatSync(join(store, 'latest.json'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      console.log(JSON.stringify({ kind: 'missing' }));
      process.exit(2);
    }
    console.log(JSON.stringify({ kind: 'checkpoint', checkpoint: load(store, project) }));
  } else {
    mkdirSync(store, { recursive: true, mode: 0o700 });
    if (!inside(project.gitDir, realpathSync(store))) throw new Error('resume store escapes the Git directory');
    if (operation === 'begin') {
      const directory = join(store, randomUUID());
      mkdirSync(directory, { mode: 0o700 });
      console.log(JSON.stringify({ kind: 'directory', directory }));
    } else {
      const note = fileInfo(string(values.note, '--note'), [store]);
      const artifacts = values.artifact.map(path => fileInfo(path, [store, project.worktree]));
      if (new Set(artifacts.map(file => file.path)).size !== artifacts.length) throw new Error('duplicate artifact');
      verifyLinks(note, artifacts);
      const checkpoint = {
        schemaVersion: 1, ...project,
        branch: git(project.worktree, 'branch', '--show-current') || null,
        createdAt: new Date().toISOString(), note, artifacts,
      };
      const temporary = join(store, `.latest-${randomUUID()}.json`);
      try {
        writeFileSync(temporary, JSON.stringify(checkpoint) + '\n', { flag: 'wx', mode: 0o600 });
        renameSync(temporary, join(store, 'latest.json'));
      } finally { rmSync(temporary, { force: true }); }
      console.log(JSON.stringify({ kind: 'checkpoint', checkpoint: load(store, project) }));
    }
  }
} catch (error) {
  console.log(JSON.stringify({ kind: 'unavailable', detail: error.message }));
  process.exitCode = 1;
}
