import { parsePrNumber, type PrContext } from "./types.ts";

export interface LandingRevision {
  readonly context: PrContext;
  readonly headRefOid: string;
  readonly baseRefName: string;
  readonly baseRefOid: string;
}

export function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

export function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`${label} must be a non-empty string`);
  return value;
}

export function parseContext(value: unknown): PrContext {
  const fields = object(value, "PR context");
  const owner = text(fields.owner, "owner");
  const repo = text(fields.repo, "repo");
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo))
    throw new Error("owner and repo must be individual repository names");
  return { owner, repo, number: parsePrNumber(fields.number) };
}

export function parseLandingRevision(value: unknown, context?: PrContext): LandingRevision {
  const fields = object(value, "landing revision");
  return {
    context: context ?? parseContext(fields.context),
    headRefOid: text(fields.headRefOid, "headRefOid"),
    baseRefName: text(fields.baseRefName, "baseRefName"),
    baseRefOid: text(fields.baseRefOid, "baseRefOid"),
  };
}

export function sameLandingRevision(a: LandingRevision, b: LandingRevision): boolean {
  return a.context.owner.toLowerCase() === b.context.owner.toLowerCase() &&
    a.context.repo.toLowerCase() === b.context.repo.toLowerCase() &&
    a.context.number === b.context.number && a.headRefOid === b.headRefOid &&
    a.baseRefName === b.baseRefName && a.baseRefOid === b.baseRefOid;
}
