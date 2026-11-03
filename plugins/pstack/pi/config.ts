import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

const PARENT_MODEL_ALIASES = ["inherit-parent", "auto"];

// A parent passes it to each agent it starts, so the agent knows its depth.
export const DEPTH_FLAG = "pstack-depth";
// Under agentDir, holds each session's agent sessions and prompts. The worktree
// audit scans it by this name, so a rename must reach that script too.
export const PSTACK_STATE_DIR = "pstack";
// Under agentDir, beside the pstack-models.md sheet, holds the user's agent
// files. Not Pi's `agents`, which other subagent extensions read with their
// own frontmatter.
export const USER_AGENTS_DIR = "pstack-agents";

export interface Settings {
  pluginRoot: string;
  modelsFile: string;
  agentDir: string;
  pi: { command: string; args: string[] };
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
  // Leaves ask_user_question to another extension: Pi refuses to start when two
  // extensions register the same tool name.
  askToolOff: boolean;
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
  return {
    text,
    hookOff: lines.some((l) => l === "session hook: off"),
    askToolOff: lines.some((l) => l === "pi ask tool: off"),
    piModels,
  };
}

export function readSheet(agentDir: string): Sheet | undefined {
  let bytes: Buffer;
  try {
    bytes = readFileSync(join(agentDir, "pstack-models.md"));
  } catch {
    // An absent or unreadable sheet leaves the defaults in place, as the session hooks do.
    return undefined;
  }
  // Windows PowerShell 5.1's `>` writes UTF-16 LE with a byte-order mark. A
  // sheet that is not valid UTF-16 LE counts as absent, as in the session hooks.
  if (bytes[0] !== 0xff || bytes[1] !== 0xfe) return parseSheet(bytes.toString("utf8"));
  try {
    // ignoreBOM keeps the byte-order mark, so parseSheet drops exactly one, as for
    // UTF-8. A Node built without ICU throws here, and the sheet counts as absent.
    return parseSheet(new TextDecoder("utf-16le", { fatal: true, ignoreBOM: true }).decode(bytes));
  } catch {
    return undefined;
  }
}

// The parts of models.json the extension reads; the generator checks the rest.
const modelsConfig = Type.Object({
  available: Type.Array(Type.String()),
  efforts: Type.Array(Type.String()),
  pi: Type.Object({ fallback: Type.String(), models: Type.Record(Type.String(), Type.Record(Type.String(), Type.String())) }),
});

function readModels(modelsFile: string): Static<typeof modelsConfig> {
  const text = readFileSync(modelsFile, "utf8");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`${modelsFile} is not valid JSON: ${(e as Error).message}`);
  }
  if (!Value.Check(modelsConfig, raw)) throw new Error(`${modelsFile} is not a pstack models file: it needs available[], efforts[] and pi.{fallback, models}.`);
  return raw;
}

// A model or effort value that is not valid, unlike a models.json that cannot be read.
export class InvalidValueError extends Error {}

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
    throw new InvalidValueError(`Unknown model "${requested}". Valid values: ${valid.join(", ")}.`);
  }
  // Family names follow the provider the session is signed in to, so a ChatGPT
  // subscription gets OpenAI models without any configuration.
  const provider = parentModel?.split("/")[0] ?? "";
  const table = models.pi.models[Object.hasOwn(models.pi.models, provider) ? provider : models.pi.fallback];
  const id = sheet?.piModels.get(requested) ?? table[requested];
  if (!id) {
    throw new InvalidValueError(`No Pi model mapped for "${requested}": add a "pi models: ${requested}=<provider>/<id>" line to the override sheet.`);
  }
  return id;
}

export const GENERAL_PURPOSE = "general-purpose";

export interface AgentDefinition {
  // The agent file it was read from; general-purpose has none.
  file?: string;
  // When to use it, as the agent tool's type list shows it.
  description?: string;
  body: string;
  model?: string;
  effort?: string;
}

export function frontmatter(text: string): { fields: Map<string, string>; body: string } {
  // Windows editors often save a byte-order mark before the frontmatter.
  const m = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  const fields = new Map<string, string>();
  const lines = (m?.[1] ?? "").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([\w-]+):\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    const value = kv[2].trim();
    // A YAML block scalar, as Claude Code agent files often write description:,
    // is the indented lines after its | or >.
    const block = /^([|>])[+-]?[1-9]?$/.exec(value);
    if (!block) {
      // YAML's quotes are not part of the value, so "high" and 'high' read as high.
      fields.set(kv[1], value.replace(/^"([^"\\]*)"$|^'([^']*)'$/, "$1$2"));
      continue;
    }
    const held: string[] = [];
    while (i + 1 < lines.length && /^(\s|$)/.test(lines[i + 1])) held.push(lines[++i]);
    const indent = Math.min(...held.filter((l) => l.trim()).map((l) => l.search(/\S/)));
    const joined = held.map((l) => l.slice(indent)).join("\n").trim();
    // > folds a line break into a space, and a run of n+1 breaks into n.
    fields.set(kv[1], block[1] === ">" ? joined.replace(/\n(\n*)/g, (_, more: string) => more || " ") : joined);
  }
  return { fields, body: (m?.[2] ?? text).trim() };
}

function parseAgentFile(file: string, text: string): AgentDefinition {
  const { fields, body } = frontmatter(text);
  // Claude Code's `model: inherit` runs the agent on the parent's model, as no model does.
  const model = fields.get("model");
  return { file, description: fields.get("description") || undefined, body, model: model && model !== "inherit" ? model : undefined, effort: fields.get("effort") || undefined };
}

// The agent tool's effort parameter: one of models.json's levels.
export function checkEffort(effort: string, settings: Pick<Settings, "modelsFile">): string {
  const { efforts } = readModels(settings.modelsFile);
  if (!efforts.includes(effort)) throw new InvalidValueError(`effort "${effort}" is not one of ${efforts.join(", ")}`);
  return effort;
}

// Claude Code registers each plugin agent file as pstack:<file name>, beside
// the built-in general-purpose type, which has no agent file, and a user agent
// file under its bare name. A user file only adds a type, never replaces one.
export function loadAgentTypes(settings: Pick<Settings, "pluginRoot" | "agentDir">): Map<string, AgentDefinition> {
  // The built-in type's description is Claude Code's own.
  const types = new Map<string, AgentDefinition>([
    [GENERAL_PURPOSE, { body: "", description: "General-purpose agent for researching complex questions, searching for code, and executing multi-step tasks. When you are searching for a keyword or file and are not confident that you will find the right match in the first few tries use this agent to perform the search for you." }],
  ]);
  const dir = join(settings.pluginRoot, "agents");
  if (existsSync(dir)) {
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".md")).sort()) {
      const type = `pstack:${basename(file, ".md")}`;
      const path = join(dir, file);
      types.set(type, parseAgentFile(path, readFileSync(path, "utf8")));
    }
  }
  for (const [type, def] of userAgentFiles(join(settings.agentDir, USER_AGENTS_DIR))) {
    if (!types.has(type)) types.set(type, def);
  }
  return types;
}

// Each readable .md file in the user's folder, by bare name. A hidden file, such
// as a macOS ._ sidecar, a name with a colon, which Claude Code keeps for plugin
// agents, an entry that is not a readable file, and a folder that cannot be
// listed are skipped, so the user's folder never breaks the plugin's agent types.
function userAgentFiles(dir: string): [string, AgentDefinition][] {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".md") && !f.startsWith(".") && !f.includes(":")).sort();
  } catch {
    return [];
  }
  return files.flatMap((file): [string, AgentDefinition][] => {
    const path = join(dir, file);
    try {
      return statSync(path).isFile() ? [[basename(file, ".md"), parseAgentFile(path, readFileSync(path, "utf8"))]] : [];
    } catch {
      return [];
    }
  });
}
