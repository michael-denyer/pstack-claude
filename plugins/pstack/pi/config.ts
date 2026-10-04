import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
type Effort = (typeof EFFORT_LEVELS)[number];
const PARENT_MODEL_ALIASES = ["inherit-parent", "auto"];

// A parent passes it to each agent it starts, so the agent knows its depth.
export const DEPTH_FLAG = "pstack-depth";

export interface Settings {
  pluginRoot: string;
  modelsFile: string;
  agentDir: string;
  pi: { command: string; args: string[] };
  // Unset, so an agent inherits the session's environment. Tests set it to
  // configure their fake pi.
  childEnv?: NodeJS.ProcessEnv;
  // Layers below the main session: 0 there, 1 in its agents, and so on.
  readonly depth: number;
  killGraceMs: number;
  // How long a settled child gets to exit after its stdin closes. It covers a
  // nested child's own shutdown, which stops its agents with killGraceMs each.
  exitGraceMs: number;
}

// Pi re-runs itself for children when it can: the same runtime and CLI script,
// so a child never picks up a different pi from PATH.
function piInvocation(): Settings["pi"] {
  const script = process.argv[1];
  if (script && !script.startsWith("/$bunfs/") && existsSync(script)) {
    return { command: process.execPath, args: [script] };
  }
  const exe = basename(process.execPath).toLowerCase();
  return /^(node|bun)(\.exe)?$/.test(exe) ? { command: "pi", args: [] } : { command: process.execPath, args: [] };
}

// readDepth is called on each use: pi parses extension flags after it loads
// the extension.
export function defaultSettings(readDepth: () => number, env: NodeJS.ProcessEnv = process.env): Settings {
  const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  return {
    pluginRoot,
    modelsFile: join(pluginRoot, "models.json"),
    agentDir: env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"),
    pi: piInvocation(),
    get depth() {
      return readDepth();
    },
    killGraceMs: 5000,
    exitGraceMs: 30_000,
  };
}

interface Sheet {
  text: string;
  hookOff: boolean;
  piModels: Map<string, string>;
}

export function parseSheet(text: string): Sheet {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
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
  return statSync(file, { throwIfNoEntry: false })?.isFile() ? parseSheet(readFileSync(file, "utf8")) : undefined;
}

// The parts of models.json the extension reads; the generator checks the rest.
const modelsConfig = Type.Object({
  available: Type.Array(Type.String()),
  pi: Type.Object({ fallback: Type.String(), models: Type.Record(Type.String(), Type.Record(Type.String(), Type.String())) }),
});

function readModels(modelsFile: string): Static<typeof modelsConfig> {
  const raw: unknown = JSON.parse(readFileSync(modelsFile, "utf8"));
  if (!Value.Check(modelsConfig, raw)) throw new Error(`${modelsFile} is not a pstack models file: it needs available[] and pi.{fallback, models}.`);
  return raw;
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

export const GENERAL_PURPOSE = "general-purpose";

interface AgentDefinition {
  body: string;
  model?: string;
  effort?: Effort;
}

export function frontmatter(text: string): { fields: Map<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  const fields = new Map<string, string>();
  for (const line of (m?.[1] ?? "").split(/\r?\n/)) {
    const kv = /^([\w-]+):\s*(.*)$/.exec(line);
    if (kv) fields.set(kv[1], kv[2].trim());
  }
  return { fields, body: (m?.[2] ?? text).trim() };
}

function parseAgentFile(type: string, text: string): AgentDefinition {
  const { fields, body } = frontmatter(text);
  const named = fields.get("effort");
  const effort = EFFORT_LEVELS.find((level) => level === named);
  if (named !== undefined && !effort) {
    throw new Error(`${type}: effort "${named}" is not one of ${EFFORT_LEVELS.join(", ")}`);
  }
  return { body, model: fields.get("model") || undefined, effort };
}

// Claude Code registers each plugin agent file as pstack:<file name>, beside
// the built-in general-purpose type, which has no agent file.
export function loadAgentTypes(pluginRoot: string): Map<string, AgentDefinition> {
  const types = new Map<string, AgentDefinition>([[GENERAL_PURPOSE, { body: "" }]]);
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
