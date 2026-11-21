import { resolveChecks } from "./github.ts";
import type { LandingRevision } from "./landing.ts";
import {
  nonEmpty,
  type CheckRead,
  type GitHubReader,
  type SuiteApp,
} from "./types.ts";

// No check read shows a suite with no runs, such as a fork workflow waiting for
// maintainer approval, so the head's suites are read before its CI counts as
// clean or absent.
export async function resolveHeadChecks(
  reader: GitHubReader,
  facts: Pick<LandingRevision, "context" | "headRefOid">,
  expectedApps: readonly string[] = []
): Promise<CheckRead & { readonly queuedWithoutRuns: readonly SuiteApp[] }> {
  const read = await resolveChecks(reader, facts.context);
  if (
    read.checks.some(
      (check) => check.kind === "failed" || check.kind === "pending"
    )
  )
    return { ...read, queuedWithoutRuns: [] };
  const suites = await reader.unsettledSuites(
    facts.context,
    facts.headRefOid,
    read.kind,
    expectedApps
  );
  const { queuedWithoutRuns } = suites;
  const checks = nonEmpty(suites.checks);
  if (checks === null) return { ...read, queuedWithoutRuns };
  return read.kind === "reported"
    ? { ...read, checks: [...read.checks, ...checks], queuedWithoutRuns }
    : { kind: "reported", source: "check-suites", checks, queuedWithoutRuns };
}
