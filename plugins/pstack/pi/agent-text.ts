// What the model reads about an agent: tool results, completion notices, and
// the cap on text that stays inline. Pure functions of the persisted record.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { AgentRecord, EndedRecord } from "./agents.ts";

const NOTICE_TYPE = "pstack-agent";
export const OUTPUT_CAP_BYTES = 50 * 1024;

export function truncateUtf8(text: string, cap: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= cap) return text;
  let end = cap;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString("utf8");
}

function header(record: AgentRecord): string {
  const lines = [`agentId: ${record.id}`, `description: ${record.description}`, `status: ${record.status}`];
  if (record.status !== "running") lines.push(`exit code: ${record.exitCode}`);
  if (record.worktree) {
    const removed = record.status !== "running" && record.worktreeKept === false;
    lines.push(removed ? `worktree: ${record.worktree.path} (no changes; removed)` : `worktree: ${record.worktree.path} (branch ${record.worktree.branch})`);
  }
  return lines.join("\n");
}

// The final text, cut to the cap with the full copy on disk.
function report(record: EndedRecord): string {
  if (!record.outputFile) return record.finalText;
  return `${truncateUtf8(record.finalText, OUTPUT_CAP_BYTES)}\n\n[Output truncated at ${OUTPUT_CAP_BYTES / 1024} KB. Full output: ${record.outputFile}]`;
}

export function resultText(record: AgentRecord): string {
  return record.status === "running" ? header(record) : `${header(record)}\n\n${report(record)}`;
}

export function noticeOf(record: EndedRecord): Parameters<ExtensionAPI["sendMessage"]>[0] {
  return {
    customType: NOTICE_TYPE,
    content: `pstack agent finished.\n${header(record)}${record.outputFile ? `\nfull output: ${record.outputFile}` : ""}\n\n${report(record)}`,
    display: true,
    details: { agentId: record.id, status: record.status, exitCode: record.exitCode, outputFile: record.outputFile },
  };
}
