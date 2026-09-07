import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import {
  access,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
  parseFrontier,
  resolveFrontier,
  validateFrontierPin,
} from "./frontier.ts";
import {
  changed,
  countValues,
  previousSummary,
  statusMarkdown,
  summarize,
} from "./status.ts";
import { NotFoundError, UserError } from "./types.ts";
import type {
  Frontier,
  Gate,
  InboxPointer,
  LedgerEntry,
  OpenGate,
  OpenStoreOptions,
  ResolvedGate,
  StandingLine,
  Store,
  Unit,
  Verdict,
} from "./types.ts";

export { NotFoundError, UserError, UsageError } from "./types.ts";
export type {
  Counts,
  Frontier,
  Gate,
  InboxPointer,
  OpenGate,
  OpenStoreOptions,
  StandingLine,
  StatusReport,
  Store,
  Unit,
  Verdict,
} from "./types.ts";

const UNIT_HEADER = "id\ttrack\tstate\tbranch\tpr\tsha\tbrief";
const LEDGER_HEADER = "pr\tsha\tverdict\tevidence\tverifier\tts";
const LOCK_FILE = ".orch.lock";

function errorCode(error: unknown): string | null {
  if (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return null;
}

function verdictOrNull(value: string): Verdict | null {
  switch (value) {
    case "live-ui-verified":
    case "unit-test-verified":
    case "type-check-only":
    case "verifier-blocked":
    case "verifier-failed":
      return value;
    default:
      return null;
  }
}

export function parseVerdict(value: string): Verdict {
  const verdict = verdictOrNull(value);
  if (verdict === null) {
    throw new UserError(
      "verdict must be live-ui-verified, unit-test-verified, type-check-only, verifier-blocked, or verifier-failed",
    );
  }
  return verdict;
}

function cleanCell(value: string): string {
  const cleaned = value.replace(/[\t\n\r]/g, " ");
  return /^[=+\-@]/.test(cleaned) ? `'${cleaned}` : cleaned;
}

function requiredCell(value: string, label: string): string {
  const cleaned = cleanCell(value);
  if (cleaned.trim().length === 0) {
    throw new UserError(`${label} must not be empty`);
  }
  return cleaned;
}

function requiredLine(value: string, label: string): string {
  const cleaned = value.replace(/[\n\r]/g, " ").trim();
  if (cleaned.length === 0) {
    throw new UserError(`${label} must not be empty`);
  }
  return cleaned;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new UserError(`${label} must be a positive integer`);
  }
  return value;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function atomicWrite(path: string, contents: string): Promise<void> {
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporary, contents, { flag: "wx" });
    await rename(temporary, path);
  } finally {
    // Best-effort cleanup: a throw here would replace the write's own error.
    await rm(temporary, { force: true }).catch(() => {});
  }
}

async function writeIfMissing(path: string, contents: string): Promise<void> {
  if (!(await exists(path))) {
    await atomicWrite(path, contents);
  }
}

async function requiredFile(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      throw new UserError(
        `store is not initialized at ${dirname(path)}; run orch init`,
      );
    }
    throw error;
  }
}

function holderIsDead(holder: string): boolean {
  const pid = Number.parseInt(holder, 10);
  if (!Number.isSafeInteger(pid) || pid <= 0 || String(pid) !== holder) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return errorCode(error) === "ESRCH";
  }
}

async function acquireLock(
  store: string,
  options: OpenStoreOptions,
): Promise<() => Promise<void>> {
  const path = join(store, LOCK_FILE);
  const pid = String(process.pid);
  const create = async (): Promise<void> => {
    const handle = await open(path, "wx");
    await handle.writeFile(`${pid}\n`);
    await handle.close();
  };

  const takeOver = async (): Promise<void> => {
    await unlink(path);
    try {
      await create();
    } catch (retryError) {
      if (errorCode(retryError) === "EEXIST") {
        const retryHolder = (await readFile(path, "utf8")).trim() || "unknown";
        throw new UserError(`store lock held by pid ${retryHolder}`);
      }
      throw retryError;
    }
  };

  try {
    await create();
  } catch (error) {
    if (errorCode(error) !== "EEXIST") {
      throw error;
    }
    let holder = "unknown";
    try {
      holder = (await readFile(path, "utf8")).trim() || "unknown";
    } catch {
      holder = "unknown";
    }
    if (holderIsDead(holder)) {
      options.onStaleLock?.(holder);
      await takeOver();
    } else if (options.force) {
      options.onLockStolen?.(holder);
      await takeOver();
    } else {
      throw new UserError(`store lock held by pid ${holder}`);
    }
  }

  return async (): Promise<void> => {
    try {
      if ((await readFile(path, "utf8")).trim() === pid) {
        await unlink(path);
      }
    } catch (error) {
      if (errorCode(error) !== "ENOENT") {
        throw error;
      }
    }
  };
}

async function readTsv(
  path: string,
  header: string,
  width: number,
): Promise<readonly (readonly string[])[]> {
  const lines = (await requiredFile(path)).replace(/\r/g, "").split("\n");
  if (lines.shift() !== header) {
    throw new UserError(`${basename(path)} has an invalid header`);
  }
  return lines
    .filter((value) => value.length > 0)
    .map((value) => {
      const cells = value.split("\t");
      if (cells.length !== width) {
        throw new UserError(`${basename(path)} has a malformed row`);
      }
      return cells;
    });
}

async function writeTsv(
  path: string,
  header: string,
  rows: readonly (readonly string[])[],
): Promise<void> {
  const body = rows.map((row) => row.map(cleanCell).join("\t")).join("\n");
  await atomicWrite(path, `${header}\n${body}${body.length > 0 ? "\n" : ""}`);
}

async function readUnits(store: string): Promise<readonly Unit[]> {
  return (await readTsv(join(store, "units.tsv"), UNIT_HEADER, 7)).map(
    (row) => ({
      id: row[0] ?? "",
      track: row[1] ?? "",
      state: row[2] ?? "",
      branch: row[3] ?? "",
      pr: row[4] ?? "",
      sha: row[5] ?? "",
      brief: row[6] ?? "",
    }),
  );
}

function unitCells(unit: Unit): readonly string[] {
  return [
    unit.id,
    unit.track,
    unit.state,
    unit.branch,
    unit.pr,
    unit.sha,
    unit.brief,
  ];
}

async function saveUnits(store: string, rows: readonly Unit[]): Promise<void> {
  await writeTsv(join(store, "units.tsv"), UNIT_HEADER, rows.map(unitCells));
}

async function readLedger(store: string): Promise<readonly LedgerEntry[]> {
  return (await readTsv(join(store, "ledger.tsv"), LEDGER_HEADER, 6)).map(
    (row) => {
      const rawVerdict = row[2] ?? "";
      const verdict = verdictOrNull(rawVerdict);
      if (verdict === null) {
        throw new UserError(`ledger.tsv has invalid verdict ${rawVerdict}`);
      }
      return {
        pr: row[0] ?? "",
        sha: row[1] ?? "",
        verdict,
        evidence: row[3] ?? "",
        verifier: row[4] ?? "",
        ts: row[5] ?? "",
      };
    },
  );
}

function ledgerCells(row: LedgerEntry): readonly string[] {
  return [row.pr, row.sha, row.verdict, row.evidence, row.verifier, row.ts];
}

async function saveLedger(
  store: string,
  rows: readonly LedgerEntry[],
): Promise<void> {
  await writeTsv(
    join(store, "ledger.tsv"),
    LEDGER_HEADER,
    rows.map(ledgerCells),
  );
}

function pointerCells(pointer: InboxPointer): readonly string[] {
  return [
    pointer.ts,
    pointer.agent,
    pointer.unit,
    pointer.status,
    pointer.report,
  ];
}

async function readPointers(
  directory: string,
): Promise<readonly InboxPointer[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      throw new UserError(
        `store is not initialized at ${dirname(directory)}; run orch init`,
      );
    }
    throw error;
  }
  const result: InboxPointer[] = [];
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".tsv"))
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of files) {
    const raw = (await readFile(join(directory, entry.name), "utf8")).replace(
      /\r?\n$/,
      "",
    );
    const row = raw.split("\t");
    if (/[\r\n]/.test(raw) || row.length !== 5) {
      throw new UserError(`inbox pointer ${entry.name} is malformed`);
    }
    result.push({
      ts: row[0] ?? "",
      agent: row[1] ?? "",
      unit: row[2] ?? "",
      status: row[3] ?? "",
      report: row[4] ?? "",
    });
  }
  return result;
}

function renderGates(rows: readonly Gate[]): string {
  if (rows.length === 0) {
    return "";
  }
  const blocks = rows.map((gate) => {
    const answer = gate.kind === "resolved" ? `\n- Answer: ${gate.answer}` : "";
    return `## ${gate.id}

- Status: ${gate.kind}
- Question: ${gate.question}
- Options: ${gate.options}
- Default: ${gate.defaultAnswer}${answer}`;
  });
  return `# Gates\n\n${blocks.join("\n\n")}\n`;
}

async function readGates(store: string): Promise<readonly Gate[]> {
  const raw = (await requiredFile(join(store, "gates.md")))
    .replace(/\r/g, "")
    .trim();
  if (raw.length === 0) {
    return [];
  }
  const prefix = "# Gates\n\n## ";
  if (!raw.startsWith(prefix)) {
    throw new UserError("gates.md has an invalid heading");
  }
  const result: Gate[] = [];
  for (const block of raw.slice(prefix.length).split("\n\n## ")) {
    const lines = block.split("\n").filter((value) => value.length > 0);
    const id = lines.shift() ?? "";
    const fields = new Map<string, string>();
    for (const value of lines) {
      const match = /^- ([^:]+): (.*)$/.exec(value);
      if (match === null) {
        throw new UserError(`gates.md has a malformed gate ${id}`);
      }
      fields.set(match[1] ?? "", match[2] ?? "");
    }
    const status = fields.get("Status");
    const question = fields.get("Question");
    const options = fields.get("Options");
    const defaultAnswer = fields.get("Default");
    if (
      id.length === 0 ||
      question === undefined ||
      options === undefined ||
      defaultAnswer === undefined
    ) {
      throw new UserError(`gates.md has a malformed gate ${id}`);
    }
    if (status === "open") {
      result.push({ kind: "open", id, question, options, defaultAnswer });
    } else if (status === "resolved" && fields.has("Answer")) {
      result.push({
        kind: "resolved",
        id,
        question,
        options,
        defaultAnswer,
        answer: fields.get("Answer") ?? "",
      });
    } else {
      throw new UserError(`gates.md has invalid status ${status ?? ""}`);
    }
  }
  if (new Set(result.map((gate) => gate.id)).size !== result.length) {
    throw new UserError("gates.md has duplicate gate ids");
  }
  return result;
}

async function readFrontier(store: string): Promise<Frontier> {
  return parseFrontier(await requiredFile(join(store, "frontier.json")));
}

async function readStanding(store: string): Promise<readonly StandingLine[]> {
  const raw = (await requiredFile(join(store, "preferences.md"))).replace(
    /\r/g,
    "",
  );
  if (raw.trim().length === 0) {
    return [];
  }
  const result: StandingLine[] = [];
  for (const value of raw.split("\n").filter((item) => item.length > 0)) {
    const match = /^([1-9]\d*)\. (.+)$/.exec(value);
    const number = Number(match?.[1] ?? 0);
    if (match === null || number !== result.length + 1) {
      throw new UserError("preferences.md has malformed numbering");
    }
    result.push({ number, line: match[2] ?? "" });
  }
  return result;
}

export function openStore(
  directory: string,
  options: OpenStoreOptions = {},
): Store {
  const store = resolve(directory);
  let accepting = true;
  let mutationTail: Promise<void> = Promise.resolve();
  let closePromise: Promise<void> | null = null;
  let releaseLock: (() => Promise<void>) | null = null;

  const ensureOpen = (): void => {
    if (!accepting) {
      throw new UserError("store is closed");
    }
  };

  const scheduleMutation = <T>(operation: () => Promise<T>): Promise<T> => {
    if (!accepting) {
      return Promise.reject(new UserError("store is closed"));
    }
    const result = mutationTail.then(operation);
    mutationTail = result.then(
      () => {},
      () => {},
    );
    return result;
  };

  const ensureLock = async (): Promise<void> => {
    if (releaseLock === null) {
      releaseLock = await acquireLock(store, options);
    }
  };

  const beginWrite = async (): Promise<void> => {
    if (!(await exists(store))) {
      throw new UserError(
        `store is not initialized at ${store}; run orch init`,
      );
    }
    await ensureLock();
  };

  return {
    units: {
      add: (params) =>
        scheduleMutation(async () => {
          await beginWrite();
          const row: Unit = {
            id: requiredCell(params.id, "unit id"),
            track: requiredCell(params.track, "track"),
            state: "pending",
            branch: "",
            pr: "",
            sha: "",
            brief:
              params.brief === undefined
                ? ""
                : requiredCell(params.brief, "brief"),
          };
          const rows = [...(await readUnits(store))];
          if (rows.some((unit) => unit.id === row.id)) {
            throw new UserError(`unit ${row.id} already exists`);
          }
          rows.push(row);
          await saveUnits(store, rows);
          return row;
        }),
      set: (params) =>
        scheduleMutation(async () => {
          await beginWrite();
          const id = requiredCell(params.id, "unit id");
          const state = requiredCell(params.state, "state");
          const rows = [...(await readUnits(store))];
          const index = rows.findIndex((unit) => unit.id === id);
          const old = rows[index];
          if (old === undefined) {
            throw new NotFoundError(`unit ${id} not found`);
          }
          const row: Unit = {
            ...old,
            state,
            branch:
              params.branch === undefined
                ? old.branch
                : requiredCell(params.branch, "branch"),
            pr:
              params.pr === undefined
                ? old.pr
                : String(positiveInteger(params.pr, "PR")),
            sha:
              params.sha === undefined
                ? old.sha
                : requiredCell(params.sha, "SHA"),
          };
          rows[index] = row;
          await saveUnits(store, rows);
          return row;
        }),
      get: async (id) => {
        ensureOpen();
        const cleanId = requiredCell(id, "unit id");
        const row = (await readUnits(store)).find(
          (unit) => unit.id === cleanId,
        );
        if (row === undefined) {
          throw new NotFoundError(`unit ${cleanId} not found`);
        }
        return row;
      },
      list: async (params = {}) => {
        ensureOpen();
        const state =
          params.state === undefined
            ? undefined
            : requiredCell(params.state, "state");
        const track =
          params.track === undefined
            ? undefined
            : requiredCell(params.track, "track");
        return (await readUnits(store)).filter(
          (unit) =>
            (state === undefined || unit.state === state) &&
            (track === undefined || unit.track === track),
        );
      },
      counts: async () => {
        ensureOpen();
        return countValues((await readUnits(store)).map((unit) => unit.state));
      },
    },
    ledger: {
      record: (params) =>
        scheduleMutation(async () => {
          await beginWrite();
          const verdict = parseVerdict(params.verdict);
          const row: LedgerEntry = {
            pr: String(positiveInteger(params.pr, "PR")),
            sha: requiredCell(params.sha, "SHA"),
            verdict,
            evidence: requiredCell(params.evidence, "evidence"),
            verifier:
              params.verifier === undefined
                ? ""
                : requiredCell(params.verifier, "verifier"),
            ts: new Date().toISOString(),
          };
          const rows = [...(await readLedger(store))];
          const index = rows.findIndex(
            (old) => old.pr === row.pr && old.sha === row.sha,
          );
          if (index < 0) {
            rows.push(row);
          } else {
            rows[index] = row;
          }
          await saveLedger(store, rows);
          return row;
        }),
      check: async (params) => {
        ensureOpen();
        const pr = String(positiveInteger(params.pr, "PR"));
        const sha = requiredCell(params.sha, "SHA");
        const row = (await readLedger(store)).find(
          (value) => value.pr === pr && value.sha === sha,
        );
        if (row === undefined) {
          throw new NotFoundError("NOT-VERIFIED", {
            compact: "NOT-VERIFIED",
            json: { pr, sha, verdict: "NOT-VERIFIED" },
          });
        }
        return row;
      },
      summary: async () => {
        ensureOpen();
        return countValues((await readLedger(store)).map((row) => row.verdict));
      },
    },
    inbox: {
      push: (params) =>
        scheduleMutation(async () => {
          await beginWrite();
          const pointer: InboxPointer = {
            ts: new Date().toISOString(),
            agent: requiredCell(params.agent, "agent"),
            unit: requiredCell(params.unit, "unit"),
            status: requiredCell(params.status, "status"),
            report:
              params.report === undefined
                ? ""
                : requiredCell(params.report, "report"),
          };
          const inbox = join(store, "inbox");
          if (!(await exists(inbox))) {
            throw new UserError(
              `store is not initialized at ${store}; run orch init`,
            );
          }
          const timestamp = pointer.ts.replace(/[:.]/g, "-");
          const filename = `${timestamp}-${process.pid}-${randomUUID()}.tsv`;
          const contents = `${pointerCells(pointer).map(cleanCell).join("\t")}\n`;
          await atomicWrite(join(inbox, filename), contents);
          return { pointer, filename };
        }),
      drain: () =>
        scheduleMutation(async () => {
          await beginWrite();
          const inbox = join(store, "inbox");
          const rows = await readPointers(inbox);
          const drained = join(
            store,
            `.inbox-drain-${process.pid}-${randomUUID()}`,
          );
          await rename(inbox, drained);
          try {
            await mkdir(inbox);
          } catch (error) {
            await rename(drained, inbox);
            throw error;
          }
          await rm(drained, { recursive: true, force: true });
          return rows;
        }),
      peek: async () => {
        ensureOpen();
        return readPointers(join(store, "inbox"));
      },
      count: async () => {
        ensureOpen();
        return (await readPointers(join(store, "inbox"))).length;
      },
    },
    gates: {
      park: (params) =>
        scheduleMutation(async () => {
          await beginWrite();
          const gate: OpenGate = {
            kind: "open",
            id: requiredLine(params.id, "gate id"),
            question: requiredLine(params.question, "question"),
            options: requiredLine(params.options, "options"),
            defaultAnswer: requiredLine(params.defaultAnswer, "default"),
          };
          const rows = [...(await readGates(store))];
          const index = rows.findIndex((old) => old.id === gate.id);
          if (index < 0) {
            rows.push(gate);
          } else {
            rows[index] = gate;
          }
          await atomicWrite(join(store, "gates.md"), renderGates(rows));
          return gate;
        }),
      list: async () => {
        ensureOpen();
        return (await readGates(store)).filter(
          (gate): gate is OpenGate => gate.kind === "open",
        );
      },
      resolve: (params) =>
        scheduleMutation(async () => {
          await beginWrite();
          const id = requiredLine(params.id, "gate id");
          const rows = [...(await readGates(store))];
          const index = rows.findIndex((gate) => gate.id === id);
          const old = rows[index];
          if (old === undefined) {
            throw new NotFoundError(`gate ${id} not found`);
          }
          const gate: ResolvedGate = {
            kind: "resolved",
            id: old.id,
            question: old.question,
            options: old.options,
            defaultAnswer: old.defaultAnswer,
            answer: requiredLine(params.answer, "answer"),
          };
          rows[index] = gate;
          await atomicWrite(join(store, "gates.md"), renderGates(rows));
          return gate;
        }),
    },
    frontier: {
      set: (params) =>
        scheduleMutation(async () => {
          await beginWrite();
          const repo = resolve(requiredLine(params.repo, "repo directory"));
          const pin =
            params.prs === undefined
              ? undefined
              : params.prs.map((pr) => positiveInteger(pr, "PR"));
          if (pin !== undefined && new Set(pin).size !== pin.length) {
            throw new UserError("--prs must not contain duplicates");
          }
          const old = await readFrontier(store);
          const prs = resolveFrontier(repo);
          if (pin !== undefined) {
            validateFrontierPin({
              actual: prs.map((row) => row.pr),
              expected: pin,
            });
          }
          const value: Frontier = {
            generation: old.generation + 1,
            prs,
            lowestUnmerged: prs.find((row) => row.state === "OPEN")?.pr ?? null,
          };
          await atomicWrite(
            join(store, "frontier.json"),
            `${JSON.stringify(value, null, 2)}\n`,
          );
          return value;
        }),
      show: async () => {
        ensureOpen();
        return readFrontier(store);
      },
    },
    standing: {
      show: async () => {
        ensureOpen();
        return readStanding(store);
      },
      add: (params) =>
        scheduleMutation(async () => {
          await beginWrite();
          const rows = [...(await readStanding(store))];
          const item: StandingLine = {
            number: rows.length + 1,
            line: requiredLine(params.line, "standing order"),
          };
          rows.push(item);
          await atomicWrite(
            join(store, "preferences.md"),
            `${rows.map((row) => `${row.number}. ${row.line}`).join("\n")}\n`,
          );
          return item;
        }),
    },
    status: {
      render: () =>
        scheduleMutation(async () => {
          await beginWrite();
          const unitRows = await readUnits(store);
          const ledgerRows = await readLedger(store);
          const currentFrontier = await readFrontier(store);
          const gateRows = await readGates(store);
          const currentSummary = summarize(
            unitRows,
            ledgerRows,
            currentFrontier,
            gateRows,
          );
          const path = join(store, "status.md");
          const before = (await exists(path))
            ? previousSummary(await readFile(path, "utf8"))
            : null;
          const change = changed(before, currentSummary);
          await atomicWrite(
            path,
            statusMarkdown(
              unitRows,
              ledgerRows,
              currentFrontier,
              gateRows,
              currentSummary,
            ),
          );
          return {
            units: unitRows,
            ledger: ledgerRows,
            frontier: currentFrontier,
            gates: gateRows,
            summary: currentSummary,
            changed: change,
          };
        }),
    },
    init: () =>
      scheduleMutation(async () => {
        await mkdir(store, { recursive: true });
        await ensureLock();
        await writeIfMissing(join(store, "units.tsv"), `${UNIT_HEADER}\n`);
        await writeIfMissing(join(store, "ledger.tsv"), `${LEDGER_HEADER}\n`);
        await mkdir(join(store, "inbox"), { recursive: true });
        await writeIfMissing(join(store, "gates.md"), "");
        await writeIfMissing(join(store, "preferences.md"), "");
        await writeIfMissing(join(store, "frontier.json"), "{}\n");
        return { store };
      }),
    close: () => {
      if (closePromise !== null) {
        return closePromise;
      }
      accepting = false;
      closePromise = mutationTail.then(async () => {
        const release = releaseLock;
        releaseLock = null;
        if (release !== null) {
          await release();
        }
      });
      return closePromise;
    },
  };
}
