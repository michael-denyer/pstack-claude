import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const skills = join(root, "skills");
const mapping = join(root, "skills", "poteto-mode", "references", "omp-tools.md");
const mandate = readFileSync(join(root, "hooks", "session-start-context.md"), "utf8");
const marker = "[pstack OMP instructions]";

export function instructions(kind) {
  const adapter = `${marker}\nBefore following a pstack skill, read ${JSON.stringify(mapping)} for OMP tool and model mappings. Resolve every pstack:<name> skill in the following instructions by reading the installed plugin file at ${JSON.stringify(join(skills, "<name>", "SKILL.md"))}, substituting the named skill. For example, read ${JSON.stringify(join(skills, "poteto-mode", "SKILL.md"))} for pstack:poteto-mode. Do not resolve these names through a bare skill name, which can select a different installation.`;
  if (kind !== "main") return adapter;
  return `${adapter}\n${mandate}`;
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
    if (ctx.agent.kind === "main" && routingOff()) return;
    return { systemPrompt: [...event.systemPrompt, instructions(ctx.agent.kind)] };
  });
}
