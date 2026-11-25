import { readFileSync } from "node:fs";
import { type Static, type TSchema, Type } from "typebox";
import { Value } from "typebox/value";

import type { ChildExit } from "./child.ts";

const PROTOCOL = "2025-06-18";
const WAIT_MS = 30_000;

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
  onStart: (task: T3Task) => void;
}

// A T3 Code thread takes no launch flags, so its first message carries the agent file's body and the read-only rule.
export function t3Brief(agent: { subagentType: string; systemPromptFile?: string; readonly?: true }, prompt: string): string {
  const body = agent.systemPromptFile ? readFileSync(agent.systemPromptFile, "utf8").trim() : "";
  const parts = [
    body && `<agent name="${agent.subagentType}">\n${body}\n</agent>`,
    agent.readonly && "You are read-only: do not change any file, with the edit and write tools or with bash.",
    prompt,
  ];
  return parts.filter(Boolean).join("\n\n");
}

export class T3Child {
  readonly pid = undefined;
  readonly activity = undefined;
  readonly exited: Promise<ChildExit>;
  private readonly mcp: T3Mcp;
  private threadId?: string;
  private taskId?: string;
  private settled = false;
  private ending = false;
  private cancelled?: Promise<void>;
  private readonly refused: Promise<never>;
  private refuse!: (e: Error) => void;

  constructor(session: T3Session, launch: T3Launch, prompt: string) {
    this.mcp = new T3Mcp(session);
    this.refused = new Promise<never>((_, reject) => (this.refuse = reject));
    this.refused.catch(() => undefined);
    this.exited = this.drive(launch, prompt);
  }

  async steer(message: string): Promise<{ response: { success: boolean } | undefined; taken: boolean }> {
    if (this.settled || this.threadId === undefined) return { response: undefined, taken: false };
    try {
      const { delivery } = await this.mcp.call(sent, "t3_thread_send", { threadId: this.threadId, message, mode: "steer" });
      return { response: { success: true }, taken: delivery === "steered" && !this.settled };
    } catch {
      return { response: undefined, taken: false };
    }
  }

  end(): void {
    this.ending = true;
    void this.cancel();
  }

  // From the exit hook, which cannot wait for a reply: a resumed session cancels the task instead.
  signal(): void {
    this.end();
  }

  private async drive(launch: T3Launch, prompt: string): Promise<ChildExit> {
    try {
      const { threadId, runId } = await this.start(launch, prompt);
      if (this.ending) await this.cancel();
      await Promise.race([settled(this.mcp, threadId, runId), this.refused]);
      const { status, summary } = await this.mcp.call(taskResult, "task_status", { taskId: this.taskId });
      this.settled = status === "completed";
      const text = summary ?? "";
      if (this.settled) return { exitCode: 0, settled: true, finalText: text, errorMessage: "", stderr: "" };
      return { exitCode: null, settled: false, finalText: "", errorMessage: text || `The T3 Code task ended with status ${status}.`, stderr: "" };
    } catch (e) {
      const message = (e as Error).message;
      return { exitCode: null, settled: false, finalText: this.ending ? message : "", errorMessage: message, stderr: "" };
    }
  }

  private async start(launch: T3Launch, prompt: string): Promise<{ threadId: string; runId?: string }> {
    if (launch.threadId !== undefined) {
      this.threadId = launch.threadId;
      const { taskId, runId } = await this.mcp.call(sent, "t3_thread_send", { threadId: launch.threadId, message: prompt, mode: "auto" });
      if (!taskId) throw new Error(`T3 Code took the message in thread ${launch.threadId} without starting a task.`);
      this.taskId = taskId;
      launch.onStart({ threadId: launch.threadId, taskId });
      return { threadId: launch.threadId, runId };
    }
    const thinking = launch.thinking && (await this.takesThinking(launch.model, launch.thinking)) ? { options: { thinking: launch.thinking } } : {};
    const target = { ...(launch.model && { model: launch.model }), ...thinking };
    const task = await this.mcp.call(delegated, "delegate_task", { task: prompt, title: launch.title, target, mode: "async" });
    this.threadId = task.childThreadId;
    this.taskId = task.taskId;
    launch.onStart({ threadId: task.childThreadId, taskId: task.taskId });
    return { threadId: task.childThreadId, runId: task.childRunId ?? undefined };
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
    this.cancelled ??= this.mcp.call(Type.Unknown(), "task_cancel", { taskId, reason: "stop_agent" }).then(
      () => undefined,
      (e: Error) => this.refuse(new Error(`T3 Code did not cancel task ${taskId}, so thread ${threadId} may still be running: ${e.message}`)),
    );
    return this.cancelled;
  }
}

export async function cancelOrphan(task: T3Task): Promise<boolean> {
  const session = t3Session();
  if (!session) return false;
  const mcp = new T3Mcp(session);
  try {
    await mcp.call(Type.Unknown(), "task_cancel", { taskId: task.taskId, reason: "its Pi session ended" });
    await settled(mcp, task.threadId);
    return true;
  } catch {
    return false;
  }
}

async function settled(mcp: T3Mcp, threadId: string, runId?: string): Promise<void> {
  for (;;) {
    const { timedOut } = await mcp.call(waited, "t3_thread_wait", { threadId, ...(runId && { runId }), timeoutMs: WAIT_MS, untilDelegatedWorkSettled: true });
    if (!timedOut) return;
  }
}

class T3Mcp {
  private nextId = 1;
  private sessionId?: string;
  private ready?: Promise<unknown>;

  constructor(private readonly session: T3Session) {}

  async call<T extends TSchema>(schema: T, name: string, args: Record<string, unknown>): Promise<Static<T>> {
    this.ready ??= this.request("initialize", { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "pstack", version: "1" } }).then(() =>
      this.post({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }),
    );
    await this.ready;
    const result = await this.request("tools/call", { name, arguments: args });
    if (!Value.Check(toolResult, result)) throw new Error(`T3 Code ${name} answered: ${JSON.stringify(result).slice(0, 300)}`);
    const text = result.content?.find((part) => part.type === "text")?.text ?? "";
    if (result.isError) throw new Error(`T3 Code ${name} failed: ${text.slice(0, 1000)}`);
    const value = result.structuredContent ?? JSON.parse(text);
    if (!Value.Check(schema, value)) throw new Error(`T3 Code ${name} answered: ${text.slice(0, 300)}`);
    return value;
  }

  private async request(method: string, params: unknown): Promise<unknown> {
    const response = await this.post({ jsonrpc: "2.0", id: this.nextId++, method, params });
    const body = await response.text();
    if (!response.ok) throw new Error(`T3 Code MCP ${method} failed (${response.status}): ${body.slice(0, 300)}`);
    const reply = rpcReply(body, response.headers.get("content-type") ?? "");
    if (reply.error) throw new Error(`T3 Code MCP ${method} failed: ${reply.error.message ?? JSON.stringify(reply.error)}`);
    return reply.result;
  }

  private async post(message: unknown): Promise<Response> {
    const headers: Record<string, string> = {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${this.session.token}`,
      "content-type": "application/json",
      "mcp-protocol-version": PROTOCOL,
      ...(this.sessionId && { "mcp-session-id": this.sessionId }),
    };
    const response = await fetch(this.session.endpoint, { method: "POST", headers, body: JSON.stringify(message) });
    this.sessionId = response.headers.get("mcp-session-id") ?? this.sessionId;
    return response;
  }
}

function rpcReply(body: string, contentType: string): { result?: unknown; error?: { message?: string } } {
  if (!contentType.includes("text/event-stream")) return JSON.parse(body);
  for (const line of body.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const reply = JSON.parse(line.slice(5));
    if (reply.id !== undefined) return reply;
  }
  throw new Error("T3 Code MCP sent an event stream with no reply.");
}
