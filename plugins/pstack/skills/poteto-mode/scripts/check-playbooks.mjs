#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const BUNDLED = resolve(dirname(fileURLToPath(import.meta.url)), "../playbooks");
const CHANGE = /^ {0,3}(?:[-*]|\d+\.)\s+\*\*(?:After|Before|Replace|In)\*\*\s+"([^"]+)"/;
const CHANGE_VERB = /^ {0,3}(?:[-*]|\d+\.)\s+\*\*(?:After|Before|Replace|In)\*\*/;
const flat = (text) => text.replace(/\s+/g, " ");
// A frontmatter value as YAML reads a one-line scalar: trimmed, one pair of matching quotes removed.
const yamlScalar = (value) => value.trim().replace(/^(["'])(.*)\1$/, "$2").trim();

// Fields in project playbooks are one-line scalars, or a flow or block list of base names.
// A hash begins a YAML comment only after separation and outside a quoted scalar.
function fieldValue(line) {
  let quote = "";
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (quote === '"' && c === "\\") i++;
      else if (c === quote && quote === "'" && line[i + 1] === "'") i++;
      else if (c === quote) quote = "";
    } else if (c === "#" && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i).trim();
    else if ((c === "'" || c === '"') && /(?:^|\[|,)\s*$/.test(line.slice(0, i))) quote = c;
  }
  return line.trim();
}

function baseNames(front) {
  const field = /^extends:[ \t]*(.*)$/m.exec(front);
  if (!field) return [];
  const value = fieldValue(field[1]);
  if (value) return value.replace(/^\[(.*)\]$/, "$1").split(",").map(yamlScalar).filter(Boolean);
  const names = [];
  for (const line of front.slice(field.index + field[0].length).split("\n")) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const item = /^ *- +(.*)$/.exec(line);
    if (!item) break;
    names.push(yamlScalar(fieldValue(item[1])));
  }
  return names;
}

// Fenced examples can contain both list items and shorter, fence-looking lines.
function* proseLines(body) {
  let fence;
  for (const line of body.split("\n")) {
    const marker = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (marker && marker[1].startsWith(fence) && !marker[2].trim()) fence = undefined;
    } else if (marker && (marker[1][0] === "~" || !marker[2].includes("`"))) {
      fence = marker[1];
      yield "";
    } else yield line;
  }
}

function bundledSteps(body) {
  const steps = [];
  let current;
  let afterBlank = true;
  for (const line of proseLines(body)) {
    const start = /^(\d+[.)] +)(.*)$/.exec(line);
    if (start) {
      current = { indent: start[1].length, lines: [start[2]] };
      steps.push(current);
    } else if (current && line.trim()) {
      if (line.startsWith(" ".repeat(current.indent)) || (!afterBlank && !/^ {0,3}(?:#{1,6} |[-*+] )/.test(line))) {
        current.lines.push(line.trim());
      } else current = undefined;
    }
    afterBlank = !line.trim();
  }
  return steps.length ? steps.map((step) => flat(step.lines.join(" "))) : proseBlocks(body);
}

// A playbook without numbered steps, such as opening-a-pr, writes each step as a paragraph or a list item.
function proseBlocks(body) {
  const blocks = [];
  let current;
  for (const line of proseLines(body)) {
    const item = /^ *(?:[-*+]|\d+[.)]) +(.*)$/.exec(line);
    if (!line.trim() || /^ {0,3}#{1,6}(?: |$)/.test(line)) current = undefined;
    else if (item || !current) {
      current = [item ? item[1] : line.trim()];
      blocks.push(current);
    } else current.push(line.trim());
  }
  return blocks.map((lines) => flat(lines.join(" ")));
}

export function checkPlaybooks(root, bundled = BUNDLED) {
  const dir = join(root, ".agents/playbooks");
  if (!existsSync(dir)) return [];
  const problems = [];
  for (const name of readdirSync(dir).filter((file) => file.endsWith(".md")).sort()) {
    const path = `.agents/playbooks/${name}`;
    const text = readFileSync(join(dir, name), "utf8").replace(/^\uFEFF/, "").replaceAll("\r\n", "\n");
    // YAML allows trailing blanks on a delimiter and a closing one at the end of the file.
    const header = text.match(/^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/);
    const front = header?.[1] ?? "";
    const when = fieldValue(/^when:[ \t]*(.*)$/m.exec(front)?.[1] ?? "");
    if (!yamlScalar(when)) problems.push(`${path}: its frontmatter needs a "when:" line`);
    const bases = baseNames(front)
      .map((stem) => {
        const file = join(bundled, `${stem}.md`);
        const known = !/[\\/]/.test(stem) && existsSync(file);
        return { stem, steps: known ? bundledSteps(readFileSync(file, "utf8")) : null };
      });
    for (const base of bases) {
      if (base.steps === null) problems.push(`${path}: extends \`${base.stem}\`, which this pstack has no playbook for`);
    }
    for (const line of proseLines(text.slice(header?.[0].length ?? 0))) {
      if (CHANGE_VERB.test(line) && !CHANGE.test(line)) {
        problems.push(`${path}: a change has no straight-quoted step text to anchor on: ${line.trim().slice(0, 80)}`);
      }
      const anchor = line.match(CHANGE)?.[1];
      if (anchor && !bases.some((base) => base.steps?.some((step) => step.includes(flat(anchor))))) {
        problems.push(`${path}: "${anchor}" is not in any playbook it extends`);
      }
    }
  }
  return problems;
}

// node leaves argv[1] unresolved and may set it to a non-file (`node -e ... arg`).
function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return fileURLToPath(import.meta.url) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  const root = resolve(process.argv[2] ?? ".");
  const home = homedir();
  const directory = join(root, ".agents/playbooks");
  const homeDirectory = join(home, ".agents/playbooks");
  const atHome = root === resolve(home);
  let problems = [`${root} is not a directory`];
  if (statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
    problems = atHome ? [] : checkPlaybooks(home).map((problem) => `~/${problem}`);
    problems.push(...checkPlaybooks(root));
  }
  if (problems.length > 0) {
    console.error(problems.join("\n"));
    process.exitCode = 1;
  } else if (existsSync(directory) || existsSync(homeDirectory)) {
    console.log("Every project playbook matches this pstack's playbooks.");
  } else if (atHome) {
    console.log(`No project playbooks to check: ${directory} does not exist.`);
  } else {
    console.log(`No project playbooks to check: neither ${directory} nor ${homeDirectory} exists.`);
  }
}
