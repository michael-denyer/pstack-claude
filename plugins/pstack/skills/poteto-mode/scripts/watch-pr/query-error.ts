import type { QueryFailure } from "./types.ts";

// Port-owned modules import the query error from here rather than from
// github.ts, which imports them; github.ts re-exports it for its callers.
// The line gh prints when a Claude Code cloud session's GitHub proxy refuses GraphQL.
export const GRAPHQL_REFUSAL =
  "GitHub GraphQL is not available from Claude Code sessions";

export class WatcherQueryError extends Error {
  readonly failure: QueryFailure;
  constructor(failure: QueryFailure) {
    super(failure.detail);
    this.name = "WatcherQueryError";
    this.failure = failure;
  }
}

function raw(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function missing(path: string, value?: unknown): never {
  throw new WatcherQueryError({
    kind: "missing-field",
    retryable: true,
    detail:
      value === undefined
        ? `missing ${path}`
        : `invalid ${path}: ${raw(value)}`,
    ...(value === undefined ? {} : { rawValue: raw(value) }),
  });
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
