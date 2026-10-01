// What each eval scenario sets up, runs, and requires. Every check comes from
// the skill or playbook the scenario runs, and reads only pi's session files and
// the repo afterwards.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { sleep } from "./harness.mjs";

const MINUTE = 60_000;

const writeFiles = (dir, files) => {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
};

const isEdit = (c, file) => (c.name === "edit" || c.name === "write") && String(c.args.path ?? "").endsWith(file);
const settled = (run) => run.events.at(-1)?.type === "agent_settled";
const firstUserText = (t) => {
  const u = t.parent.find((e) => e.type === "message" && e.message.role === "user");
  return u ? t.textOf(u.message) : "";
};
const readPiTools = (t) => t.calls(t.parent).some((c) => c.name === "read" && String(c.args.path).endsWith("pi-tools.md"));
const notices = (t) => t.parent.flatMap((e, i) => (e.type === "custom_message" && e.customType === "pstack-agent" ? [i] : []));
const sessionModels = (t, r) =>
  [...new Set(t.sessionOf(r).filter((e) => e.type === "message" && e.message.role === "assistant").map((e) => `${e.message.provider}/${e.message.model}`))];

// Runs `fn(dir)` in a throwaway detached checkout of `sha`.
function atCommit(w, sha, fn) {
  const dir = join(w.root, `at-${sha.slice(0, 12)}`);
  w.git("worktree", "add", "-q", "--detach", dir, sha);
  try {
    return fn(dir);
  } finally {
    w.git("worktree", "remove", "--force", dir);
  }
}

const node = (dir, ...args) => spawnSync("node", args, { cwd: dir, encoding: "utf8", timeout: 60_000 });

const PAGINATE = `// Returns the items on a page. Pages are numbered from 1.
export function paginate(items, page, size) {
  if (size <= 0) throw new RangeError("size must be positive");
  return items.slice(page * size, page * size + size);
}
`;

const interrogate = {
  name: "interrogate",
  sheet: "interrogate reviewers: opus, fable, sonnet\n",
  setup(w) {
    w.git("checkout", "-q", "-b", "paginate");
    writeFiles(w.work, { "paginate.js": PAGINATE });
    w.git("add", "paginate.js");
    w.git("commit", "-q", "-m", "Add paginate(items, page, size); pages are numbered from 1");
  },
  drive: (w, { piPrint }) =>
    piPrint(
      w,
      "/skill:interrogate Review the change on this branch against main. Intent: add paginate(items, page, size), " +
        "which returns the items on the given page, with pages numbered from 1.",
    ),
  checks({ w, run, t }) {
    const panel = ["opus", "fable", "sonnet"].map((a) => w.models.get(a));
    const texts = t.texts(t.parent);
    const verdict = texts.findLast((x) => /^#+\s*act on\b/im.test(x.text));
    const seen = notices(t);
    return [
      ["pi exited 0 and settled", run.status === 0 && settled(run)],
      ["the prompt carried the skill and its Pi preamble", firstUserText(t).includes('<skill name="interrogate"') && firstUserText(t).includes("On Pi, read the [platform mapping]")],
      ["the lead read pi-tools.md", readPiTools(t)],
      ["one reviewer ran per panel entry", t.records.length === 3],
      ["every reviewer was readonly", t.records.length > 0 && t.records.every((r) => r.readonly === true)],
      ["the reviewers ran on the panel's three models", JSON.stringify(t.records.map((r) => r.model).sort()) === JSON.stringify([...panel].sort())],
      ["each reviewer's session used its own model", t.records.length > 0 && t.records.every((r) => JSON.stringify(sessionModels(t, r)) === JSON.stringify([r.model]))],
      ["every reviewer completed", t.records.length > 0 && t.records.every((r) => r.status === "completed")],
      ["each reviewer's result reached the lead once", seen.length === 3],
      ["the verdict has an Act On section", Boolean(verdict)],
      ["the verdict came after every reviewer's result", Boolean(verdict) && verdict.i > Math.max(-1, ...seen)],
      ["the verdict names the page offset bug", /(page\s*-\s*1|off[- ]by[- ]one|first page|zero-(based|indexed))/i.test(verdict?.text ?? "")],
    ];
  },
};

const JOBS = {
  "jobs/store.js": `import { existsSync, readFileSync, writeFileSync } from "node:fs";

export function load(db) {
  return existsSync(db) ? JSON.parse(readFileSync(db, "utf8")) : [];
}

export function save(db, job) {
  const jobs = load(db).filter((j) => j.id !== job.id);
  writeFileSync(db, JSON.stringify([...jobs, job], null, 2));
}
`,
  "jobs/queue.js": `import { load, save } from "./store.js";

export function enqueue(db, job) {
  save(db, { ...job, attempts: 0, status: "pending", runAt: Date.now() });
}

export function due(db, now) {
  return load(db).filter((j) => j.status === "pending" && j.runAt <= now);
}
`,
  "jobs/retry.js": `import { save } from "./store.js";

export const MAX_ATTEMPTS = 5;

export function nextDelay(attempts) {
  return 1000 * 2 ** attempts;
}

export function scheduleRetry(db, job, err, now) {
  const attempts = job.attempts + 1;
  const status = attempts >= MAX_ATTEMPTS ? "dead" : "pending";
  save(db, { ...job, attempts, status, lastError: String(err), runAt: now + nextDelay(attempts) });
}
`,
  "jobs/worker.js": `import { due } from "./queue.js";
import { scheduleRetry } from "./retry.js";
import { save } from "./store.js";

export async function tick(db, handlers, now = Date.now()) {
  for (const job of due(db, now)) {
    try {
      await handlers[job.type](job.payload);
      save(db, { ...job, status: "done" });
    } catch (err) {
      scheduleRetry(db, job, err, now);
    }
  }
}
`,
};

const how = {
  name: "how",
  setup(w) {
    writeFiles(w.work, JOBS);
    w.git("add", ".");
    w.git("commit", "-q", "-m", "Add a file-backed job queue with retries");
  },
  drive: (w, { piPrint }) =>
    piPrint(w, "/skill:how How does a failed job get retried, and where is its attempt count persisted?", { timeoutMs: 15 * MINUTE }),
  checks({ w, run, t }) {
    const rs = t.records;
    const last = [...rs].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt)).at(-1);
    const shape =
      rs.length === 1 ||
      (rs.length >= 3 && rs.length <= 5 && rs.every((r) => r === last || Date.parse(r.endedAt) <= Date.parse(last.startedAt)));
    const answer = t.finalText;
    return [
      ["pi exited 0 and settled", run.status === 0 && settled(run)],
      ["the lead read pi-tools.md", readPiTools(t)],
      ["every agent was a readonly general-purpose agent", rs.length > 0 && rs.every((r) => r.readonly === true && r.subagentType === "general-purpose")],
      ["every agent ran on the how roles' model", rs.length > 0 && rs.every((r) => r.model === w.models.get("opus"))],
      ["one explainer, or 2 to 4 explorers and then one explainer", shape],
      ["nothing was edited", !t.allCalls().some((c) => c.name === "edit" || c.name === "write") && w.git("status", "--porcelain") === ""],
      ["the answer names retry.js, store.js, and the attempts field", ["retry.js", "store.js", "attempts"].every((s) => answer.includes(s))],
    ];
  },
};

const DURATION = {
  "package.json": `{ "type": "module", "scripts": { "test": "node --test" } }\n`,
  "duration.js": `// Parses a duration such as "1h30m", "45m", or "2h" into seconds.
export function parseDuration(text) {
  const m = /^(?:(\\d+)h)?(?:(\\d+)m)?$/.exec(text);
  if (!m || text === "") throw new SyntaxError(\`bad duration: \${text}\`);
  const hours = Number(m[1] ?? 0);
  const minutes = Number(m[2] ?? 0);
  return hours * 60 + minutes * 60;
}
`,
  "duration.test.js": `import assert from "node:assert/strict";
import { test } from "node:test";

import { parseDuration } from "./duration.js";

test("minutes", () => {
  assert.equal(parseDuration("45m"), 2700);
});
`,
};

const bugFix = {
  name: "bug-fix",
  setup(w) {
    writeFiles(w.work, DURATION);
    w.git("add", ".");
    w.git("commit", "-q", "-m", "Add parseDuration");
    w.base = w.git("rev-parse", "HEAD");
  },
  drive: (w, { piPrint }) =>
    piPrint(
      w,
      '/skill:poteto-mode Bug report: parseDuration("1h30m") returns 1860, but it should return 5400 seconds. Fix it. ' +
        "You have full autonomy, so do not ask me anything. This repo has no remote, so skip the pull request and leave the fix committed on a branch.",
      { timeoutMs: 30 * MINUTE },
    ),
  checks({ w, run, t }) {
    const all = t.allCalls();
    const firstEdit = Math.min(...all.filter((c) => isEdit(c, "duration.js")).map((c) => c.at));
    const repro = Math.min(...all.filter((c) => c.name === "bash" && c.output.includes("1860")).map((c) => c.resultAt));
    const leadEdit = Math.min(...t.calls(t.parent).filter((c) => isEdit(c, "duration.js")).map((c) => c.at));
    const fixers = t.allRecords.filter(
      (r) => r.subagentType.startsWith("pstack:poteto-agent") && r.model === w.models.get("fable") && t.calls(t.sessionOf(r)).some((c) => isEdit(c, "duration.js")),
    );
    const branches = w.git("for-each-ref", "--format=%(objectname)", "refs/heads").split("\n").filter(Boolean);
    const passes = (dir) =>
      node(dir, "--test").status === 0 &&
      node(dir, "--input-type=module", "-e", 'import("./duration.js").then((m) => process.stdout.write(String(m.parseDuration("1h30m"))))').stdout === "5400";
    const fixed = branches.filter((sha) => sha !== w.base && atCommit(w, sha, passes));
    const reproFirst = fixed.some((tip) =>
      w
        .git("rev-list", "--reverse", `${w.base}..${tip}`)
        .split("\n")
        .filter((sha) => sha && sha !== tip)
        .some((sha) => atCommit(w, sha, (dir) => existsSync(join(dir, "duration.js")) && node(dir, "--test").status !== 0)),
    );
    // The lead may write the list itself or have a script copy it out of the playbook.
    const todoWrites = t.calls(t.parent).filter((c) =>
      (c.name === "write" || c.name === "edit") && String(c.args.path).endsWith("todo.md")
        ? JSON.stringify(c.args).includes("Reproduce it yourself")
        : c.name === "bash" && String(c.args.command).includes("todo.md") && String(c.args.command).includes("bug-fix.md"),
    );
    const replied = t.texts(t.parent).some((x) => x.at > firstEdit && x.text.includes("1860") && x.text.includes("5400"));
    return [
      ["pi exited 0 and settled", run.status === 0 && settled(run)],
      ["the lead read the bug-fix playbook", t.calls(t.parent).some((c) => c.name === "read" && String(c.args.path).endsWith("playbooks/bug-fix.md"))],
      ["the todo.md checklist copies the playbook's steps", todoWrites.length > 0],
      ["todo.md stays uncommitted", !w.git("log", "--all", "--name-only", "--format=").split("\n").some((p) => p.endsWith("todo.md"))],
      ["the bug was reproduced before any edit to duration.js", Number.isFinite(firstEdit) && repro < firstEdit],
      ["a delegate wrote the fix before the lead touched duration.js", fixers.length > 0 && Math.min(...fixers.flatMap((r) => t.calls(t.sessionOf(r)).filter((c) => isEdit(c, "duration.js")).map((c) => c.at))) < leadEdit],
      ["a pstack:poteto-agent on the bug-fix model made the fix", fixers.length > 0],
      ["a branch holds the fix, and its tests pass", fixed.length > 0],
      ["a failing repro commit lands before the fix", reproFirst],
      ["the lead's reply quotes the failing and passing values", replied],
    ];
  },
};

const LOOP_TASK = 'Append one line with the word tick to ticks.txt in the current directory. When ticks.txt has 3 lines, the work is done.';
const tickLines = (w) => (existsSync(join(w.work, "ticks.txt")) ? readFileSync(join(w.work, "ticks.txt"), "utf8").split("\n").filter(Boolean) : []);
const SELF_PACED = "[/loop, self-paced]";

const loopRpc = {
  name: "loop-rpc",
  async drive(w, { PiRpc }) {
    const pi = new PiRpc({ cwd: w.work, env: w.env, model: w.models.get("opus"), thinking: "medium" });
    try {
      await pi.command("prompt", { message: `/loop ${LOOP_TASK}` });
      await pi.until(() => tickLines(w).length >= 3, 10 * MINUTE, "three ticks");
      await pi.idle(0, 3 * MINUTE);
      await sleep(75_000);
      return { events: pi.events, ticks: tickLines(w) };
    } finally {
      await pi.close();
    }
  },
  checks({ run, t }) {
    const wakes = t.calls(t.parent).filter((c) => c.name === "schedule_wakeup");
    const iterations = t.parent
      .filter((e) => e.type === "message" && e.message.role === "user" && t.textOf(e.message).includes(SELF_PACED))
      .map((e) => Date.parse(e.timestamp));
    return [
      ["ticks.txt ends with exactly 3 ticks", run.ticks.length === 3 && run.ticks.every((l) => l.trim() === "tick")],
      ["every iteration got the self-paced loop instructions", iterations.length === 3],
      ["the loop scheduled itself exactly twice, then stopped", wakes.length === 2 && wakes.every((c) => !c.isError)],
      ["each wakeup re-runs /loop with the same task", wakes.length > 0 && wakes.every((c) => String(c.args.prompt).trim() === `/loop ${LOOP_TASK}`)],
      ["iterations ran at least 60 s apart", iterations.length > 1 && iterations.slice(1).every((at, i) => at - iterations[i] >= 59_000)],
    ];
  },
};

const loopPrint = {
  name: "loop-print",
  drive: (w, { piPrint }) => piPrint(w, `/loop ${LOOP_TASK}`, { timeoutMs: 10 * MINUTE }),
  checks({ w, run, t }) {
    const wakes = t.calls(t.parent).filter((c) => c.name === "schedule_wakeup");
    const ticks = tickLines(w);
    return [
      ["pi exited 0 and settled", run.status === 0 && settled(run)],
      ["the loop instructions reached the model", t.parent.some((e) => e.type === "message" && e.message.role === "user" && t.textOf(e.message).includes(SELF_PACED))],
      ["any schedule_wakeup call got the print-mode error", wakes.every((c) => c.isError && c.output.includes("cannot fire in json mode"))],
      ["the work finished inside the one run", ticks.length === 3 && ticks.every((l) => l.trim() === "tick")],
    ];
  },
};

export const scenarios = [interrogate, how, bugFix, loopRpc, loopPrint];
