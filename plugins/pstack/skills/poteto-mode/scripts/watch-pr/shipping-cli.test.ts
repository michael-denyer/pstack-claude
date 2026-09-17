import { expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { object } from "./landing.ts";

function fixture(body: (run: (...args: string[]) => { status: number | null; output: Record<string, unknown> }, file: string, dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "shipping-cli-"));
  const file = join(dir, "state.json");
  writeFileSync(file, JSON.stringify({
    id: "pr-id", state: "OPEN", headRefOid: "head", baseRefName: "main", baseRefOid: "base",
    autoMergeRequest: { enabledAt: "now" }, mergeQueueEntry: { id: "queue" }, mergeCommit: null,
  }));
  const gh = join(dir, "gh");
  writeFileSync(gh, `#!${process.execPath}
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
const state = JSON.parse(readFileSync(process.env.SHIPPING_STATE, 'utf8'));
const args = process.argv.slice(2);
const query = args.find(arg => arg.startsWith('query='));
let result;
if (query.includes('disablePullRequestAutoMerge')) {
  state.autoMergeRequest = null;
  result = { disablePullRequestAutoMerge: { clientMutationId: null } };
} else if (query.includes('dequeuePullRequest')) {
  state.mergeQueueEntry = null;
  result = { dequeuePullRequest: { clientMutationId: null } };
} else result = { repository: { pullRequest: state } };
appendFileSync(process.env.SHIPPING_STATE + '.calls', query + '\\n');
writeFileSync(process.env.SHIPPING_STATE, JSON.stringify(state));
console.log(JSON.stringify({ data: result }));
`);
  chmodSync(gh, 0o755);
  const entry = join(dir, "entry.ts");
  writeFileSync(entry, `import { main } from ${JSON.stringify(join(import.meta.dir, "shipping-cli.ts"))}; process.exitCode = await main(process.argv.slice(2));`);
  const run = (...args: string[]) => {
    const result = spawnSync(process.execPath, [entry, ...args], {
      encoding: "utf8", timeout: 3000,
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, SHIPPING_STATE: file },
    });
    return { status: result.status, output: object(JSON.parse(result.stdout), "CLI result") };
  };
  try { body(run, file, dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

it("the CLI inspects, saves, cancels both mechanisms, and reads back in fresh processes", () => fixture((run, file, dir) => {
  const inspected = run("inspect", "--repo", "owner/repo", "--pr", "1");
  expect(inspected.status).toBe(0);
  expect(object(inspected.output.record, "record").revision).toEqual({ context: { owner: "owner", repo: "repo", number: 1 }, headRefOid: "head", baseRefName: "main", baseRefOid: "base" });
  const saved = join(dir, "record.json");
  writeFileSync(saved, JSON.stringify(inspected.output));
  const cancelled = run("cancel-pending", "--record", saved);
  expect(cancelled.status).toBe(0);
  expect(cancelled.output).toMatchObject({ kind: "cancelled", record: { pending: { autoMerge: false, queueEntryId: null } } });
  expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ autoMergeRequest: null, mergeQueueEntry: null });
}));

it("the CLI refuses a changed base without cancelling anything", () => fixture((run, file, dir) => {
  const inspected = run("inspect", "--repo", "owner/repo", "--pr", "1");
  const saved = join(dir, "record.json");
  writeFileSync(saved, JSON.stringify(inspected.output));
  const changed = { ...JSON.parse(readFileSync(file, "utf8")), baseRefOid: "advanced" };
  writeFileSync(file, JSON.stringify(changed));
  const result = run("cancel-pending", "--record", saved);
  expect(result.status).toBe(1);
  expect(result.output.kind).toBe("changed");
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(changed);
}));

it("the CLI treats a missing queue field as unavailable", () => fixture((run, file) => {
  const raw = JSON.parse(readFileSync(file, "utf8"));
  delete raw.mergeQueueEntry;
  writeFileSync(file, JSON.stringify(raw));
  const result = run("inspect", "--repo", "owner/repo", "--pr", "1");
  expect(result.status).toBe(1);
  expect(result.output.kind).toBe("unavailable");
}));
