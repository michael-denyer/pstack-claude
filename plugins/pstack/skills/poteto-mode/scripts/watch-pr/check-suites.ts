import { isRecord, missing } from "./query-error.ts";
import { text } from "./landing.ts";
import type { CheckRead, SuiteApp, SuiteCheck, SuiteRead } from "./types.ts";

export interface ActionsSuiteEvidence {
  readonly id: number;
  readonly latestCheckRunsCount: number;
  readonly conclusion: string | null;
}

export interface StartupFailureSuite {
  readonly id: number | null;
  readonly rawId: unknown;
  readonly latestCheckRunsCount: number | null;
  readonly rawRunsCount: unknown;
}

export interface SuiteCheckEntry {
  readonly suiteId: number | null;
  readonly check: SuiteCheck;
}

export interface ParsedSuiteRead {
  readonly entries: readonly SuiteCheckEntry[];
  readonly queuedWithoutRuns: readonly SuiteApp[];
  readonly actionsSuites: ReadonlyMap<number, ActionsSuiteEvidence>;
  readonly startupFailureSuites: readonly StartupFailureSuite[];
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

// Suites with runs have already been removed beside reported checks. With a
// null rollup, even a suite with runs can be the only visible evidence of CI.
// "uncounted" marks an unfinished suite with no runs from an app that may
// never run, which the caller lists rather than waits on.
export function classifySuite(
  state: { readonly conclusion: string } | { readonly status: string },
  app: { readonly name: string; readonly slug: string | null },
  zeroRuns: boolean,
  checksRead: CheckRead["kind"],
  expected: boolean
): SuiteCheck | "uncounted" | null {
  const actions = app.slug === "github-actions";
  const details = {
    source: "check-suites",
    name: `${app.name} check suite`,
    link: "",
    workflow: "",
  } as const;
  if ("status" in state) {
    // Apps such as Claude queue a suite on every push and may never run it;
    // apps such as Azure Pipelines can take hours to start. Only --expect-app
    // tells them apart.
    if (
      !actions &&
      !expected &&
      (checksRead === "reported" ||
        (zeroRuns && app.slug !== null && state.status === "queued"))
    )
      return "uncounted";
    return {
      ...details,
      kind: "pending",
      reportedState: state.status.toUpperCase(),
      description: "has not finished",
    };
  }
  const { conclusion } = state;
  if (["success", "neutral", "skipped"].includes(conclusion)) return null;
  if (checksRead === "reported" && conclusion !== "action_required")
    return null;
  const description =
    conclusion !== "action_required"
      ? `concluded ${conclusion}`
      : actions && zeroRuns
        ? "waits for maintainer approval to run; approve the workflows on the pull request"
        : `requires action; review the check details for ${app.name} on the pull request`;
  return {
    ...details,
    kind: "failed",
    reportedState: conclusion.toUpperCase(),
    description,
  };
}

export function parseSuiteRead(
  pages: unknown,
  head: string,
  checksRead: CheckRead["kind"],
  expectedApps: readonly string[] = []
): ParsedSuiteRead {
  if (!Array.isArray(pages)) missing("check suite pages", pages);
  if (pages.length === 0) missing("check suite pages", pages);
  const entries: SuiteCheckEntry[] = [];
  const queuedWithoutRuns: SuiteApp[] = [];
  const actionsSuites = new Map<number, ActionsSuiteEvidence>();
  const startupFailureSuites: StartupFailureSuite[] = [];
  for (const page of pages) {
    if (!isRecord(page)) missing("check_suites", page);
    if (!("check_suites" in page)) missing("check_suites");
    const suites = page.check_suites;
    if (!Array.isArray(suites)) missing("check_suites", suites);
    for (const value of suites) {
      if (!isRecord(value)) missing("check suite", value);
      if (typeof value.head_sha !== "string")
        missing("check suite.head_sha", value.head_sha);
      if (value.head_sha !== head)
        missing(
          "check suite.head_sha must match the queried head",
          value.head_sha
        );
      const runs = nonNegativeInteger(value.latest_check_runs_count);
      const app = isRecord(value.app) ? value.app : {};
      const suiteApp: SuiteApp = {
        name: typeof app.name === "string" ? app.name : "Unknown app",
        slug: typeof app.slug === "string" ? app.slug.toLowerCase() : null,
      };
      const isActions = suiteApp.slug === "github-actions";
      const suiteId = positiveInteger(value.id);
      if (checksRead === "reported") {
        if (runs === null)
          missing(
            "check suite.latest_check_runs_count",
            value.latest_check_runs_count
          );
        // Reported checks already cover these runs, including superseded ones,
        // but workflow-run correlation still needs their suite IDs.
        if (runs > 0) {
          if (isActions && suiteId !== null)
            actionsSuites.set(suiteId, {
              id: suiteId,
              latestCheckRunsCount: runs,
              conclusion:
                typeof value.conclusion === "string"
                  ? value.conclusion.toLowerCase()
                  : null,
            });
          continue;
        }
      }
      const status = text(value.status, "check suite.status").toLowerCase();
      const conclusion =
        status === "completed"
          ? text(
              value.conclusion,
              "check suite.conclusion of a completed suite"
            ).toLowerCase()
          : null;
      const state = conclusion !== null ? { conclusion } : { status };
      if (isActions) {
        if (suiteId !== null && runs !== null)
          actionsSuites.set(suiteId, {
            id: suiteId,
            latestCheckRunsCount: runs,
            conclusion,
          });
        if (conclusion === "startup_failure" && (runs === 0 || runs === null))
          startupFailureSuites.push({
            id: suiteId,
            rawId: value.id,
            latestCheckRunsCount: runs,
            rawRunsCount: value.latest_check_runs_count,
          });
      }
      const check = classifySuite(
        state,
        suiteApp,
        runs === 0,
        checksRead,
        suiteApp.slug !== null && expectedApps.includes(suiteApp.slug)
      );
      if (check === "uncounted") queuedWithoutRuns.push(suiteApp);
      else if (check !== null) entries.push({ suiteId, check });
    }
  }
  return { entries, queuedWithoutRuns, actionsSuites, startupFailureSuites };
}

export function unsettledSuiteChecks(
  pages: unknown,
  head: string,
  checksRead: CheckRead["kind"],
  expectedApps: readonly string[] = []
): SuiteRead {
  return suiteReadOf(parseSuiteRead(pages, head, checksRead, expectedApps));
}

export function suiteReadOf(parsed: ParsedSuiteRead): SuiteRead {
  return {
    checks: parsed.entries.map((entry) => entry.check),
    queuedWithoutRuns: parsed.queuedWithoutRuns,
  };
}
