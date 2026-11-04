import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
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

export default function pstack(omp) {
  omp.on("before_agent_start", (event, ctx) => {
    if (event.systemPrompt.some((section) => section.includes(marker))) return;
    return { systemPrompt: [...event.systemPrompt, instructions(ctx.agent.kind)] };
  });
}
