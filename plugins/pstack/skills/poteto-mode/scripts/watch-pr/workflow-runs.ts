import type { ParsedSuiteRead } from "./check-suites.ts";
import { isRecord, missing } from "./query-error.ts";
import type { SuiteCheck, SuiteRead } from "./types.ts";

interface WorkflowRun {
  readonly id: number;
  readonly workflowId: number;
  readonly checkSuiteId: number;
  readonly event: string;
  readonly headSha: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly createdAt: string;
  readonly name: string;
  readonly link: string;
}

export interface WorkflowRunResolution {
  readonly checks: readonly SuiteCheck[];
  readonly ownedSuiteIds: ReadonlySet<number>;
}

const STARTUP_FAILURE = "startup_failure";
const KNOWN_COMPLETED_CONCLUSIONS = new Set([
  "success",
  "neutral",
  "skipped",
  "action_required",
  "failure",
  STARTUP_FAILURE,
  "timed_out",
  "cancelled",
  "stale",
]);

function positiveInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
    return missing(path, value);
  return value;
}

function string(value: unknown, path: string): string {
  if (typeof value !== "string") missing(path, value);
  return value;
}

function optionalString(value: unknown, path: string): string | null {
  return value === null ? null : string(value, path);
}

function workflowDisplayName(run: Record<string, unknown>): string {
  for (const candidate of [run.name, run.display_title, run.path])
    if (typeof candidate === "string" && candidate.trim() !== "")
      return candidate.trim();
  return missing("workflow run.name", run.name);
}

function parseWorkflowRun(run: Record<string, unknown>): WorkflowRun {
  const createdAt = string(run.created_at, "workflow run.created_at");
  if (!Number.isFinite(Date.parse(createdAt)))
    missing("workflow run.created_at", createdAt);
  const status = string(run.status, "workflow run.status").toLowerCase();
  const conclusion =
    optionalString(run.conclusion, "workflow run.conclusion")?.toLowerCase() ??
    null;
  return {
    id: positiveInteger(run.id, "workflow run.id"),
    workflowId: positiveInteger(run.workflow_id, "workflow run.workflow_id"),
    checkSuiteId: positiveInteger(
      run.check_suite_id,
      "workflow run.check_suite_id"
    ),
    event: string(run.event, "workflow run.event").toLowerCase(),
    headSha: string(run.head_sha, "workflow run.head_sha"),
    status,
    conclusion,
    createdAt,
    name: workflowDisplayName(run),
    link:
      typeof run.html_url === "string"
        ? run.html_url
        : typeof run.url === "string"
          ? run.url
          : "",
  };
}

function compareRuns(left: WorkflowRun, right: WorkflowRun): number {
  const timeDiff = Date.parse(left.createdAt) - Date.parse(right.createdAt);
  return timeDiff !== 0 ? timeDiff : left.id - right.id;
}

function runIdentity(run: WorkflowRun): string {
  return `${run.workflowId}:${run.event}:${run.headSha}`;
}

function canSupersede(candidate: WorkflowRun): boolean {
  return (
    candidate.status !== "completed" ||
    candidate.conclusion === "success" ||
    candidate.conclusion === STARTUP_FAILURE
  );
}

function ownCorrelatedSuites(
  ownedSuiteIds: Set<number>,
  runs: readonly WorkflowRun[],
  target: WorkflowRun
): void {
  const identity = runIdentity(target);
  for (const run of runs)
    if (runIdentity(run) === identity) ownedSuiteIds.add(run.checkSuiteId);
}

// Check suites with a zero-run startup_failure cannot name the workflow or
// event, so Actions workflow runs supply the identity while the already-parsed
// suite evidence proves the zero-run case. Sorting runs chronologically makes
// superseding independent of the API's newest-first order: only a later
// pending run, success, or startup_failure supersedes an earlier run for the
// same workflow, event, and head.
export function resolveWorkflowRunChecks(
  pages: unknown,
  suites: ParsedSuiteRead,
  head: string
): WorkflowRunResolution {
  if (!Array.isArray(pages) || pages.length === 0)
    missing("workflow run pages", pages);
  const startupSuiteIds: number[] = [];
  for (const suite of suites.startupFailureSuites) {
    if (suite.latestCheckRunsCount === null)
      missing("check suite.latest_check_runs_count", suite.rawRunsCount);
    if (suite.id === null) missing("check suite.id", suite.rawId);
    startupSuiteIds.push(suite.id);
  }
  const runs: WorkflowRun[] = [];
  for (const page of pages) {
    if (!isRecord(page)) missing("workflow_runs", page);
    if (!("workflow_runs" in page)) missing("workflow_runs");
    if (!Array.isArray(page.workflow_runs))
      missing("workflow_runs", page.workflow_runs);
    for (const value of page.workflow_runs) {
      if (!isRecord(value)) missing("workflow run", value);
      const run = parseWorkflowRun(value);
      if (run.headSha !== head)
        missing(
          "workflow run.head_sha must match the queried head",
          run.headSha
        );
      if (!suites.actionsSuites.has(run.checkSuiteId)) continue;
      if (run.status === "completed") {
        if (run.conclusion === null)
          missing("workflow run.conclusion of a completed run", run.conclusion);
        if (!KNOWN_COMPLETED_CONCLUSIONS.has(run.conclusion))
          missing("workflow run.conclusion", run.conclusion);
      }
      runs.push(run);
    }
  }
  const matchedSuiteIds = new Set(runs.map((run) => run.checkSuiteId));
  for (const suiteId of startupSuiteIds)
    if (!matchedSuiteIds.has(suiteId))
      missing("workflow runs for failed check suite", suiteId);
  runs.sort(compareRuns);
  const latest = new Map<string, WorkflowRun>();
  for (const run of runs) {
    const identity = runIdentity(run);
    if (!latest.has(identity) || canSupersede(run)) latest.set(identity, run);
  }
  const checks: SuiteCheck[] = [];
  const ownedSuiteIds = new Set<number>();
  for (const run of latest.values()) {
    const details = {
      source: "check-suites" as const,
      name: `${run.name} workflow`,
      description: "",
      link: run.link,
      workflow: run.name,
    };
    if (canSupersede(run)) ownCorrelatedSuites(ownedSuiteIds, runs, run);
    if (run.status !== "completed") {
      checks.push({
        ...details,
        kind: "pending",
        reportedState: run.status.toUpperCase(),
        description: "has not finished",
      });
      continue;
    }
    if (run.conclusion !== STARTUP_FAILURE) continue;
    checks.push({
      ...details,
      kind: "failed",
      reportedState: run.conclusion.toUpperCase(),
      description: `concluded ${run.conclusion}`,
    });
  }
  return { checks, ownedSuiteIds };
}

export function mergeWorkflowRunChecks(
  suites: ParsedSuiteRead,
  workflowResolution: WorkflowRunResolution
): SuiteRead {
  return {
    checks: [
      ...suites.entries
        .filter(
          (entry) =>
            entry.suiteId === null ||
            !workflowResolution.ownedSuiteIds.has(entry.suiteId)
        )
        .map((entry) => entry.check),
      ...workflowResolution.checks,
    ],
    queuedWithoutRuns: suites.queuedWithoutRuns,
  };
}
