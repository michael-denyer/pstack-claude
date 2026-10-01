import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORT_LEVELS)[number];
export const PARENT_MODEL_ALIASES = ["inherit-parent", "auto"];

export interface Settings {
  pluginRoot: string;
  modelsFile: string;
  agentDir: string;
  pi: { command: string; args: string[] };
  childEnv: NodeJS.ProcessEnv;
  // Layers below the main session: 0 there, 1 in its agents, and so on.
  depth: number;
  killGraceMs: number;
}

// Pi re-runs itself for children when it can: the same runtime and CLI script,
// so a child never picks up a different pi from PATH.
function piInvocation(env: NodeJS.ProcessEnv): Settings["pi"] {
  if (env.PSTACK_PI_BIN) return { command: env.PSTACK_PI_BIN, args: [] };
  const script = process.argv[1];
  if (script && !script.startsWith("/$bunfs/") && existsSync(script)) {
    return { command: process.execPath, args: [script] };
  }
  const exe = basename(process.execPath).toLowerCase();
  return /^(node|bun)(\.exe)?$/.test(exe) ? { command: "pi", args: [] } : { command: process.execPath, args: [] };
}

export function defaultSettings(env: NodeJS.ProcessEnv = process.env): Settings {
  const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const depth = Number(env.PSTACK_PI_DEPTH) || 0;
  return {
    pluginRoot,
    modelsFile: join(pluginRoot, "models.json"),
    agentDir: env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"),
    pi: piInvocation(env),
    childEnv: { ...env, PSTACK_PI_DEPTH: String(depth + 1) },
    depth,
    killGraceMs: 5000,
  };
}

export interface Sheet {
  text: string;
  hookOff: boolean;
  piModels: Map<string, string>;
}

export function parseSheet(text: string): Sheet {
  const lines = text.split(/\r?\n/);
  const piModels = new Map<string, string>();
  for (const line of lines) {
    const m = /^pi models:\s*(.*)$/.exec(line.trim());
    if (!m) continue;
    for (const pair of m[1].split(",")) {
      const [alias, id] = pair.split("=").map((s) => s.trim());
      if (alias && id) piModels.set(alias, id);
    }
  }
  return { text, hookOff: lines.some((l) => l === "session hook: off"), piModels };
}

export function readSheet(agentDir: string): Sheet | undefined {
  const file = join(agentDir, "pstack-models.md");
  return existsSync(file) ? parseSheet(readFileSync(file, "utf8")) : undefined;
}

interface ModelsConfig {
  available: string[];
  pi: { fallback: string; models: Record<string, Record<string, string>> };
}

function readModels(modelsFile: string): ModelsConfig {
  const raw = JSON.parse(readFileSync(modelsFile, "utf8"));
  return { available: raw.available ?? [], pi: raw.pi };
}

// Returns the provider/id for --model, or undefined when the child should run
// on Pi's default because the parent model is unknown.
export function resolveModel(
  requested: string | undefined,
  settings: Settings,
  sheet: Sheet | undefined,
  parentModel: string | undefined,
): string | undefined {
  if (!requested || PARENT_MODEL_ALIASES.includes(requested)) return parentModel;
  if (requested.includes("/")) return requested;
  const models = readModels(settings.modelsFile);
  if (!models.available.includes(requested)) {
    const valid = [...models.available, ...PARENT_MODEL_ALIASES, "<provider>/<model-id>"];
    throw new Error(`Unknown model "${requested}". Valid values: ${valid.join(", ")}.`);
  }
  // Family names follow the provider the session is signed in to, so a ChatGPT
  // subscription gets OpenAI models without any configuration.
  const provider = parentModel?.split("/")[0] ?? "";
  const table = models.pi.models[Object.hasOwn(models.pi.models, provider) ? provider : models.pi.fallback];
  const id = sheet?.piModels.get(requested) ?? table[requested];
  if (!id) {
    throw new Error(`No Pi model mapped for "${requested}": add a "pi models: ${requested}=<provider>/<id>" line to the override sheet.`);
  }
  return id;
}

export interface AgentDefinition {
  type: string;
  body: string;
  model?: string;
  effort?: Effort;
}

function parseAgentFile(type: string, text: string): AgentDefinition {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  const front = new Map<string, string>();
  for (const line of (m?.[1] ?? "").split(/\r?\n/)) {
    const kv = /^([\w-]+):\s*(.*)$/.exec(line);
    if (kv) front.set(kv[1], kv[2].trim());
  }
  const effort = front.get("effort");
  if (effort !== undefined && !EFFORT_LEVELS.includes(effort as Effort)) {
    throw new Error(`${type}: effort "${effort}" is not one of ${EFFORT_LEVELS.join(", ")}`);
  }
  return { type, body: (m?.[2] ?? text).trim(), model: front.get("model") || undefined, effort: effort as Effort };
}

// Claude Code registers each plugin agent file as pstack:<file name>.
export function loadAgentTypes(pluginRoot: string): Map<string, AgentDefinition> {
  const types = new Map<string, AgentDefinition>();
  for (const dir of ["agents", "effort-agents"]) {
    const full = join(pluginRoot, dir);
    if (!existsSync(full)) continue;
    for (const file of readdirSync(full).filter((f) => f.endsWith(".md")).sort()) {
      const type = `pstack:${basename(file, ".md")}`;
      types.set(type, parseAgentFile(type, readFileSync(join(full, file), "utf8")));
    }
  }
  return types;
}

export function stateDir(settings: Settings, sessionId: string): string {
  return join(settings.agentDir, "pstack", sessionId);
}
