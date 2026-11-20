import type { CheckRead, SuiteCheck } from "./types.ts";

// Suites with runs have already been removed beside reported checks. With a
// null rollup, even a suite with runs can be the only visible evidence of CI.
export function classifySuite(
  state: { readonly conclusion: string } | { readonly status: string },
  app: { readonly name: string; readonly slug: string | null },
  zeroRuns: boolean,
  checksRead: CheckRead["kind"]
): SuiteCheck | null {
  const actions = app.slug === "github-actions";
  const details = {
    source: "check-suites",
    name: `${app.name} check suite`,
    link: "",
    workflow: "",
  } as const;
  if ("status" in state) {
    // Apps such as Claude queue a suite on every push and may never run it.
    if (
      !actions &&
      (checksRead === "reported" ||
        (zeroRuns && app.slug !== null && state.status === "queued"))
    )
      return null;
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
