import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const hooksDir = dirname(fileURLToPath(import.meta.url));
const pluginRoot = dirname(hooksDir);
const scriptPath = join(hooksDir, "session-start.sh");

// pi's getAgentDir expands ~ while the shell arm reads the raw variable,
// so replicate the tilde expansion here for the sheet-body read.
function resolveAgentDir(): string {
  const env = process.env.PI_CODING_AGENT_DIR;
  if (env) return env.replace(/^~(?=\/|$)/, process.env.HOME ?? "~");
  return join(process.env.HOME ?? "", ".pi", "agent");
}

interface PiExecResult {
  stdout: string;
  stderr: string;
  code: number;
  killed: boolean;
}

interface PiRuntime {
  on(event: string, handler: (event: any) => void | Promise<void>): void;
  exec(cmd: string, args: string[], opts?: Record<string, unknown>): Promise<PiExecResult>;
}

export default function register(pi: PiRuntime): void {
  pi.on("before_agent_start", async (event) => {
    const dir = resolveAgentDir();
    const sheetPath = join(dir, "pstack-models.md");
    const parts: string[] = [];

    // pi's ExecOptions has no env field, so use the env(1) command to inject
    // CLAUDE_PLUGIN_ROOT and PI_CODING_AGENT_DIR into the child process.
    const result = await pi.exec("env", [
      `CLAUDE_PLUGIN_ROOT=${pluginRoot}`,
      `PI_CODING_AGENT_DIR=${dir}`,
      "sh",
      scriptPath,
      "pi",
    ]);
    if (result.code !== 0) {
      throw new Error(result.stderr || `session-start.sh exited ${result.code}`);
    }
    if (result.stdout) {
      parts.push(result.stdout);
    }

    // Sheet body appended regardless of hook setting, mirroring Claude Code's
    // always-active @-include for model-configuration lines.
    if (existsSync(sheetPath)) {
      const body = readFileSync(sheetPath, "utf8");
      if (body) parts.push(body);
    }

    if (parts.length > 0) {
      const existing = event.systemPromptOptions.appendSystemPrompt || "";
      event.systemPromptOptions.appendSystemPrompt =
        existing + (existing ? "\n\n" : "") + parts.join("\n\n");
    }
  });
}
