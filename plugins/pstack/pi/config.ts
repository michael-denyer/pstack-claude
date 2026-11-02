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
  const raw: unknown = JSON.parse(readFileSync(modelsFile, "utf8"));
  if (!Value.Check(modelsConfig, raw)) throw new Error(`${modelsFile} is not a pstack models file: it needs available[], efforts[] and pi.{fallback, models}.`);
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
  effort?: string;
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

function parseAgentFile(text: string): AgentDefinition {
  const { fields, body } = frontmatter(text);
  // Claude Code's `model: inherit` runs the agent on the parent's model, as no model does.
  const model = fields.get("model");
  return { body, model: model && model !== "inherit" ? model : undefined, effort: fields.get("effort") || undefined };
}

// The agent tool's effort parameter: one of models.json's levels.
export function checkEffort(effort: string, settings: Pick<Settings, "modelsFile">): string {
  const { efforts } = readModels(settings.modelsFile);
  if (!efforts.includes(effort)) throw new Error(`effort "${effort}" is not one of ${efforts.join(", ")}`);
  return effort;
}

// Claude Code registers each plugin agent file as pstack:<file name>, beside
// the built-in general-purpose type, which has no agent file, and a user agent
// file under its bare name. A user file only adds a type, never replaces one.
export function loadAgentTypes(settings: Pick<Settings, "pluginRoot" | "agentDir">): Map<string, AgentDefinition> {
  const types = new Map<string, AgentDefinition>([[GENERAL_PURPOSE, { body: "" }]]);
  const dir = join(settings.pluginRoot, "agents");
  if (existsSync(dir)) {
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".md")).sort()) {
      const type = `pstack:${basename(file, ".md")}`;
      types.set(type, parseAgentFile(readFileSync(join(dir, file), "utf8")));
    }
  }
  for (const [type, text] of userAgentFiles(join(settings.agentDir, USER_AGENTS_DIR))) {
    if (!types.has(type)) types.set(type, parseAgentFile(text));
  }
  return types;
}

// Each readable .md file in the user's folder, by bare name. A name with a colon,
// which Claude Code keeps for plugin agents, an entry that is not a readable file,
// and a folder that cannot be listed are skipped, so the user's folder never
// breaks the plugin's agent types.
function userAgentFiles(dir: string): [string, string][] {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".md") && !f.includes(":")).sort();
  } catch {
    return [];
  }
  return files.flatMap((file): [string, string][] => {
    const path = join(dir, file);
    try {
      return statSync(path).isFile() ? [[basename(file, ".md"), readFileSync(path, "utf8")]] : [];
    } catch {
      return [];
    }
  });
}
