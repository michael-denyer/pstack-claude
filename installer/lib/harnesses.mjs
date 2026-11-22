import { join } from "node:path";

const REPO = "michael-denyer/pstack-claude";
const SKILLS_LABEL =
  "~/.agents/skills (Gemini CLI, Prime Agent, DeepSeek Harness, skills-only Codex)";

const run = (...argv) => ({ kind: "run", argv });

// One row per harness, copied from the README install recipes. `steps` is a
// list of tagged steps: run (spawn the CLI), copy (a tree), link-skills (one
// symlink per skill) or manual (in-session instructions, nothing to run).
export const HARNESSES = [
  {
    id: "claude",
    name: "Claude Code",
    bin: "claude",
    needsBundle: false,
    steps: () => [
      run("claude", "plugin", "marketplace", "add", REPO),
      run("claude", "plugin", "install", "pstack@pstack-claude"),
    ],
  },
  {
    id: "codex",
    name: "Codex",
    bin: "codex",
    needsBundle: false,
    steps: () => [
      run("codex", "plugin", "marketplace", "add", REPO),
      run("codex", "plugin", "add", "pstack@pstack-claude"),
    ],
  },
  {
    id: "pi",
    name: "Pi",
    bin: "pi",
    needsBundle: false,
    steps: () => [run("pi", "install", `git:github.com/${REPO}`)],
  },
  {
    id: "copilot",
    name: "GitHub Copilot",
    bin: "copilot",
    needsBundle: false,
    steps: () => [
      run("copilot", "plugin", "marketplace", "add", REPO),
      run("copilot", "plugin", "install", "pstack@pstack-claude"),
    ],
  },
  {
    id: "muse",
    name: "Muse",
    bin: "muse",
    needsBundle: true,
    steps: ({ pluginDir }) => [
      run("muse", "plugins", "install", pluginDir),
      run("muse", "plugins", "approve", "pstack"),
    ],
  },
  {
    id: "omp",
    name: "OMP",
    bin: "omp",
    needsBundle: false,
    steps: () => [
      run("omp", "plugin", "marketplace", "add", REPO),
      run("omp", "plugin", "install", "--scope", "user", "pstack@pstack-claude"),
    ],
  },
  {
    id: "kimi",
    name: "Kimi Code CLI",
    bin: "kimi",
    needsBundle: false,
    steps: () => [
      {
        kind: "manual",
        lines: [
          "Close other Kimi sessions, start a fresh Kimi Code CLI session, then run:",
          `/plugins install https://github.com/${REPO}`,
          "/reload",
        ],
      },
    ],
  },
  {
    id: "grok",
    name: "Grok Build",
    bin: "grok",
    needsBundle: true,
    steps: ({ pluginDir }) => [
      run("grok", "plugin", "install", pluginDir, "--trust"),
      run("grok", "plugin", "enable", "pstack"),
    ],
  },
  {
    id: "minimax",
    name: "MiniMax Code",
    bin: "mcode",
    needsBundle: true,
    steps: ({ home, env, pluginDir }) => [
      {
        kind: "copy",
        from: pluginDir,
        to: join(env.MINIMAX_DATA_DIR || join(home, ".minimax"), "plugins", "pstack"),
      },
    ],
  },
  {
    id: "opencode",
    name: "OpenCode 2",
    bin: "opencode",
    needsBundle: false,
    steps: () => [run("opencode", "plugin", "add", `github:${REPO}#main`)],
  },
  {
    id: "agy",
    name: "Antigravity (agy)",
    bin: "agy",
    needsBundle: true,
    steps: ({ pluginDir }) => [run("agy", "plugin", "install", pluginDir)],
  },
  {
    id: "skills",
    name: SKILLS_LABEL,
    bin: null,
    needsBundle: true,
    steps: ({ home, pluginDir }) => [
      {
        kind: "link-skills",
        from: join(pluginDir, "skills"),
        to: join(home, ".agents", "skills"),
      },
    ],
  },
];
