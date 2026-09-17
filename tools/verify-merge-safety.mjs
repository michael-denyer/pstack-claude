// Opt-in live verification. Creates and deletes only its own private fixture repo.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

if (process.argv.slice(2).join(' ') !== '--live-disposable') {
  console.error('Usage: node tools/verify-merge-safety.mjs --live-disposable');
  process.exit(2);
}
const gh = (...args) => execFileSync('gh', args, {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
});
const api = (...args) => JSON.parse(gh('api', ...args));
const login = api('user').login;
const name = `pstack-merge-safety-fixture-${randomUUID()}`;
let created = false;
const repository = `${login}/${name}`;
const path = `repos/${repository}`;
function inspect(pr) {
  const result = api('graphql', '-f', 'query=query($owner:String!,$repo:String!,$pr:Int!) { repository(owner:$owner,name:$repo) { pullRequest(number:$pr) { id state headRefOid baseRefName autoMergeRequest { enabledAt } mergeQueueEntry { id } mergeCommit { oid } } } }',
    '-f', `owner=${login}`, '-f', `repo=${name}`, '-F', `pr=${pr}`);
  assert.equal(result.errors, undefined);
  const facts = result.data.repository.pullRequest;
  for (const field of ['state', 'headRefOid', 'baseRefName', 'autoMergeRequest', 'mergeQueueEntry', 'mergeCommit'])
    assert.ok(Object.hasOwn(facts, field), `missing ${field}`);
  return facts;
}
async function waitFor(label, read, matches) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const facts = read();
    if (matches(facts)) return facts;
    await delay(1000);
  }
  throw new Error(`fixture did not reach ${label}`);
}
async function waitForMergeable(pr, head, base) {
  await waitFor('expected REST revision and mergeability',
    () => api(`${path}/pulls/${pr}`),
    facts => facts.head.sha === head && facts.base.ref === base && facts.mergeable === true);
  return waitFor('expected GraphQL revision', () => inspect(pr),
    facts => facts.headRefOid === head && facts.baseRefName === base);
}
try {
  const repo = api('user/repos', '-X', 'POST', '-f', `name=${name}`, '-F', 'private=true', '-F', 'auto_init=true', '-f', 'description=Disposable pstack merge-safety verification fixture');
  created = true;
  assert.equal(repo.full_name, repository);
  assert.equal(repo.private, true);
  console.log(`Created private disposable fixture ${repository}`);
  const base = repo.default_branch;
  const baseSha = api(`${path}/git/ref/heads/${base}`).object.sha;
  api(`${path}/git/refs`, '-X', 'POST', '-f', 'ref=refs/heads/fixture-child', '-f', `sha=${baseSha}`);
  const add = api(`${path}/contents/fixture.txt`, '-X', 'PUT', '-f', 'branch=fixture-child', '-f', 'message=Add fixture', '-f', `content=${Buffer.from('first\n').toString('base64')}`);
  const approvedHead = add.commit.sha;
  const pr = api(`${path}/pulls`, '-X', 'POST', '-f', 'title=Disposable merge safety test', '-f', 'head=fixture-child', '-f', `base=${base}`).number;
  const original = inspect(pr);
  assert.equal(original.headRefOid, approvedHead);
  assert.equal(original.baseRefName, base);
  assert.equal(original.autoMergeRequest, null);
  assert.equal(original.mergeQueueEntry, null);
  console.log('PASS: both pending mechanisms read independently as absent');

  const next = api(`${path}/contents/fixture.txt`, '-X', 'PUT', '-f', 'branch=fixture-child', '-f', 'message=Change after verification', '-f', `sha=${add.content.sha}`, '-f', `content=${Buffer.from('second\n').toString('base64')}`);
  await waitForMergeable(pr, next.commit.sha, base);
  let refused = false;
  try {
    gh('pr', 'merge', String(pr), '--repo', repository, '--squash', '--match-head-commit', approvedHead);
  } catch (error) {
    if (!/head.*(changed|modified|match)|expected.*head|head.*expected/i.test(String(error.stderr))) throw error;
    refused = true;
  }
  assert.equal(refused, true, 'service must reject the old verified head');
  assert.equal(inspect(pr).state, 'OPEN');
  console.log('PASS: stale head rejected by live gh merge; PR remains open');

  // Exercise the service mutation directly as well as gh's possible preflight.
  let atomicRefusal = false;
  try {
    api(`${path}/pulls/${pr}/merge`, '-X', 'PUT', '-f', `sha=${approvedHead}`, '-f', 'merge_method=squash');
  } catch (error) {
    if (!/HTTP 409/.test(String(error.stderr))) throw error;
    atomicRefusal = true;
  }
  assert.equal(atomicRefusal, true, 'merge endpoint must reject mismatched sha');
  assert.equal(inspect(pr).state, 'OPEN');
  console.log('PASS: REST merge endpoint rejects stale sha with HTTP 409');

  api(`${path}/git/refs`, '-X', 'POST', '-f', 'ref=refs/heads/fixture-destination', '-f', `sha=${baseSha}`);
  api(`${path}/pulls/${pr}`, '-X', 'PATCH', '-f', 'base=fixture-destination');
  const retargeted = await waitForMergeable(pr, next.commit.sha, 'fixture-destination');
  assert.equal(retargeted.headRefOid, next.commit.sha);
  assert.equal(retargeted.baseRefName, 'fixture-destination');
  console.log('PASS: destination changes independently of head; requires reassessment');
  api(`${path}/pulls/${pr}`, '-X', 'PATCH', '-f', `base=${base}`);
  await waitForMergeable(pr, next.commit.sha, base);
  gh('pr', 'merge', String(pr), '--repo', repository, '--squash', '--match-head-commit', next.commit.sha);
  const merged = await waitFor('merged state', () => inspect(pr), facts => facts.state === 'MERGED');
  assert.equal(merged.state, 'MERGED');
  assert.equal(merged.headRefOid, next.commit.sha);
  assert.equal(merged.baseRefName, base);
  assert.ok(merged.mergeCommit?.oid);
  assert.equal(api(`${path}/git/ref/heads/${base}`).object.sha, merged.mergeCommit.oid);
  const file = api(`${path}/contents/fixture.txt?ref=${base}`);
  assert.equal(Buffer.from(file.content, 'base64').toString(), 'second\n');
  console.log('PASS: guarded current head merged into intended base with expected content');
  console.log('LIMIT: active auto-merge, merge queue gates, and Origin are not exercised. No protection settings changed.');
} finally {
  if (created) {
    gh('repo', 'delete', repository, '--yes');
    console.log(`Deleted private disposable fixture ${repository}`);
  }
}
