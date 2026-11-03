// The agent types the agent tool offers, read from agent files. Kept out of
// config.ts, which tools and tests import for its settings, so that only the
// extension's agent code loads Pi's package for its YAML reader.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

import { type AgentDefinition, GENERAL_PURPOSE, type Settings, USER_AGENTS_DIR } from "./config.ts";

// Claude Code 2.1.310's retry for frontmatter that is not YAML: quote each
// unquoted top-level value that holds YAML syntax, so `description: Use for
// a: b` reads as text, and turn leading tabs into spaces. Claude Code also
// keeps a `[...]` value that parses as a list; the extension reads no list
// field from a file that needs the retry, so that case is left out.
function quoteAsText(yaml: string): string {
  const lines = yaml.split("\n").map((line) => {
    const kv = /^([a-zA-Z_-]+):\s+(\S.*)$/.exec(line);
    if (!kv) return line;
    const [, key, value] = kv;
    const quoted = (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"));
    if (quoted || !/[{}[\]*&#!|>%@`]|: /.test(value)) return line;
    return `${key}: "${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
  });
  return lines.join("\n").replace(/^\t+/gm, (tabs) => "  ".repeat(tabs.length));
}

// Claude Code's YAML reader, Bun's, keeps the last value of a repeated
// top-level key, where Pi's rejects the key. Drops each earlier entry, its
// indented lines included.
function lastOfEachKey(yaml: string): string {
  const lines = yaml.split("\n");
  const keyOf = (line: string) => /^([^\s#][^:]*):(?:\s|$)/.exec(line)?.[1];
  const last = new Map(lines.map((line, i) => [keyOf(line), i]));
  let dropping = false;
  return lines
    .filter((line, i) => {
      const key = keyOf(line);
      if (key !== undefined) dropping = last.get(key) !== i;
      else if (/^\S/.test(line)) dropping = false;
      return !dropping;
    })
    .join("\n");
}

// Pi's YAML reader, then Claude Code's: first with a repeated key's last
// value, then with its retry. Frontmatter that fails all three throws.
export function frontmatter(text: string): { fields: Record<string, unknown>; body: string } {
  let parsed: ReturnType<typeof parseFrontmatter>;
  try {
    parsed = parseFrontmatter(text);
  } catch {
    // parseFrontmatter only throws on a file that opens with ---, after any byte-order mark, which trimStart drops.
    const lf = text.trimStart().replace(/\r\n?/g, "\n");
    const rewritten = (rewrite: (yaml: string) => string) =>
      parseFrontmatter(lf.replace(/^(---\n)([\s\S]*?)(\n---)/, (_, open: string, yaml: string, close: string) => open + rewrite(yaml) + close));
    try {
      parsed = rewritten(lastOfEachKey);
    } catch {
      parsed = rewritten((yaml) => quoteAsText(lastOfEachKey(yaml)));
    }
  }
  return { fields: parsed.frontmatter, body: parsed.body.trim() };
}

// A field as text, trimmed as Claude Code reads it; an empty or missing one is undefined.
function scalar(value: unknown): string | undefined {
  return value == null ? undefined : String(value).trim() || undefined;
}

function parseAgentFile(file: string, text: string): AgentDefinition {
  const { fields, body } = frontmatter(text);
  // Claude Code's `model: inherit` runs the agent on the parent's model, as no model does.
  const model = scalar(fields.model);
  return { file, description: scalar(fields.description), body, model: model !== "inherit" ? model : undefined, effort: scalar(fields.effort) };
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
