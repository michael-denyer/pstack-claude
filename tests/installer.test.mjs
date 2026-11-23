// open-pstack installs pstack into the harnesses on PATH using each
// README recipe. The registry is pinned to the README so neither side can
// drift, and the CLI runs end to end against stub harness binaries in a
// throwaway HOME.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { which } from "../installer/lib/detect.mjs";
import { HARNESSES } from "../installer/lib/harnesses.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const cli = join(repoRoot, "installer/bin/open-pstack.mjs");
const readme = readFileSync(join(repoRoot, "README.md"), "utf8");
const PLUGIN_DIR = "<pluginDir>";

// README -> argv lists -----------------------------------------------------

function tokenize(line) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (let m; (m = re.exec(line)); ) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

const isPluginPath = (t) => t === "./plugins/pstack" || t === "$PWD/plugins/pstack";

// Fenced commands under each harness's <details> in the README Install section.
function readmeCommands() {
  const install = readme.slice(readme.indexOf("\n## Install"), readme.indexOf("\n### Configure"));
  const sections = {};
  for (const block of install.split("<details>").slice(1)) {
    const name = block.match(/<summary><strong>(.*?)<\/strong>/)[1];
    const lines = [];
    for (const fence of block.matchAll(/```(?:shell|text|bash)\n([\s\S]*?)```/g)) {
      lines.push(...fence[1].split("\n").filter(Boolean));
    }
    sections[name] = lines;
  }
  return sections;
}

const sections = readmeCommands();

const ctx = { home: "/home/u", env: {}, platform: "linux", pluginDir: PLUGIN_DIR };

describe("registry matches the README recipes", () => {
  const withBin = HARNESSES.filter((h) => h.bin && h.id !== "minimax" && h.id !== "kimi");
  for (const harness of withBin) {
    test(`${harness.id} runs the README commands`, () => {
      // Claude Code's README uses the in-session /plugin form of the same commands.
      const readmeArgv = sections[harness.name]
        .map((line) => tokenize(line.replace(/^\/plugin /, "claude plugin ")))
        .filter(([bin, , sub]) => bin === harness.bin && !["check", "update"].includes(sub))
        .map((argv) => argv.map((t) => (isPluginPath(t) ? PLUGIN_DIR : t)));
      const registryArgv = harness
        .steps(ctx)
        .filter((s) => s.kind === "run")
        .map((s) => s.argv);
      expect(registryArgv.length).toBeGreaterThan(0);
      expect(registryArgv).toEqual(readmeArgv);
    });
  }

  test("kimi prints the README in-session commands", () => {
    const kimi = HARNESSES.find((h) => h.id === "kimi");
    const [step] = kimi.steps(ctx);
    expect(step.kind).toBe("manual");
    const slash = sections["Kimi Code CLI"].filter((l) => l.startsWith("/"));
    expect(slash.length).toBe(2);
    expect(step.lines.filter((l) => l.startsWith("/"))).toEqual(slash);
  });

  test("minimax copies the plugin where the README does", () => {
    const minimax = HARNESSES.find((h) => h.id === "minimax");
    const copy = readme.match(/cp -R plugins\/pstack "\$\{MINIMAX_DATA_DIR:-\$HOME\/\.minimax\}\/plugins\/pstack"/);
    expect(copy).not.toBeNull();
    const [step] = minimax.steps({ ...ctx, env: {} });
    expect(step).toEqual({ kind: "copy", from: PLUGIN_DIR, to: join("/home/u", ".minimax", "plugins", "pstack") });
    const [moved] = minimax.steps({ ...ctx, env: { MINIMAX_DATA_DIR: "/data" } });
    expect(moved.to).toBe(join("/data", "plugins", "pstack"));
  });

  test("skills links each skill dir into ~/.agents/skills", () => {
    expect(readme).toContain("mkdir -p ~/.agents/skills");
    const skills = HARNESSES.find((h) => h.id === "skills");
    expect(skills.bin).toBeNull();
    expect(skills.steps({ ...ctx, pluginDir: "/p" })).toEqual([
      { kind: "link-skills", from: join("/p", "skills"), to: join("/home/u", ".agents", "skills") },
    ]);
  });

  test("every harness with a binary has a README section", () => {
    for (const h of HARNESSES.filter((h) => h.bin)) expect(sections[h.name]).toBeDefined();
  });
});

// CLI end to end -----------------------------------------------------------

const onWindows = process.platform === "win32";
const run = (name, fn) => test(name, fn, 30000);

describe("detection", () => {
  test("on win32 a .cmd shim wins over the extensionless sh shim", () => {
    const dir = mkdtempSync(join(tmpdir(), "open-pstack-which-"));
    writeFileSync(join(dir, "claude"), "#!/bin/sh\n");
    writeFileSync(join(dir, "claude.cmd"), "@echo off\n");
    const env = { PATH: dir, PATHEXT: ".exe;.cmd" };
    expect(which("claude", { env, platform: "win32" })).toBe(join(dir, "claude.cmd"));
  });
});

function nodePath() {
  const name = onWindows ? "node.exe" : "node";
  for (const dir of (process.env.PATH ?? process.env.Path ?? "").split(delimiter)) {
    if (existsSync(join(dir, name))) return join(dir, name);
  }
  throw new Error("node not on PATH");
}

// The environment a user's shell gives the CLI. On Windows, homedir() reads
// USERPROFILE, and a .cmd shim launches through ComSpec, which needs SystemRoot.
function userEnv(home, extra) {
  const windows = onWindows
    ? { USERPROFILE: home, ComSpec: process.env.ComSpec, SystemRoot: process.env.SystemRoot, PATHEXT: process.env.PATHEXT }
    : {};
  return { HOME: home, ...windows, ...extra };
}

// Each stub records its argv as one JSON line and exits with its code. On
// Windows it is a .cmd shim, as npm installs, so the CLI launches it through cmd.exe.
function writeStubs(root, bin, log, exitCodes) {
  const logger = join(root, "log-call.mjs");
  writeFileSync(
    logger,
    `import { appendFileSync } from "node:fs";\n` +
      `const [code, ...argv] = process.argv.slice(2);\n` +
      `appendFileSync(${JSON.stringify(log)}, JSON.stringify(argv) + "\\n");\n` +
      `process.exit(Number(code));\n`,
  );
  const node = nodePath();
  for (const name of ["claude", "codex", "pi", "copilot", "muse", "omp", "kimi", "grok", "mcode", "opencode", "agy"]) {
    const code = exitCodes[name] ?? 0;
    if (onWindows) {
      writeFileSync(join(bin, `${name}.cmd`), `@"${node}" "${logger}" ${code} ${name} %*\r\n@exit /b %ERRORLEVEL%\r\n`);
    } else {
      writeFileSync(join(bin, name), `#!/bin/sh\nexec "${node}" "${logger}" ${code} ${name} "$@"\n`, { mode: 0o755 });
    }
  }
}

// The data dir name holds a space, &, and ^, so a staged path reaches a .cmd
// shim only if each argument is quoted for cmd.exe. A lone % is left alone by
// cmd.exe; a defined %NAME% pair is not covered (#526).
function sandbox(exitCodes = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "open-pstack-")));
  const home = join(root, "home");
  const xdg = join(root, "x d&g^100%");
  const minimax = join(root, "minimax");
  const bin = join(root, "bin");
  const log = join(root, "calls.log");
  for (const dir of [home, xdg, bin]) mkdirSync(dir);
  writeFileSync(log, "");
  writeStubs(root, bin, log, exitCodes);
  const env = userEnv(home, {
    PATH: [bin, dirname(nodePath())].join(delimiter),
    XDG_DATA_HOME: xdg,
    MINIMAX_DATA_DIR: minimax,
  });
  const open = (...args) => {
    const r = spawnSync(nodePath(), [cli, ...args], { env, encoding: "utf8", input: "" });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  const argvs = () => readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const calls = () => argvs().map((argv) => argv.join(" "));
  return { root, home, xdg, minimax, open, argvs, calls, staged: join(xdg, "open-pstack", "pstack") };
}

describe("open-pstack CLI", () => {
  run("--yes installs into every detected harness", () => {
    const s = sandbox();
    const r = s.open("--yes");
    expect(r.code).toBe(0);
    const repo = "michael-denyer/pstack-claude";
    expect(s.calls()).toEqual([
      `claude plugin marketplace add ${repo}`,
      "claude plugin install pstack@pstack-claude",
      `codex plugin marketplace add ${repo}`,
      "codex plugin add pstack@pstack-claude",
      `pi install git:github.com/${repo}`,
      `copilot plugin marketplace add ${repo}`,
      "copilot plugin install pstack@pstack-claude",
      `muse plugins install ${s.staged}`,
      "muse plugins approve pstack",
      `omp plugin marketplace add ${repo}`,
      "omp plugin install --scope user pstack@pstack-claude",
      `grok plugin install ${s.staged} --trust`,
      "grok plugin enable pstack",
      `opencode plugin add github:${repo}#main`,
      `agy plugin install ${s.staged}`,
    ]);
    expect(r.out).toContain("kimi");
    expect(existsSync(join(s.staged, ".claude-plugin", "plugin.json"))).toBe(true);
    expect(existsSync(join(s.minimax, "plugins", "pstack", ".claude-plugin", "plugin.json"))).toBe(true);
    expect(existsSync(join(s.home, ".agents"))).toBe(false);
  });

  run("a harness gets the staged path as one argument, unchanged", () => {
    const s = sandbox();
    const r = s.open("--only", "muse");
    expect(r.code).toBe(0);
    expect(s.argvs()).toEqual([
      ["muse", "plugins", "install", s.staged],
      ["muse", "plugins", "approve", "pstack"],
    ]);
  });

  run("--only skills links every skill into ~/.agents/skills", () => {
    const s = sandbox();
    const r = s.open("--only", "skills");
    expect(r.code).toBe(0);
    const skills = readdirSync(join(s.staged, "skills"));
    expect(skills).toContain("poteto-mode");
    for (const skill of skills) {
      expect(realpathSync(join(s.home, ".agents", "skills", skill))).toBe(
        realpathSync(join(s.staged, "skills", skill)),
      );
    }
  });

  run("a rerun converges to the same state", () => {
    const s = sandbox();
    const everything = ["--only", "claude,muse,minimax,skills"];
    s.open(...everything);
    const before = readdirSync(join(s.home, ".agents", "skills")).sort();
    const r = s.open(...everything);
    expect(r.code).toBe(0);
    expect(r.err).toBe("");
    expect(readdirSync(join(s.home, ".agents", "skills")).sort()).toEqual(before);
    expect(readdirSync(join(s.xdg, "open-pstack"))).toEqual(["pstack"]);
    expect(existsSync(join(s.staged, "skills", "poteto-mode", "SKILL.md"))).toBe(true);
    expect(r.out).toMatch(/minimax\s+skipped/);
    expect(r.out).toMatch(/skills\s+skipped/);
  });

  run("one failing harness does not stop the others and sets exit 1", () => {
    const s = sandbox({ claude: 3 });
    const r = s.open("--yes");
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/claude\s+failed \(exit 3\)/);
    expect(s.calls()).not.toContain("claude plugin install pstack@pstack-claude");
    expect(s.calls()).toContain("pi install git:github.com/michael-denyer/pstack-claude");
    expect(existsSync(join(s.minimax, "plugins", "pstack", ".claude-plugin", "plugin.json"))).toBe(true);
  });

  run("--only installs just the named harnesses", () => {
    const s = sandbox();
    const r = s.open("--only", "pi");
    expect(r.code).toBe(0);
    expect(s.calls()).toEqual(["pi install git:github.com/michael-denyer/pstack-claude"]);
    expect(existsSync(s.staged)).toBe(false);
  });

  run("--dry-run prints the steps and writes nothing", () => {
    const s = sandbox();
    const r = s.open("--yes", "--dry-run");
    expect(r.code).toBe(0);
    expect(r.out).toContain("claude plugin install pstack@pstack-claude");
    expect(r.out).toContain(`muse plugins install ${s.staged}`);
    expect(s.calls()).toEqual([]);
    expect(readdirSync(s.home)).toEqual([]);
    expect(readdirSync(s.xdg)).toEqual([]);
    expect(existsSync(s.minimax)).toBe(false);
  });

  run("no terminal and no flags exits 2 with usage", () => {
    const s = sandbox();
    const r = s.open();
    expect(r.code).toBe(2);
    expect(r.err).toContain("Usage: open-pstack");
    expect(s.calls()).toEqual([]);
  });

  run("an empty --only= exits 2", () => {
    const s = sandbox();
    const r = s.open("--only=");
    expect(r.code).toBe(2);
    expect(r.err).toContain("--only needs a comma list of ids");
    expect(s.calls()).toEqual([]);
  });

  run("a staging failure exits 1 and leaves no partial copy", () => {
    const s = sandbox();
    writeFileSync(join(s.xdg, "open-pstack"), "a file where the data dir should be");
    const r = s.open("--only", "skills");
    expect(r.code).toBe(1);
    expect(r.err).toContain("Could not stage the plugin");
    expect(existsSync(join(s.home, ".agents"))).toBe(false);
  });

  run("an unknown harness id exits 2", () => {
    const r = sandbox().open("--only", "nope");
    expect(r.code).toBe(2);
    expect(r.err).toContain("unknown harness id: nope");
  });

  run("stages the plugin when installed under node_modules", () => {
    const s = sandbox();
    const pkg = join(s.root, "node_modules", "open-pstack");
    mkdirSync(pkg, { recursive: true });
    for (const name of ["bin", "lib", "package.json"]) {
      cpSync(join(repoRoot, "installer", name), join(pkg, name), { recursive: true });
    }
    cpSync(join(repoRoot, "plugins/pstack"), join(pkg, "plugin"), {
      recursive: true,
      filter: (src) => !src.split(sep).includes("node_modules"),
    });
    const r = spawnSync(nodePath(), [join(pkg, "bin/open-pstack.mjs"), "--only", "skills"], {
      env: userEnv(s.home, { PATH: dirname(nodePath()), XDG_DATA_HOME: s.xdg }),
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    expect(existsSync(join(s.staged, "skills", "poteto-mode", "SKILL.md"))).toBe(true);
    expect(realpathSync(join(s.home, ".agents", "skills", "poteto-mode"))).toBe(
      realpathSync(join(s.staged, "skills", "poteto-mode")),
    );
  });

  // Homebrew builds from the GitHub tag tarball, which keeps git's file mode;
  // npm sets the bit itself, so only this catches a 644 bin.
  test("the bin is committed executable", () => {
    const r = spawnSync("git", ["-C", repoRoot, "ls-files", "-s", "installer/bin/open-pstack.mjs"], {
      encoding: "utf8",
    });
    expect(r.stdout.split(" ")[0]).toBe("100755");
  });

  run("--version prints the repo version", () => {
    const version = readFileSync(join(repoRoot, "VERSION"), "utf8").trim();
    expect(sandbox().open("--version").out.trim()).toBe(version);
  });
});
