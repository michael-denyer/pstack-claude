import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const skillsDir = join(root, "skills");
const agentsDir = join(root, "agents");

function readFrontmatter(path) {
  const text = readFileSync(path, "utf8");
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) throw new Error(`Missing frontmatter: ${path}`);
  return { metadata: Bun.YAML.parse(match[1]), body: text.slice(match[0].length) };
}

function readSkills() {
  return readdirSync(skillsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => {
    const path = join(skillsDir, entry.name, "SKILL.md");
    const { metadata, body } = readFrontmatter(path);
    return { id: `pstack-${entry.name}`, name: metadata.name, description: metadata.description, path, content: body };
  });
}

// Each bundled agent keeps its Claude Code name, such as pstack:poteto-agent,
// so a skill's subagent_type names an OpenCode agent as written.
function readAgents() {
  return readdirSync(agentsDir).filter((name) => name.endsWith(".md")).map((name) => {
    const { metadata, body } = readFrontmatter(join(agentsDir, name));
    return { id: `pstack:${metadata.name}`, description: metadata.description, system: body };
  });
}

function hookEnabled() {
  const config = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  try {
    const bytes = readFileSync(join(config, "opencode", "pstack-models.md"));
    const text = bytes[0] === 0xff && bytes[1] === 0xfe
      ? new TextDecoder("utf-16le", { fatal: true, ignoreBOM: true }).decode(bytes)
      : bytes.toString("utf8");
    return !text.replace(/^\uFEFF/, "").split(/\r?\n/).includes("session hook: off");
  } catch {
    return true;
  }
}

export default {
  id: "pstack",
  async setup(ctx) {
    const skills = readSkills();
    const mandate = readFileSync(join(root, "hooks", "session-start-opencode.md"), "utf8");
    await ctx.skill.transform((editor) => {
      for (const skill of skills) if (!editor.get(skill.id)) editor.add(skill);
    });
    await ctx.session.hook("context", async (event) => {
      const session = await ctx.session.get({ sessionID: event.sessionID });
      if (session.parentID || !hookEnabled()) return;
      const installed = new Map((await ctx.skill.list()).data.map((skill) => [skill.id, skill.path]));
      if (skills.some((skill) => installed.get(skill.id) !== skill.path)) return;
      event.system.push({ type: "text", text: mandate });
    });
    // Last, so a failure here cannot cost the routing hook. The agent editor has
    // no add: update creates an agent it does not have yet, as a primary agent
    // with allow-all permissions. OpenCode applies opencode.json after plugins,
    // so a user's fields for the same ID override these. An agent another plugin
    // registered first stays as it is. question is denied, as for OpenCode's own
    // general subagent: a Claude Code subagent cannot ask the user either.
    const agents = readAgents();
    await ctx.agent?.transform((editor) => {
      for (const agent of agents) {
        if (editor.get(agent.id)) continue;
        editor.update(agent.id, (entry) => {
          entry.mode = "subagent";
          entry.description = agent.description;
          entry.system = agent.system;
          entry.permissions.push({ action: "question", resource: "*", effect: "deny" });
        });
      }
    });
  },
};
