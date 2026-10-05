import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, matchesGlob, relative, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { frontmatter, type Settings } from "./config.ts";

const FILE_TOOLS = new Set(["read", "edit", "write"]);

interface PathSkill {
  name: string;
  file: string;
  globs: string[];
}

function parsePaths(file: string, line: string): string[] {
  const globs: unknown = JSON.parse(line);
  if (Array.isArray(globs) && globs.every((g): g is string => typeof g === "string")) return globs;
  throw new Error(`${file}: paths must be a JSON array of globs`);
}

// Skills whose frontmatter names `paths:` globs, the files that should load them.
function pathSkills(pluginRoot: string): PathSkill[] {
  const dir = join(pluginRoot, "skills");
  if (!existsSync(dir)) return [];
  const skills: PathSkill[] = [];
  for (const name of readdirSync(dir).sort()) {
    const file = join(dir, name, "SKILL.md");
    if (!existsSync(file)) continue;
    const line = frontmatter(readFileSync(file, "utf8")).fields.get("paths");
    if (line) skills.push({ name, file, globs: parsePaths(file, line) });
  }
  return skills;
}

// Claude Code loads a skill with `paths:` when a matching file is touched; Pi
// has no such hook, so the first matching tool result carries a note instead.
export function registerPathSkills(pi: ExtensionAPI, settings: Settings): void {
  const skills = pathSkills(settings.pluginRoot);
  const noted = new Set<string>();
  pi.on("tool_result", (event, ctx) => {
    if (!FILE_TOOLS.has(event.toolName) || event.isError) return;
    const raw = event.input.path;
    if (typeof raw !== "string") return;
    const rel = relative(ctx.cwd, isAbsolute(raw) ? raw : resolve(ctx.cwd, raw)).split("\\").join("/");
    const skill = skills.find((s) => !noted.has(s.name) && s.globs.some((g) => matchesGlob(rel, g)));
    if (!skill) return;
    noted.add(skill.name);
    const note = `pstack: ${rel} matches the ${skill.name} skill's paths. Load that skill now (read ${skill.file}) and follow it while you work on this file.`;
    return {
      content: [...event.content, { type: "text", text: note }],
      structuredContent: event.structuredContent,
    };
  });
}
