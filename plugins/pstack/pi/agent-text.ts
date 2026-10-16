// What the model reads about an agent: tool results, completion notices, and
// the cap on text that stays inline. Pure functions of the persisted record
// and the path of the child's transcript and its live activity, which the
// caller looks up.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { AgentRecord, EndedRecord } from "./agents.ts";
import type { Activity } from "./child.ts";

const NOTICE_TYPE = "pstack-agent";
export const OUTPUT_CAP_BYTES = 50 * 1024;

export function truncateUtf8(text: string, cap: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= cap) return text;
  let end = cap;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString("utf8");
}

function header({ agent, ...record }: EndedRecord, transcript: string | undefined): string {
  const lines = [`agentId: ${agent.id}`, `description: ${agent.description}`, `status: ${record.status}`, `exit code: ${record.exitCode}`];
  if (agent.worktree) {
    const state = record.worktreeKept === false ? "no changes; removed" : `branch ${agent.worktree.branch}`;
    lines.push(`worktree: ${agent.worktree.path} (${state})`);
  }
  if (transcript) lines.push(`transcript: ${transcript}`);
  return lines.join("\n");
}

// The record's text is already cut to the cap, with the full copy on disk.
function report(record: EndedRecord): string {
  if (!record.outputFile) return record.finalText;
  return `${record.finalText}\n\n[Output truncated at ${OUTPUT_CAP_BYTES / 1024} KB. Full output: ${record.outputFile}]`;
}

export function resultText(record: EndedRecord, transcript: string | undefined): string {
  return `${header(record, transcript)}\n\n${report(record)}`;
}

type Lookups = {
  transcriptOf: (agent: AgentRecord["agent"]) => string | undefined;
  activityOf: (agent: AgentRecord["agent"]) => Activity | undefined;
};

export function listing(records: AgentRecord[], { transcriptOf, activityOf }: Lookups): object[] {
  return records.map(({ agent, ...r }) => ({
    id: agent.id,
    description: agent.description,
    subagent_type: agent.subagentType,
    model: agent.model ?? "(pi default)",
    status: r.status,
    pid: r.pid,
    startedAt: agent.startedAt,
    endedAt: r.status === "running" ? undefined : r.endedAt,
    worktree: agent.worktree?.path,
    sessionFile: transcriptOf(agent),
    activity: r.status === "running" ? activityOf(agent) : undefined,
  }));
}

const toolLine = ({ name, args }: NonNullable<Activity["tool"]>) => (args ? `${name}: ${args}` : name);

// The footer line: how many run, then the most recently active one.
export function statusText(running: { id: string; at: string; activity?: Activity }[]): string | undefined {
  if (!running.length) return undefined;
  const latest = running.reduce((a, b) => (b.at > a.at ? b : a));
  const { tool, said } = latest.activity ?? {};
  const doing = tool?.running ? toolLine(tool) : (said ?? (tool && toolLine(tool)));
  return `pstack: ${running.length} running${doing ? ` · ${latest.id.slice(0, 8)} ${doing}` : ""}`;
}

// What /pstack-agents shows the user: one block per agent.
export function agentsReport(records: AgentRecord[], { transcriptOf, activityOf }: Lookups): string {
  if (!records.length) return "No pstack agents in this session.";
  return records
    .map(({ agent, status }) => {
      const lines = [`${agent.id} ${status}: ${agent.description}`];
      const activity = status === "running" ? activityOf(agent) : undefined;
      if (activity?.tool) lines.push(`${activity.tool.running ? "now" : "last"}: ${toolLine(activity.tool)}`);
      if (activity?.said) lines.push(`said: ${activity.said}`);
      const transcript = transcriptOf(agent);
      if (transcript) lines.push(`transcript: ${transcript}`, `read it: ${status === "running" ? "tail -f" : "pi --export"} ${transcript}`);
      else lines.push("transcript: not written yet");
      return lines.join("\n");
    })
    .join("\n\n");
}

export function noticeOf(record: EndedRecord, transcript: string | undefined): Parameters<ExtensionAPI["sendMessage"]>[0] {
  return {
    customType: NOTICE_TYPE,
    content: `pstack agent finished.\n${header(record, transcript)}${record.outputFile ? `\nfull output: ${record.outputFile}` : ""}\n\n${report(record)}`,
    display: true,
    details: { agentId: record.agent.id, status: record.status, exitCode: record.exitCode, outputFile: record.outputFile },
  };
}
