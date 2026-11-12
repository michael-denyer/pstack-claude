#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const BUNDLED = resolve(dirname(fileURLToPath(import.meta.url)), "../playbooks");
const CHANGE = /^\s*(?:[-*]|\d+\.)\s+\*\*(?:After|Before|Replace|In)\*\*\s+"([^"]+)"/;
const CHANGE_VERB = /^\s*(?:[-*]|\d+\.)\s+\*\*(?:After|Before|Replace|In)\*\*/;
const flat = (text) => text.replace(/\s+/g, " ");
// A frontmatter value as YAML reads a one-line scalar: trimmed, one pair of matching quotes removed.
const yamlScalar = (value) => value.trim().replace(/^(["'])(.*)\1$/, "$2").trim();

export function checkPlaybooks(root, bundled = BUNDLED) {
  const dir = join(root, ".agents/playbooks");
  if (!existsSync(dir)) return [];
  const problems = [];
  for (const name of readdirSync(dir).filter((file) => file.endsWith(".md")).sort()) {
    const path = `.agents/playbooks/${name}`;
    const text = readFileSync(join(dir, name), "utf8").replace(/^\uFEFF/, "").replaceAll("\r\n", "\n");
    // YAML allows trailing blanks on a delimiter and a closing one at the end of the file.
    const front = text.match(/^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/)?.[1] ?? "";
    const field = (fieldName) => front.match(new RegExp(`^${fieldName}:[ \\t]*(.*)$`, "m"))?.[1].trim() ?? "";
    if (!yamlScalar(field("when"))) problems.push(`${path}: its frontmatter needs a "when:" line`);
    const bases = field("extends")
      .replace(/^\[(.*)\]$/, "$1")
      .split(",")
      .map(yamlScalar)
      .filter(Boolean)
      .map((stem) => {
        const file = join(bundled, `${stem}.md`);
        const known = !/[\\/]/.test(stem) && existsSync(file);
        return { stem, text: known ? readFileSync(file, "utf8") : null };
      });
    for (const base of bases) {
      if (base.text === null) problems.push(`${path}: extends \`${base.stem}\`, which this pstack has no playbook for`);
    }
    for (const line of text.split("\n")) {
      if (CHANGE_VERB.test(line) && !CHANGE.test(line)) {
        problems.push(`${path}: a change has no straight-quoted step text to anchor on: ${line.trim().slice(0, 80)}`);
      }
      const anchor = line.match(CHANGE)?.[1];
      if (anchor && !bases.some((base) => base.text && flat(base.text).includes(flat(anchor)))) {
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
