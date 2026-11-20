import { resolveChecks } from "./github.ts";
import type { LandingRevision } from "./landing.ts";
import { nonEmpty, type CheckRead, type GitHubReader } from "./types.ts";

// No check read shows a suite with no runs, such as a fork workflow waiting for
// maintainer approval, so the head's suites are read before its CI counts as
// clean or absent.
export async function resolveHeadChecks(
  reader: GitHubReader,
  facts: Pick<LandingRevision, "context" | "headRefOid">
): Promise<CheckRead> {
  const read = await resolveChecks(reader, facts.context);
  if (
    read.checks.some(
      (check) => check.kind === "failed" || check.kind === "pending"
    )
  )
    return read;
  const suites = nonEmpty(
    await reader.unsettledSuites(facts.context, facts.headRefOid, read.kind)
  );
  if (suites === null) return read;
  return read.kind === "reported"
    ? { ...read, checks: [...read.checks, ...suites] }
    : { kind: "reported", source: "check-suites", checks: suites };
}
