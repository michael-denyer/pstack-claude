import type { SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";

// Pi expands "/skill:name args" and "/template args" only inside sendUserMessage, and its package exports
// none of the code that does it. This is that code from pi 1.4.0 (AgentSession._expandSkillCommand,
// dist/core/prompt-templates.js, and dist/utils/frontmatter.js), reading the files pi.getCommands() names,
// for text the extension sends as a custom message. tests/pi/slash.test.mjs checks it against the installed pi.

export function stripFrontmatter(content: string): string {
  const normalized = content.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!normalized.startsWith("---")) return normalized;
  const endIndex = normalized.indexOf("\n---", 3);
  return endIndex === -1 ? normalized : normalized.slice(endIndex + 4).trim();
}

// Splits on whitespace outside quotes; a quote ends at the next quote of the same kind, and "" is an argument.
export function parseCommandArgs(argsString: string): string[] {
  const args: string[] = [];
  let current = "";
  let hasToken = false;
  let inQuote: string | null = null;
  for (const char of argsString) {
    if (inQuote) {
      if (char === inQuote) inQuote = null;
      else current += char;
    } else if (char === '"' || char === "'") {
      inQuote = char;
      hasToken = true;
    } else if (/\s/.test(char)) {
      if (hasToken) {
        args.push(current);
        current = "";
        hasToken = false;
      }
    } else {
      current += char;
      hasToken = true;
    }
  }
  if (hasToken) args.push(current);
  return args;
}

// $1, $@, $ARGUMENTS, ${N:-default}, ${@:-default}, ${@:N} and ${@:N:L}. A value is not substituted again.
export function substituteArgs(content: string, args: string[]): string {
  const allArgs = args.join(" ");
  return content.replace(
    /\$\{(\d+|ARGUMENTS|@):-([^}]*)\}|\$\{@:(\d+)(?::(\d+))?\}|\$(ARGUMENTS|@|\d+)/g,
    (_match, defaultTarget, defaultValue, sliceStart, sliceLength, simple) => {
      if (defaultTarget) {
        const value = defaultTarget === "@" || defaultTarget === "ARGUMENTS" ? allArgs : args[parseInt(defaultTarget, 10) - 1];
        return value ? value : defaultValue;
      }
      if (sliceStart) {
        const start = Math.max(0, parseInt(sliceStart, 10) - 1);
        return (sliceLength ? args.slice(start, start + parseInt(sliceLength, 10)) : args.slice(start)).join(" ");
      }
      if (simple === "ARGUMENTS" || simple === "@") return allArgs;
      return args[parseInt(simple, 10) - 1] ?? "";
    },
  );
}

function expandSkillCommand(commands: readonly SlashCommandInfo[], text: string): string {
  if (!text.startsWith("/skill:")) return text;
  const spaceIndex = text.indexOf(" ");
  const name = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
  const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1).trim();
  const skill = commands.find((c) => c.source === "skill" && c.name === name);
  if (!skill) return text;
  const { path, baseDir } = skill.sourceInfo;
  const body = stripFrontmatter(readFileSync(path, "utf8")).trim();
  const block = `<skill name="${name.slice("skill:".length)}" location="${path}">\nReferences are relative to ${baseDir}.\n\n${body}\n</skill>`;
  return args ? `${block}\n\n${args}` : block;
}

function expandPromptTemplate(commands: readonly SlashCommandInfo[], text: string): string {
  const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(text);
  const template = match && commands.find((c) => c.source === "prompt" && c.name === match[1]);
  if (!template) return text;
  return substituteArgs(stripFrontmatter(readFileSync(template.sourceInfo.path, "utf8")), parseCommandArgs(match[2] ?? ""));
}

// The text a user message with this text would carry. A name pi has no skill or template for stays as written,
// and so does an extension command: pi runs one only from a user message, and the agent must not run one as the
// user. Throws when a command's file cannot be read, where pi reports the error and sends the text as written.
export function expandSlash(commands: readonly SlashCommandInfo[], text: string): string {
  const spaceIndex = text.indexOf(" ");
  const name = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
  if (text.startsWith("/") && commands.some((c) => c.source === "extension" && c.name === name)) return text;
  return expandPromptTemplate(commands, expandSkillCommand(commands, text));
}
