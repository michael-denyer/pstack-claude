import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { readSheet, type Settings } from "./config.ts";

export const MANDATE_SECTION = "pstack-session-start";
export const SHEET_SECTION = "pstack-models";
const FILE_TOOLS = new Set(["read", "edit", "write"]);

interface PathSkill {
  name: string;
  file: string;
  patterns: RegExp[];
}

export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (glob.startsWith("**/", i)) {
      re += "(?:.*/)?";
      i += 2;
    } else if (glob.startsWith("**", i)) {
      re += ".*";
      i += 1;
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

function parsePaths(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.map(String);
  } catch {}
  return value.split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
}

// Skills whose frontmatter names `paths:` globs, the files that should load them.
export function pathSkills(pluginRoot: string): PathSkill[] {
  const dir = join(pluginRoot, "skills");
  if (!existsSync(dir)) return [];
  const skills: PathSkill[] = [];
  for (const name of readdirSync(dir).sort()) {
    const file = join(dir, name, "SKILL.md");
    if (!existsSync(file)) continue;
    const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(readFileSync(file, "utf8"))?.[1] ?? "";
    const line = /^paths:\s*(.+)$/m.exec(front)?.[1];
    if (line) skills.push({ name, file, patterns: parsePaths(line).map(globToRegExp) });
  }
  return skills;
}

export function registerLifecycle(pi: ExtensionAPI, settings: Settings, cleanup: () => Promise<void>): void {
  const mandateFile = join(settings.pluginRoot, "hooks", "session-start-context.md");

  // Claude Code runs the session hook and loads the sheet through a CLAUDE.md
  // include; Pi has neither, so both ride as system prompt sections, set again
  // on every agent start so compaction cannot drop them.
  // A child gets the sheet, as a Claude Code subagent sees CLAUDE.md, but not
  // the mandate: SessionStart does not run for subagents.
  pi.on("before_agent_start", (event) => {
    const sheet = readSheet(settings.agentDir);
    const sections = event.systemPromptOptions.sections;
    if (settings.depth === 0 && !sheet?.hookOff) sections[MANDATE_SECTION] = readFileSync(mandateFile, "utf8");
    if (sheet) sections[SHEET_SECTION] = sheet.text;
  });

  pi.on("session_shutdown", async () => {
    await cleanup();
  });

  const skills = pathSkills(settings.pluginRoot);
  const noted = new Set<string>();
  pi.on("tool_result", (event, ctx) => {
    if (!FILE_TOOLS.has(event.toolName) || event.isError) return;
    const raw = event.input.path;
    if (typeof raw !== "string") return;
    const rel = relative(ctx.cwd, isAbsolute(raw) ? raw : resolve(ctx.cwd, raw)).split("\\").join("/");
    const skill = skills.find((s) => !noted.has(s.name) && s.patterns.some((p) => p.test(rel)));
    if (!skill) return;
    noted.add(skill.name);
    const note = `pstack: ${rel} matches the ${skill.name} skill's paths. Load that skill now (read ${skill.file}) and follow it while you work on this file.`;
    return {
      content: [...event.content, { type: "text", text: note }],
      structuredContent: event.structuredContent,
    };
  });
}
