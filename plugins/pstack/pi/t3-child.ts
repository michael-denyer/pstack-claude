import { readFileSync } from "node:fs";
import { type Static, type TSchema, Type } from "typebox";
import { Value } from "typebox/value";

import { alive, type ChildExit, type Fate } from "./child.ts";

const PROTOCOL = "2025-06-18";
const WAIT_MS = 30_000;
const LOST_LAUNCH = "pstack: the Pi session that started this agent ended before T3 Code answered its launch, so the task is cancelled.";
// T3 Code's terminal task statuses (OrchestratorMcpTerminalDelegatedTaskStatus).
const ENDED = new Set(["completed", "failed", "cancelled", "interrupted"]);

const toolResult = Type.Object({
  content: Type.Optional(Type.Array(Type.Object({ type: Type.String(), text: Type.Optional(Type.String()) }))),
  structuredContent: Type.Optional(Type.Unknown()),
  isError: Type.Optional(Type.Boolean()),
});
const delegated = Type.Object({ taskId: Type.String(), childThreadId: Type.String(), childRunId: Type.Union([Type.String(), Type.Null()]) });
const sent = Type.Object({ taskId: Type.Optional(Type.Union([Type.String(), Type.Null()])), runId: Type.String(), delivery: Type.String() });
const waited = Type.Object({ timedOut: Type.Boolean() });
const taskResult = Type.Object({ status: Type.String(), summary: Type.Union([Type.String(), Type.Null()]) });
const capabilities = Type.Object({
  inheritedProviderInstanceId: Type.String(),
  inheritedModel: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  providers: Type.Array(
    Type.Object({
      providerInstanceId: Type.String(),
      models: Type.Array(Type.Object({ id: Type.String(), options: Type.Optional(Type.Array(Type.Object({ id: Type.String(), values: Type.Optional(Type.Array(Type.Unknown())) }))) })),
    }),
  ),
});

export interface T3Session {
  endpoint: string;
  token: string;
}

export const T3_ENV_REMOVED = { T3_MCP_URL: undefined, T3_MCP_BEARER_TOKEN: undefined };

export function t3Session(): T3Session | undefined {
  const endpoint = process.env.T3_MCP_URL;
  const token = process.env.T3_MCP_BEARER_TOKEN;
  return endpoint && token ? { endpoint, token } : undefined;
}

export interface T3Task {
  threadId: string;
  taskId: string;
}

export interface T3Launch {
  title: string;
  model?: string;
  thinking?: string;
  threadId?: string;
  requestId?: string;
  onStart: (task: T3Task) => void;
}

interface T3Request {
  requestId: string;
  title: string;
}

// A T3 Code thread takes no launch flags, so its first message carries the agent file's body.
export function t3Brief(agent: { subagentType: string; systemPromptFile?: string }, prompt: string): string {
  const body = agent.systemPromptFile ? readFileSync(agent.systemPromptFile, "utf8").trim() : "";
  const parts = [
    body && `<agent name="${agent.subagentType}">\n${body}\n</agent>`,
    prompt,
  ];
  return parts.filter(Boolean).join("\n\n");
}

export class T3Child {
  readonly pid = undefined;
  readonly activity = undefined;
  readonly exited: Promise<ChildExit>;
  private readonly mcp: T3Mcp;
  private readonly onStart: (task: T3Task) => void;
  private threadId?: string;
  private taskId?: string;
  private readonly runs: (string | undefined)[] = [];
  private steers: Promise<unknown> = Promise.resolve();
  private done = false;
  private ending = false;
  private cancelled?: { taskId: string; done: Promise<void> };
  private readonly stopWaiting = new AbortController();

  constructor(session: T3Session, launch: T3Launch, prompt: string) {
    this.mcp = new T3Mcp(session);
    this.onStart = launch.onStart;
    this.exited = this.drive(launch, prompt);
  }

  async steer(message: string): Promise<{ response: { success: boolean } | undefined; taken: boolean }> {
    const threadId = this.threadId;
    if (this.done || threadId === undefined) return { response: undefined, taken: false };
    const send = this.mcp.call(sent, "t3_thread_send", { threadId, message, mode: "steer" }, this.stopWaiting.signal).then(({ taskId, runId, delivery }) => {
      if (delivery === "steered") return;
      this.runs.push(runId);
      if (!taskId) return;
      this.taskId = taskId;
      this.onStart({ threadId, taskId });
      if (this.ending) void this.cancel();
    });
    this.steers = Promise.allSettled([this.steers, send]);
    try {
      await send;
      return { response: { success: true }, taken: true };
    } catch {
      return { response: undefined, taken: false };
    }
  }

  // T3 Code has no kill, so after graceMs the agent stops waiting for the thread to settle.
  end(graceMs: number): void {
    this.ending = true;
    void this.cancel();
    setTimeout(() => this.stopWaiting.abort(new Error(`T3 Code had not settled thread ${this.threadId} ${graceMs} ms after the cancel of task ${this.taskId}.`)), graceMs).unref();
  }

  // The exit hook runs synchronously, so a task_cancel would never go out; a resumed session inside T3 Code cancels the task as an orphan.
  signal(): void {}

  private async drive(launch: T3Launch, prompt: string): Promise<ChildExit> {
    try {
      const threadId = await this.start(launch, prompt);
      if (this.ending) await this.cancel();
      let steers: Promise<unknown>;
      let result: Static<typeof taskResult>;
      do {
        steers = this.steers;
        await steers;
        for (const runId of this.runs) await settled(this.mcp, threadId, runId, this.stopWaiting.signal);
        result = await this.mcp.call(taskResult, "task_status", { taskId: this.taskId });
      } while (steers !== this.steers);
      this.done = true;
      const { status, summary } = result;
      const text = summary ?? "";
      if (status === "completed") return { exitCode: 0, settled: true, finalText: text, errorMessage: "", stderr: "" };
      return { exitCode: null, settled: false, finalText: "", errorMessage: text || `The T3 Code task ended with status ${status}.`, stderr: "" };
    } catch (e) {
      const message = (e as Error).message;
      return { exitCode: null, settled: false, finalText: this.ending ? message : "", errorMessage: message, stderr: "" };
    }
  }

  private async start(launch: T3Launch, prompt: string): Promise<string> {
    if (launch.threadId !== undefined) {
      this.threadId = launch.threadId;
      const { taskId, runId } = await this.mcp.call(sent, "t3_thread_send", { threadId: launch.threadId, message: prompt, mode: "auto" });
      if (!taskId) throw new Error(`T3 Code took the message in thread ${launch.threadId} without starting a task.`);
      this.taskId = taskId;
      this.runs.push(runId);
      launch.onStart({ threadId: launch.threadId, taskId });
      return launch.threadId;
    }
    const thinking = launch.thinking && (await this.takesThinking(launch.model, launch.thinking)) ? { options: { thinking: launch.thinking } } : {};
    const target = { ...(launch.model && { model: launch.model }), ...thinking };
    const task = await this.mcp.call(delegated, "delegate_task", { task: prompt, title: launch.title, target, mode: "async", clientRequestId: launch.requestId });
    this.threadId = task.childThreadId;
    this.taskId = task.taskId;
    this.runs.push(task.childRunId ?? undefined);
    launch.onStart({ threadId: task.childThreadId, taskId: task.taskId });
    return task.childThreadId;
  }

  private async takesThinking(model: string | undefined, thinking: string): Promise<boolean> {
    const caps = await this.mcp.call(capabilities, "orchestrator_capabilities", model ? { search: model } : {});
    const id = model ?? caps.inheritedModel;
    const provider = caps.providers.find((p) => p.providerInstanceId === caps.inheritedProviderInstanceId);
    const levels = provider?.models.find((m) => m.id === id)?.options?.find((o) => o.id === "thinking")?.values ?? [];
    return levels.includes(thinking);
  }

  private cancel(): Promise<void> | undefined {
    const { taskId, threadId } = this;
    if (taskId === undefined) return;
    if (this.cancelled?.taskId !== taskId) {
      const done = this.mcp.call(Type.Unknown(), "task_cancel", { taskId, reason: "stop_agent" }).then(
        () => undefined,
        (e: Error) => this.stopWaiting.abort(new Error(`T3 Code did not cancel task ${taskId}, so thread ${threadId} may still be running: ${e.message}`)),
      );
      this.cancelled = { taskId, done };
    }
    return this.cancelled.done;
  }
}

export async function cancelOrphan(orphan: T3Task | T3Request): Promise<boolean> {
  const session = t3Session();
  if (!session) return false;
  const mcp = new T3Mcp(session);
  // T3 Code answers a request id it has seen with that launch's task, so a launch whose answer never came is found by sending it again.
  const task =
    "taskId" in orphan
      ? orphan
      : await mcp.call(delegated, "delegate_task", { task: LOST_LAUNCH, title: orphan.title, mode: "async", clientRequestId: orphan.requestId }).then(
          ({ taskId, childThreadId }) => ({ taskId, threadId: childThreadId }),
          () => undefined,
        );
  if (!task) return false;
  try {
    await mcp.call(Type.Unknown(), "task_cancel", { taskId: task.taskId, reason: "its Pi session ended" });
    await settled(mcp, task.threadId);
    return true;
  } catch {
    // A task that has already ended needs no cancel, and T3 Code may refuse one for good.
    return mcp.call(taskResult, "task_status", { taskId: task.taskId }).then(({ status }) => ENDED.has(status), () => false);
  }
}

type T3Record = { parentPid: number; t3TaskId?: string; t3RequestId?: string; agent: { description: string; t3ThreadId?: string } };

export const t3Host = {
  fate: ({ t3TaskId, t3RequestId, parentPid }: T3Record): Fate =>
    t3TaskId === undefined && t3RequestId === undefined ? "gone" : parentPid !== process.pid && alive(parentPid) ? "kept" : "orphan",
  reap: async ({ t3TaskId, t3RequestId, agent }: T3Record): Promise<Fate> => {
    const orphan = t3TaskId && agent.t3ThreadId ? { taskId: t3TaskId, threadId: agent.t3ThreadId } : t3RequestId && { requestId: t3RequestId, title: agent.description };
    return orphan && (await cancelOrphan(orphan)) ? "gone" : "orphan";
  },
  notEnded: ({ t3TaskId, t3RequestId }: T3Record): string => `T3 Code task ${t3TaskId ?? `of launch request ${t3RequestId}`} has not been cancelled`,
};

async function settled(mcp: T3Mcp, threadId: string, runId?: string, signal?: AbortSignal): Promise<void> {
  for (;;) {
    const { timedOut } = await mcp.call(waited, "t3_thread_wait", { threadId, ...(runId && { runId }), timeoutMs: WAIT_MS, untilDelegatedWorkSettled: true }, signal);
    if (!timedOut) return;
  }
}

class T3Mcp {
  private nextId = 1;
  private sessionId?: string;
  private ready?: Promise<unknown>;

  constructor(private readonly session: T3Session) {}

  async call<T extends TSchema>(schema: T, name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<Static<T>> {
    this.ready ??= this.request("initialize", { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "pstack", version: "1" } }).then(() =>
      this.post({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }),
    );
    await this.ready;
    const result = await this.request("tools/call", { name, arguments: args }, signal);
    if (!Value.Check(toolResult, result)) throw new Error(`T3 Code ${name} answered: ${JSON.stringify(result).slice(0, 300)}`);
    const text = result.content?.find((part) => part.type === "text")?.text ?? "";
    if (result.isError) throw new Error(`T3 Code ${name} failed: ${text.slice(0, 1000)}`);
    const value = result.structuredContent ?? parseJson(text);
    if (value === undefined || !Value.Check(schema, value)) throw new Error(`T3 Code ${name} answered: ${text.slice(0, 300)}`);
    return value;
  }

  private async request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    const response = await this.post({ jsonrpc: "2.0", id: this.nextId++, method, params }, signal);
    const body = await response.text();
    if (!response.ok) throw new Error(`T3 Code MCP ${method} failed (${response.status}): ${body.slice(0, 300)}`);
    const reply = rpcReply(body, response.headers.get("content-type") ?? "");
    if (reply.error) throw new Error(`T3 Code MCP ${method} failed: ${reply.error.message ?? JSON.stringify(reply.error)}`);
    return reply.result;
  }

  private async post(message: unknown, signal?: AbortSignal): Promise<Response> {
    const headers: Record<string, string> = {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${this.session.token}`,
      "content-type": "application/json",
      "mcp-protocol-version": PROTOCOL,
      ...(this.sessionId && { "mcp-session-id": this.sessionId }),
    };
    const response = await fetch(this.session.endpoint, { method: "POST", headers, body: JSON.stringify(message), signal });
    this.sessionId = response.headers.get("mcp-session-id") ?? this.sessionId;
    return response;
  }
}

function rpcReply(body: string, contentType: string): { result?: unknown; error?: { message?: string } } {
  if (!contentType.includes("text/event-stream")) return JSON.parse(body);
  let data: string[] = [];
  for (const line of [...body.split(/\r\n|\r|\n/), ""]) {
    if (line.startsWith("data:")) data.push(line.slice(line.startsWith("data: ") ? 6 : 5));
    else if (line === "" && data.length) {
      const text = data.join("\n");
      data = [];
      if (!text) continue;
      const reply = JSON.parse(text);
      if (reply.id !== undefined) return reply;
    }
  }
  throw new Error("T3 Code MCP sent an event stream with no reply.");
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
