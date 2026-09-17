import { describe, expect, it } from "bun:test";
import { parsePrNumber } from "./types.ts";
import { GhShippingService, cancelPending, inspectLanding, parseLandingRecord, type LandingRecord, type ShippingService } from "./shipping.ts";

const context = { owner: "owner", repo: "repo", number: parsePrNumber(1) };
const empty: LandingRecord = {
  revision: { context, headRefOid: "head", baseRefName: "main", baseRefOid: "base" },
  pullRequestId: "pr-id", state: "OPEN",
  pending: { autoMerge: false, queueEntryId: null }, mergeCommitOid: null,
};

function fixture(pending: LandingRecord["pending"]) {
  let current: LandingRecord = { ...empty, pending };
  const mutations: string[] = [];
  const service: ShippingService = {
    async inspect() { return current; },
    async disableAutoMerge(id) {
      expect(id).toBe("pr-id");
      mutations.push("disable");
      current = { ...current, pending: { ...current.pending, autoMerge: false } };
    },
    async dequeue(id) {
      expect(id).toBe("pr-id");
      mutations.push("dequeue");
      current = { ...current, pending: { ...current.pending, queueEntryId: null } };
    },
  };
  return { service, mutations, read: () => current, set: (value: LandingRecord) => { current = value; } };
}

describe("pending merge cancellation", () => {
  for (const pending of [
    { autoMerge: false, queueEntryId: null },
    { autoMerge: true, queueEntryId: null },
    { autoMerge: false, queueEntryId: "queue-id" },
    { autoMerge: true, queueEntryId: "queue-id" },
  ]) {
    it(`removes ${JSON.stringify(pending)} and reads back a stable open record`, async () => {
      const f = fixture(pending);
      const expected = f.read();
      expect(await cancelPending(f.service, expected)).toEqual({ kind: "cancelled", record: empty });
      expect(f.read().pending).toEqual({ autoMerge: false, queueEntryId: null });
      expect(f.mutations).toEqual([
        ...(pending.autoMerge ? ["disable"] : []),
        ...(pending.queueEntryId ? ["dequeue"] : []),
      ]);
      expect(await cancelPending(f.service, expected)).toEqual({ kind: "cancelled", record: empty });
    });
  }

  it("does not dequeue when disabling auto-merge also removes queue membership", async () => {
    const f = fixture({ autoMerge: true, queueEntryId: "queue-id" });
    const expected = f.read();
    f.service.disableAutoMerge = async () => { f.set(empty); };
    expect(await cancelPending(f.service, expected)).toEqual({ kind: "cancelled", record: empty });
    expect(f.mutations).toEqual([]);
  });

  for (const change of [
    { revision: { ...empty.revision, headRefOid: "changed" } },
    { revision: { ...empty.revision, baseRefName: "release" } },
    { revision: { ...empty.revision, baseRefOid: "advanced" } },
    { pullRequestId: "different-pr" },
  ]) {
    it(`refuses a stale record before mutation: ${JSON.stringify(change)}`, async () => {
      const f = fixture({ autoMerge: true, queueEntryId: "queue-id" });
      const expected = f.read();
      f.set({ ...expected, ...change });
      expect(await cancelPending(f.service, expected)).toMatchObject({ kind: "changed" });
      expect(f.mutations).toEqual([]);
      expect(f.read().pending).toEqual(expected.pending);
    });
  }

  it("stops if the base moves during cancellation without dequeuing the changed PR", async () => {
    const f = fixture({ autoMerge: true, queueEntryId: "queue-id" });
    const expected = f.read();
    const disable = f.service.disableAutoMerge;
    f.service.disableAutoMerge = async id => {
      await disable(id);
      f.set({ ...f.read(), revision: { ...empty.revision, baseRefOid: "advanced" } });
    };
    expect(await cancelPending(f.service, expected)).toMatchObject({ kind: "changed" });
    expect(f.mutations).toEqual(["disable"]);
    expect(f.read().pending.queueEntryId).toBe("queue-id");
  });

  it("reports a merge during cancellation instead of permission to rewrite", async () => {
    const f = fixture({ autoMerge: false, queueEntryId: "queue-id" });
    const expected = f.read();
    f.service.dequeue = async () => { f.set({ ...empty, state: "MERGED", mergeCommitOid: "merged" }); };
    expect(await cancelPending(f.service, expected)).toMatchObject({ kind: "not-open", record: { state: "MERGED" } });
  });

  it("refuses rearmed pending state on readback", async () => {
    const f = fixture({ autoMerge: false, queueEntryId: "queue-id" });
    const expected = f.read();
    f.service.dequeue = async () => { f.set({ ...empty, pending: { autoMerge: true, queueEntryId: null } }); };
    expect(await cancelPending(f.service, expected)).toMatchObject({ kind: "still-pending" });
  });

  it("reports an unavailable readback and does not continue mutating", async () => {
    const f = fixture({ autoMerge: true, queueEntryId: "queue-id" });
    const expected = f.read();
    let reads = 0;
    f.service.inspect = async () => {
      if (++reads > 1) throw new Error("offline");
      return f.read();
    };
    expect(await cancelPending(f.service, expected)).toEqual({ kind: "unavailable", detail: "offline" });
    expect(f.mutations).toEqual(["disable"]);
  });
});

const raw = {
  id: "pr-id", state: "OPEN", headRefOid: "head", baseRefName: "main", baseRefOid: "base",
  autoMergeRequest: null, mergeQueueEntry: null, mergeCommit: null,
};
const response = (pullRequest: unknown) => ({ data: { repository: { pullRequest } } });

describe("shipping GitHub boundary", () => {
  it("parses the complete record and distinguishes queue-only pending state", async () => {
    const service = new GhShippingService(async () => response({ ...raw, mergeQueueEntry: { id: "queued" } }));
    expect(await service.inspect(context)).toEqual({ ...empty, pending: { autoMerge: false, queueEntryId: "queued" } });
  });

  for (const field of ["baseRefOid", "autoMergeRequest", "mergeQueueEntry", "mergeCommit"]) {
    it(`treats missing ${field} as unavailable, never absent`, async () => {
      const missing = Object.fromEntries(Object.entries(raw).filter(([key]) => key !== field));
      const service = new GhShippingService(async () => response(missing));
      expect(await inspectLanding(service, context)).toMatchObject({ kind: "unavailable" });
    });
  }

  it("rejects partial GraphQL data when errors exist", async () => {
    const service = new GhShippingService(async () => ({ ...response(raw), errors: [{ message: "denied" }] }));
    expect(await inspectLanding(service, context)).toMatchObject({ kind: "unavailable" });
  });

  it("uses separate mutations for both pending mechanisms", async () => {
    let autoMergeRequest: { enabledAt: string } | null = { enabledAt: "now" };
    let mergeQueueEntry: { id: string } | null = { id: "queue" };
    const service = new GhShippingService(async args => {
      const query = args.find(arg => arg.startsWith("query=")) ?? "";
      if (query.includes("disablePullRequestAutoMerge")) {
        expect(args).toContain("id=pr-id");
        autoMergeRequest = null;
        return { data: { disablePullRequestAutoMerge: { clientMutationId: null } } };
      }
      if (query.includes("dequeuePullRequest")) {
        expect(args).toContain("id=pr-id");
        mergeQueueEntry = null;
        return { data: { dequeuePullRequest: { clientMutationId: null } } };
      }
      return response({ ...raw, autoMergeRequest, mergeQueueEntry });
    });
    const expected = await service.inspect(context);
    expect(await cancelPending(service, expected)).toEqual({ kind: "cancelled", record: empty });
  });

  it("rejects malformed saved context before it can select a PR", () => {
    expect(() => parseLandingRecord({ ...empty, revision: { ...empty.revision, context: { ...context, number: -1 } } })).toThrow();
  });
});
