import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const mandate = readFileSync(join(root, "hooks", "session-start-context.md"), "utf8");
const marker = "[pstack OMP instructions]";
const adapter = `${marker}
A pstack skill's URL is skill://pstack/<name> when OMP's skill list names pstack/<name>, and skill://<name> otherwise; read a file inside it as that URL followed by /<path>. Before following a pstack skill, read skill://poteto-mode/references/omp-tools.md, or skill://pstack/poteto-mode/references/omp-tools.md when the list names pstack/poteto-mode, for OMP tool and model mappings. Resolve every pstack:<name> skill in the following instructions by reading its URL. For example, read skill://poteto-mode for pstack:poteto-mode, or skill://pstack/poteto-mode when the list names pstack/poteto-mode. Do not read pstack skills by their absolute install path, which can sit in a folder the user restricted.`;

function instructions(routed) {
  return routed ? `${adapter}\n${mandate}` : adapter;
}

function routingOff() {
  try {
    const bytes = readFileSync(join(homedir(), ".omp", "pstack-models.md"));
    const text = bytes[0] === 0xff && bytes[1] === 0xfe
      ? new TextDecoder("utf-16le", { fatal: true }).decode(bytes)
      : bytes.toString("utf8").replace(/^\uFEFF/, "");
    return text.split(/\r?\n/).includes("session hook: off");
  } catch {
    return false;
  }
}

export default function pstack(omp) {
  omp.on("before_agent_start", (event, ctx) => {
    if (event.systemPrompt.some((section) => section.includes(marker))) return;
    return { systemPrompt: [...event.systemPrompt, instructions(ctx.agent.kind === "main" && !routingOff())] };
  });
}
