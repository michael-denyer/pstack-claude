// Unit tests for the generator: the region model that stamps model policy into
// skills, the version stamp, the validators, and the plan it writes from.
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  apply,
  applyRegions,
  assertChangesHeading,
  changes,
  deriveSkill,
  loadLeadLines,
  noteSkills,
  effortAgents,
  effortSection,
  OWNED_DIRS,
  plan,
  PORTABLE_ASSETS,
  problems,
  stampAgentPaths,
  stampLeadLine,
  fenceUnder,
  loadModels,
  parseFrontmatter,
  promptStub,
  publicSkills,
  slashCommands,
  regions,
  section,
  stampVersion,
  strayModelSlugs,
  tableRows,
} from "../tools/generate.mjs";
import { piModelNamesSection, RUNTIMES } from "../tools/runtimes.mjs";
import { walk } from "../tools/validate-skills.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const models = loadModels();
const leads = loadLeadLines();
const [codex, pi, copilot] = RUNTIMES;

const lines = (text) => text.split("\n");
const spanned = (locate, doc) => {
  const span = locate(doc);
  return span && doc.slice(...span);
};

describe("locators", () => {
  test("section spans from the heading to the next ## heading", () => {
    const doc = lines("# T\n\n## Models\n\nold\n\n## Next\nx");
    expect(spanned(section("Models"), doc)).toEqual(["", "old", ""]);
    expect(spanned(section("Next"), doc)).toEqual(["x"]);
    expect(spanned(section("Absent"), doc)).toBeNull();
  });

  test("fenceUnder spans the inside of the first matching fence after the titled step, whatever its number", () => {
    const doc = lines("### 5. Write the override sheet\n\ntext\n```markdown\na\nb\n```\nafter");
    const renumbered = lines("### 6. Write the override sheet\n```markdown\na\n```");
    const unclosed = lines("### 5. Write the override sheet\n```markdown\nunclosed");
    expect(spanned(fenceUnder("Write the override sheet", "markdown"), doc)).toEqual(["a", "b"]);
    expect(spanned(fenceUnder("Write the override sheet", "markdown"), renumbered)).toEqual(["a"]);
    expect(spanned(fenceUnder("Write the override sheet", "yaml"), doc)).toBeNull();
    expect(spanned(fenceUnder("Write", "markdown"), doc)).toBeNull();
    expect(spanned(fenceUnder("Absent", "markdown"), doc)).toBeNull();
    expect(spanned(fenceUnder("Write the override sheet", "markdown"), unclosed)).toBeNull();
  });

  test("tableRows spans the consecutive rows with the prefix after the separator", () => {
    const doc = lines("| Subagent | Default model |\n| --- | --- |\n| Reviewer A | x |\n| Reviewer B | y |\n\ntext");
    expect(spanned(tableRows("| Subagent | Default model |", "| Reviewer "), doc)).toEqual([
      "| Reviewer A | x |",
      "| Reviewer B | y |",
    ]);
    expect(spanned(tableRows("| Other |", "|"), doc)).toBeNull();
  });
});

describe("regions", () => {
  test("every skill in models.json gets its model defaults and the Reasoning effort section stamped", () => {
    const marked = {
      ...models,
      defaultEffort: "marker-effort",
      roles: models.roles.map((r) => ({ ...r, models: [`marker-${r.skill}`] })),
    };
    for (const skill of new Set(models.roles.map((r) => r.skill))) {
      const file = `plugins/pstack/skills/${skill}/SKILL.md`;
      const stamped = applyRegions(file, readFileSync(join(repoRoot, file), "utf8"), marked);
      expect(stamped).toContain(`\`marker-${skill}\``);
      expect(stamped).toContain("`marker-effort`");
    }
  });

  test("applyRegions stamps in place and is idempotent", () => {
    const file = "plugins/pstack/skills/how/SKILL.md";
    const text = "# how\n\n## Models\n\nstale\n\n## After\nkeep\n\n## Reasoning effort\n";
    const once = applyRegions(file, text, models);
    expect(once).not.toContain("stale");
    expect(once).toContain("## After\nkeep\n");
    expect(once).toContain("- how explorer:");
    expect(applyRegions(file, once, models)).toBe(once);
  });

  test("applyRegions throws when an owned file lost its anchor", () => {
    expect(() => applyRegions("plugins/pstack/skills/how/SKILL.md", "# how\n\n## Reasoning effort\n", models)).toThrow(
      "plugins/pstack/skills/how/SKILL.md: no anchor for the Models section to stamp",
    );
  });

  test("a policy without the interrogate reviewers role throws naming it", () => {
    const roles = models.roles.filter((r) => r.role !== "interrogate reviewers");
    expect(() => regions({ ...models, roles })).toThrow('models.json: no "interrogate reviewers" role');
  });

  test("applyRegions leaves a file the generator does not own untouched", () => {
    const text = "# other\n\n## Models\n\nprose\n";
    expect(applyRegions("plugins/pstack/skills/other/SKILL.md", text, models)).toBe(text);
  });
});

describe("runtime model names", () => {
  test("each runtime's mapping file owns a stamped Model names section", () => {
    for (const runtime of RUNTIMES) {
      expect(regions(models).filter((r) => r.file === runtime.tools).map((r) => r.name)).toEqual(["Model names section"]);
    }
  });

  test("the Pi section tables every alias per provider, names the fallback, and names the sheet override", () => {
    const tables = { ...models.pi.models, marker: { opus: "marker/o", fable: "marker/f", sonnet: "marker/s", haiku: "marker/h" } };
    const text = piModelNamesSection({ ...models, pi: { fallback: "marker", models: tables } });
    expect(text).toContain(`| Alias | ${Object.keys(tables).map((p) => `\`${p}\``).join(" | ")} |`);
    for (const alias of models.available) {
      expect(text).toContain(`| \`${alias}\` | ${Object.values(tables).map((t) => `\`${t[alias]}\``).join(" | ")} |`);
    }
    expect(text).toContain("in the `marker` column for any other provider");
    expect(text).toContain("`pi models: ");
  });
});

describe("strayModelSlugs", () => {
  test("a slug inside an owned region is exempt", () => {
    const file = "plugins/pstack/skills/how/SKILL.md";
    const text = applyRegions(file, "# how\n\n## Models\n\nx\n\n## Reasoning effort\n", models);
    expect(strayModelSlugs(file, text, models)).toEqual([]);
  });

  test("a slug under a Models heading in a file the generator does not own is a stray", () => {
    const text = "# other\n\n## Models\n\nUse claude-opus-99 always.\n";
    expect(strayModelSlugs("plugins/pstack/skills/other/SKILL.md", text, models)).toEqual([
      "plugins/pstack/skills/other/SKILL.md:5: Use claude-opus-99 always.",
    ]);
  });

  test("a slug outside the owned region of an owned file is a stray", () => {
    const file = "plugins/pstack/skills/how/SKILL.md";
    const text = applyRegions(file, "# how\n\n## Models\n\nx\n\n## Setup\n\nPrefer claude-sonnet-4-6.\n\n## Reasoning effort\n", models);
    const strays = strayModelSlugs(file, text, models);
    expect(strays).toHaveLength(1);
    expect(strays[0]).toContain("Prefer claude-sonnet-4-6.");
  });

  test("a backticked family name outside an owned region is a stray", () => {
    const text = "# other\n\nDelegate to `fable` for this.\n";
    expect(strayModelSlugs("plugins/pstack/skills/other/SKILL.md", text, models)).toEqual([
      "plugins/pstack/skills/other/SKILL.md:3: Delegate to `fable` for this.",
    ]);
  });

  test.each([
    "claude-3-opus-20240229",
    "claude-3-5-haiku-20241022",
    "claude-3.7-sonnet",
    "anthropic/claude-3.5-sonnet",
    "anthropic.claude-3-5-sonnet-20240620-v1:0",
  ])("a claude-* ID that puts version numbers before a listed family is a stray: %s", (id) => {
    const file = "plugins/pstack/skills/other/SKILL.md";
    expect(strayModelSlugs(file, `# other\n\nDispatch with \`${id}\`.\n`, models)).toEqual([`${file}:3: Dispatch with \`${id}\`.`]);
  });

  test.each([
    "Run it in claude-code and read claude-mem.",
    "Needs claude-code-2.1.267 or newer.",
    "Needs claude-code-2.x or newer.",
    "Needs claude-code-2 or newer.",
    "Pin claude-agent-sdk-0.2.x in package.json.",
    "Pin claude-sdk-1.x in package.json.",
    "Sandbox scratch lives in /tmp/claude-501/.",
    "Sandbox scratch lives in /tmp/claude-99-cwd/.",
    "Back up to ~/.claude-backup-20261006 first.",
    "Back up to ~/.claude-backup-06-10 first.",
    "Tracked as claude-code-issue-12345.",
    "Tracked as claude-issue-42.",
    "Name the worktrees claude-wt-1 and claude-wt-2.",
    "Step claude-1-setup, then claude-2-run.",
    "Name the worktree claude-wt-opus.",
    "Run the claude-octopus demo.",
  ])("a claude-* slug with no listed family after claude- or its version numbers is not a stray: %s", (line) => {
    expect(strayModelSlugs("plugins/pstack/skills/other/SKILL.md", `# other\n\n${line}\n`, models)).toEqual([]);
  });
});

describe("stampVersion", () => {
  test("rewrites the single version field and keeps formatting", () => {
    const text = '{\n  "name": "x",\n  "version":   "0.1.0",\n  "keywords": []\n}\n';
    expect(stampVersion(text, "0.2.0", "m.json")).toBe(
      '{\n  "name": "x",\n  "version":   "0.2.0",\n  "keywords": []\n}\n',
    );
  });

  test("refuses a manifest with zero or two version fields", () => {
    expect(() => stampVersion('{"name":"x"}', "1.0.0", "m.json")).toThrow('m.json: expected exactly 1 "version" field, found 0');
    expect(() => stampVersion('{"version":"1","dep":{"version":"2"}}', "1.0.0", "m.json")).toThrow("found 2");
  });
});

describe("assertChangesHeading", () => {
  test("requires the current version's heading and one shape for every release heading", () => {
    expect(() => assertChangesHeading("## 0.9.1 - title\n## 0.9.0 - older\n", "0.9.1")).not.toThrow();
    expect(() => assertChangesHeading("## 0.9.10 - title\n", "0.9.1")).toThrow('no "## 0.9.1 - <title>" heading');
    expect(() => assertChangesHeading("## 0.9.1 - title\n## 0.9.0 — em dash\n## 0.8.9\n", "0.9.1")).toThrow(
      'read "## <version> - <title>":\n## 0.9.0 — em dash\n## 0.8.9',
    );
  });

  test("a heading newer than VERSION fails naming both, so an entry without a bump cannot ship", () => {
    expect(() => assertChangesHeading("# Changes\n\n## 0.9.71 - newer\n\n## 0.9.70 - current\n", "0.9.70")).toThrow(
      'CHANGES.md\'s newest release heading is "## 0.9.71 - newer", but VERSION is 0.9.70',
    );
  });

  test("a newer version that only extends VERSION fails like any other", () => {
    expect(() => assertChangesHeading("# Changes\n\n## 0.9.70 - newer\n\n## 0.9.7 - current\n", "0.9.7")).toThrow(
      'CHANGES.md\'s newest release heading is "## 0.9.70 - newer", but VERSION is 0.9.7',
    );
  });

  test.each(["## v0.9.71 - newer", "## [0.9.71] - newer", "##  0.9.71 - newer", "##0.9.71 - newer", "### 0.9.71 - newer", "# 0.9.71 - newer"])(
    "an entry headed %s above the VERSION heading fails, whatever its level, spacing, or decoration",
    (heading) => {
      expect(() => assertChangesHeading(`# Changes\n\n${heading}\n\n## 0.9.70 - current\n`, "0.9.70")).toThrow(
        `CHANGES.md's newest release heading is "${heading}", but VERSION is 0.9.70`,
      );
    },
  );

  test.each(["## About this file", "## Unreleased", "## Format since 0.9.13", "## 2.0 plans"])(
    "a heading that does not lead with a three-part version is no entry and may sit above the newest: %s",
    (heading) => {
      expect(() => assertChangesHeading(`# Changes\n\n${heading}\n\n## 0.9.71 - new\n\n## 0.9.70 - old\n`, "0.9.71")).not.toThrow();
    },
  );

  test("a version that heads two entries fails naming both, so new work under the old number cannot ship", () => {
    expect(() => assertChangesHeading("# Changes\n\n## 0.9.70 - newer work\n\n## 0.9.70 - current\n", "0.9.70")).toThrow(
      "CHANGES.md heads two entries with one version:\n## 0.9.70 - newer work\n## 0.9.70 - current",
    );
  });

  test("a heading that is not a release may sit below the newest entry", () => {
    expect(() => assertChangesHeading("## 0.9.1 - title\n\n## Upstream review\n\n## 0.9.0 - older\n", "0.9.1")).not.toThrow();
  });

  test.each([
    ["an older heading quoted in the newest entry", "## 0.9.71 - new\n\n```\n## 0.9.70 - old\n```\n\n## 0.9.70 - old\n"],
    ["a sample heading above the first entry", "```md\n## 1.2.3 - title\n```\n\n## 0.9.71 - new\n\n## 0.9.70 - old\n"],
    ["a tilde fence", "## 0.9.71 - new\n\n~~~\n## 0.9.70 - old\n~~~\n\n## 0.9.70 - old\n"],
    ["an indented fence", "## 0.9.71 - new\n\n ```\n## 0.9.70 - old\n ```\n\n## 0.9.70 - old\n"],
    ["a longer fence holding a shorter one", "## 0.9.71 - new\n\n````\n```\n## 0.9.70 - old\n```\n````\n\n## 0.9.70 - old\n"],
    ["a tilde line inside a backtick fence", "## 0.9.71 - new\n\n```\n~~~\n## 0.9.70 - old\n~~~\n```\n\n## 0.9.70 - old\n"],
    ["a longer run closing a shorter fence", "```\n## 1.2.3 - sample\n````\n\n## 0.9.71 - new\n\n## 0.9.70 - old\n"],
    ["a marker with an info string inside a fence", "```\n```md\n## 1.2.3 - sample\n```\n\n## 0.9.71 - new\n\n## 0.9.70 - old\n"],
  ])("a heading inside a code fence heads no entry: %s", (_, body) => {
    expect(() => assertChangesHeading(`# Changes\n\n${body}`, "0.9.71")).not.toThrow();
  });

  test.each([
    ["in the middle of a line", "Quote a heading in a ``` fence."],
    ["indented four spaces, which is a code block", "    ```"],
  ])("three backticks %s open no fence", (_, line) => {
    expect(() => assertChangesHeading(`# Changes\n\n${line}\n\n## 0.9.71 - new\n\n## 0.9.70 - old\n`, "0.9.71")).not.toThrow();
  });

  test("a VERSION heading that sits only inside a code fence is no heading", () => {
    expect(() => assertChangesHeading("# Changes\n\n```\n## 0.9.71 - new\n```\n\n## 0.9.70 - old\n", "0.9.71")).toThrow(
      'no "## 0.9.71 - <title>" heading',
    );
  });
});

describe("slashCommands", () => {
  const reference = (rows) => `# R\n\n| command | use it when |\n| --- | --- |\n${rows.join("\n")}\n\nafter\n`;

  test("reads name and menu text in row order", () => {
    const text = reference(["| `/b` | second thing |", "| `/a` | first thing |"]);
    expect(slashCommands(text, ["a", "b"])).toEqual([
      { name: "b", menu: "second thing" },
      { name: "a", menu: "first thing" },
    ]);
  });

  test("names a skill without a row and a row without a skill", () => {
    expect(() => slashCommands(reference(["| `/a` | x |", "| `/gone` | y |"]), ["a", "new"])).toThrow(
      "row without a skill: gone; skill without a row: new",
    );
  });

  test("rejects a malformed row and a missing table", () => {
    expect(() => slashCommands(reference(["| /a | x |"]), ["a"])).toThrow("row 1 is not");
    expect(() => slashCommands("# R\n\nno table\n", ["a"])).toThrow("table header not found");
  });

  test("rejects menu text that the prompt's YAML frontmatter would not read back, naming file and row", () => {
    expect(() => slashCommands(reference(["| `/a` | fine |", "| `/b` | fix CI: then ship |"]), ["a", "b"])).toThrow(
      "docs/reference.md: slash-command row 2 text is not a plain YAML value",
    );
    const samples = [
      "fix CI: then ship",
      "run it # carefully",
      "ends with colon:",
      "`/x` first",
      "*star",
      "[a] b",
      "- item",
      "a:b ratio, issue#12, [x] {y}",
      "-mode skill",
      "monitor an open PR, fix CI/comments, keep it merge-ready",
    ];
    for (const menu of samples) {
      let parsed;
      try {
        parsed = Bun.YAML.parse(promptStub({ name: "b", menu }, RUNTIMES[0]).split("---\n")[1]).description;
      } catch {}
      let accepted = true;
      try {
        slashCommands(reference([`| \`/b\` | ${menu} |`]), ["b"]);
      } catch {
        accepted = false;
      }
      expect({ menu, accepted }).toEqual({ menu, accepted: parsed === menu });
    }
  });

  test("the live reference names exactly the public skills, poteto-mode first", () => {
    const text = readFileSync(join(repoRoot, "docs/reference.md"), "utf8");
    const rows = slashCommands(text, publicSkills(join(repoRoot, "plugins/pstack/skills")));
    expect(rows[0].name).toBe("poteto-mode");
  });
});

describe("parseFrontmatter", () => {
  test("splits the YAML block from the body", () => {
    expect(parseFrontmatter("---\nname: x\nflag: false \n---\n\nbody\n")).toEqual({
      data: { name: "x", flag: false },
      body: "\nbody\n",
    });
  });

  test("reads a CRLF block", () => {
    expect(parseFrontmatter("---\r\nname: x\r\n---\r\nbody\r\n")).toEqual({ data: { name: "x" }, body: "body\r\n" });
  });

  test("returns null data and the whole text when there is no block", () => {
    expect(parseFrontmatter("# title\n---\nname: x\n---\n")).toEqual({
      data: null,
      body: "# title\n---\nname: x\n---\n",
    });
  });
});

describe("deriveSkill", () => {
  const front = (flags, name = "x") => `---\nname: ${name}\ndescription: d\n${flags}---\n\nbody\n`;

  test("drops disable-model-invocation on a public skill and swaps it on a principle leaf", () => {
    expect(deriveSkill("plugins/pstack/skills/x/SKILL.md", front("disable-model-invocation: true\n"), models, leads)).toBe(
      front(""),
    );
    expect(
      deriveSkill(
        "plugins/pstack/skills/principle-x/SKILL.md",
        front("disable-model-invocation: true\n", "principle-x"),
        models,
        leads,
      ),
    ).toBe(front("user-invocable: false\n", "principle-x"));
  });

  test("names a skill after its directory and an agent after its file, and drops Cursor-only keys", () => {
    const cursorKeys = "mode: true\nicon: crown\ncolor: yellow\nreminder: >-\n  New task?\n  Apply it.\n";
    expect(
      deriveSkill("plugins/pstack/skills/x/SKILL.md", front(`${cursorKeys}disable-model-invocation: true\n`, "X Mode"), models, leads),
    ).toBe(front(""));
    expect(deriveSkill("plugins/pstack/agents/comment-sicko.md", front("is_background: true\n", "Comment Sicko"), models, leads)).toBe(
      front("", "comment-sicko"),
    );
  });

  test("leaves a reference file's frontmatter alone", () => {
    const text = front("mode: true\n", "Some Reference");
    expect(deriveSkill("plugins/pstack/skills/x/references/y.md", text, models, leads)).toBe(text);
  });

  test.each(["|-", ">-"])("drops every paragraph of a %s reminder without changing adjacent fields", (style) => {
    const text = front(`reminder: ${style}\n  First paragraph.\n\n  Second paragraph.\n  \n  Last paragraph.\nallowed-tools:\n  - Read\n`);
    const out = deriveSkill("plugins/pstack/skills/x/SKILL.md", text, models, leads);

    expect(parseFrontmatter(out)).toEqual({
      data: { name: "x", description: "d", "allowed-tools": ["Read"] },
      body: parseFrontmatter(text).body,
    });
    expect(deriveSkill("plugins/pstack/skills/x/SKILL.md", out, models, leads)).toBe(out);
  });

  test("leaves a prose mention of the flag alone", () => {
    const text = front("", "automate-me") + "Never write `disable-model-invocation: true` on a skill.\n";
    expect(deriveSkill("plugins/pstack/skills/automate-me/SKILL.md", text, models, leads)).toBe(text);
  });

  test("leaves a flag line in the body alone when the frontmatter has none", () => {
    const text = front("", "automate-me") + "disable-model-invocation: true\n";
    expect(deriveSkill("plugins/pstack/skills/automate-me/SKILL.md", text, models, leads)).toBe(text);
  });

  test("appends and stamps a Models section when upstream has none", () => {
    const out = deriveSkill("plugins/pstack/skills/how/SKILL.md", front("disable-model-invocation: true\n"), models, leads);
    expect(out.endsWith("body\n\n## Models\n\nRole defaults, stamped from")).toBe(false);
    expect(out).toContain("body\n\n## Models\n\nRole defaults, stamped from");
    expect(out).toContain("- how explorer:");
    expect(out.endsWith("\n")).toBe(true);
    expect(deriveSkill("plugins/pstack/skills/how/SKILL.md", out, models, leads)).toBe(out);
  });

  test("leaves a region whose anchor upstream lacks unstamped instead of throwing", () => {
    const text = front("disable-model-invocation: true\n") + "no reviewer table here\n";
    const out = deriveSkill("plugins/pstack/skills/interrogate/SKILL.md", text, models, leads);
    expect(out.startsWith(front("", "interrogate") + "no reviewer table here\n")).toBe(true);
    expect(out).not.toContain("| Reviewer A");
    expect(out).toContain("\n## Reasoning effort\n\nA role value in");
  });

  test("appends the Reasoning effort section after the Models section", () => {
    const out = deriveSkill("plugins/pstack/skills/how/SKILL.md", front("disable-model-invocation: true\n"), models, leads);
    expect(out.indexOf("## Models")).toBeLessThan(out.indexOf("## Reasoning effort"));
    expect(out).toContain("subagent_type: \"pstack:effort-<level>\"");
  });

  test("stamps a file's lead line in its own paragraph under the first heading", () => {
    for (const file of ["plugins/pstack/skills/teach/SKILL.md", "plugins/pstack/skills/poteto-mode/playbooks/refactoring.md"]) {
      const text = "---\nname: teach\ndescription: d\n---\n\n# Title\n\nbody\n";
      const out = deriveSkill(file, text, models, leads);
      expect(out).toBe(text.replace("# Title\n\n", `# Title\n\n${leads.get(file).join("\n\n")}\n\n`));
      expect(deriveSkill(file, out, models, leads)).toBe(out);
    }
  });

  test("a file the generator does not own passes through", () => {
    const text = "# plain\n\nreference text\n";
    expect(deriveSkill("plugins/pstack/skills/how/references/x.md", text, models, leads)).toBe(text);
  });
});

describe("lead lines", () => {
  test("a lead line goes under the first heading after the frontmatter, once", () => {
    const text = "---\nname: x\n# a YAML comment\n---\n\n# Title\n\nbody\n";
    const once = stampLeadLine(text, "Lead.");
    expect(once).toBe("---\nname: x\n# a YAML comment\n---\n\n# Title\n\nLead.\n\nbody\n");
    expect(stampLeadLine(once, "Lead.")).toBe(once);
    expect(stampLeadLine("no heading\n", "Lead.")).toBeNull();
  });

  test("stamping converges a duplicated lead line, one that lost a blank separator on either side, and one out of order", () => {
    const canonical = "# X\n\nA.\n\nB.\n\nBody.\n";
    expect(stampLeadLine("# X\n\nA.\nA.\n\nB.\n\nBody.\n", ["A.", "B."])).toBe(canonical);
    expect(stampLeadLine("# X\nA.\n\nB.\n\nBody.\n", ["A.", "B."])).toBe(canonical);
    expect(stampLeadLine("# X\n\nA.\n\nB.\nBody.\n", ["A.", "B."])).toBe(canonical);
    expect(stampLeadLine("# X\nA.\nB.\nBody.\n", ["A.", "B."])).toBe(canonical);
    expect(stampLeadLine("# X\n\nB.\n\nA.\n\nBody.\n", ["A.", "B."])).toBe(canonical);
  });

  test("removing a lead glued to the text below it keeps the blank line that ended the paragraph above", () => {
    expect(stampLeadLine("# X\n\nIntro.\n\nA.\n\nB.\nBody.\n", ["A.", "B."])).toBe("# X\n\nA.\n\nB.\n\nIntro.\n\nBody.\n");
    expect(stampLeadLine("# X\n\nB.\n\nBody one.\n\nA.\nBody two.\n", ["A.", "B."])).toBe("# X\n\nA.\n\nB.\n\nBody one.\n\nBody two.\n");
  });

  test("a lead line that ends the file gains no blank line after it", () => {
    for (const text of ["# X\n\nA.\n", "# X\n\nA."]) expect(stampLeadLine(text, "A.")).toBe(text);
  });

  test("Codex and Copilot stamp a preamble on their noted skills and Pi stamps none", () => {
    expect(RUNTIMES.map((r) => r.name)).toEqual(["Codex", "Pi", "GitHub Copilot"]);
    expect(codex.preamble).toBe(
      "On Codex, read the [platform mapping](../poteto-mode/references/codex-tools.md), including its per-skill notes, before following this skill.",
    );
    expect(copilot.preamble).toBe(
      "On GitHub Copilot, read the [platform mapping](../poteto-mode/references/copilot-tools.md), including its per-skill notes, before following this skill.",
    );
    expect(pi.preamble).toBeNull();
    expect([...leads.values()].flat().filter((line) => line.includes("pi-tools.md"))).toEqual([]);
  });

  test("a notes table lists its skills in row order and rejects a row without one", () => {
    const table = (...rows) => ["| Skill | On Pi |", "|-------|-------|", ...rows, "", "after"].join("\n");
    expect(noteSkills(pi, table("| `how` | fan-out |", "| `teach` | images |"))).toEqual(["how", "teach"]);
    expect(() => noteSkills(pi, table("| how | fan-out |"))).toThrow("does not start with a backticked skill: | how |");
    expect(() => noteSkills(codex, "no table\n")).toThrow('"| Skill | On Codex |" table header not found');
  });

  test("a prompt stub points at its runtime's mapping file unless its skill carries that runtime's preamble", () => {
    const pointer = "through `poteto-mode/references/codex-tools.md`, including its Per-skill notes.";
    expect(promptStub({ name: "tdd", menu: "m" }, codex, { preamble: false })).toContain(pointer);
    expect(promptStub({ name: "tdd", menu: "m" }, pi, { preamble: false })).toContain("`poteto-mode/references/pi-tools.md`");
    expect(promptStub({ name: "how", menu: "m" }, codex, { preamble: true })).toBe(
      "---\nname: how\ndescription: m\ndisable-model-invocation: true\n---\n\nInvoke the `how` skill and follow it.\n",
    );
  });

  test("a prompt stub repeats the codex-tools.md pointer only when its skill lacks the stamped preamble", () => {
    const { files } = plan(repoRoot);
    const stubs = Object.keys(files).filter((rel) => rel.startsWith("plugins/pstack/.codex-plugin/prompts/"));
    const pointsAtMapping = (rel) => files[rel].includes("codex-tools.md");
    const carriesPreamble = (rel) => {
      const skill = `plugins/pstack/skills/${basename(rel, ".md")}/SKILL.md`;
      return readFileSync(join(repoRoot, skill), "utf8").includes("On Codex, read the [platform mapping]");
    };
    expect(stubs.filter(carriesPreamble).length).toBeGreaterThan(0);
    expect(stubs.filter((rel) => !carriesPreamble(rel)).length).toBeGreaterThan(0);
    for (const rel of stubs) expect({ rel, points: pointsAtMapping(rel) }).toEqual({ rel, points: !carriesPreamble(rel) });
  });
});

describe("effort agents", () => {
  const poteto = "---\nname: poteto-agent\ndescription: Routing contract.\n---\n\n# Poteto subagent\n\nRead the skill.\n";
  const agents = effortAgents(["high", "max"], poteto);

  test("one general-purpose and one poteto agent per level, each setting only effort", () => {
    expect(agents.map((a) => a.name)).toEqual(["effort-high", "poteto-agent-high", "effort-max", "poteto-agent-max"]);
    for (const agent of agents) {
      const level = agent.name.split("-").at(-1);
      expect(agent.text).toContain(`\nname: ${agent.name}\n`);
      expect(agent.text).toContain(`\neffort: ${level}\n---\n`);
      expect(agent.text).not.toMatch(/^model:/m);
    }
  });

  test("the poteto variant carries poteto-agent's body verbatim", () => {
    expect(agents[1].text.endsWith("---\n\n# Poteto subagent\n\nRead the skill.\n")).toBe(true);
    expect(agents[1].text.match(/^---$/gm)).toHaveLength(2);
  });

  test("the poteto variant's description defers to pstack:poteto-agent rather than copying its routing contract", () => {
    const description = agents[1].text.match(/^description: (.*)$/m)[1];
    expect(description).toContain("in place of `pstack:poteto-agent`");
    expect(description).not.toContain("Routing contract.");
  });

  test("every agent's frontmatter reads back as YAML", () => {
    for (const agent of agents) {
      expect(parseFrontmatter(agent.text).data.name).toBe(agent.name);
    }
  });

  const pluginRoot = join(fileURLToPath(new URL("..", import.meta.url)), "plugins/pstack");

  test("plugin.json lists both hand-written and generated agents", () => {
    const listed = JSON.parse(readFileSync(join(pluginRoot, ".claude-plugin/plugin.json"), "utf8")).agents;
    expect(listed).toContain("./agents/poteto-agent.md");
    expect(listed).toContain("./effort-agents/effort-high.md");
  });

  test("stamping the agents list keeps every other manifest field", () => {
    const text = '{\n  "name": "pstack",\n  "version": "1.0.0"\n}\n';
    const out = stampAgentPaths(text, ["./agents/a.md"]);
    expect(JSON.parse(out)).toEqual({ name: "pstack", version: "1.0.0", agents: ["./agents/a.md"] });
    expect(stampAgentPaths(out, ["./agents/a.md"])).toBe(out);
  });

  test("the stamped section names every level, the default, both dispatch targets, and the Codex parameter", () => {
    const text = effortSection(["low", "max"], "high");
    for (const level of ["low", "max", "high"]) expect(text).toContain(`\`${level}\``);
    expect(text).toContain('subagent_type: "pstack:effort-<level>"');
    expect(text).toContain('subagent_type: "pstack:poteto-agent-<level>"');
    expect(text).toContain("`reasoning_effort`");
  });
});

describe("plan, changes, apply", () => {
  const made = [];
  afterEach(() => {
    for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const scratch = (prefix) => {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    made.push(dir);
    return dir;
  };
  const repoCopy = () => {
    const dir = scratch("pstack-generate-");
    cpSync(repoRoot, dir, { recursive: true, filter: (src) => ![".git", "node_modules"].includes(basename(src)) });
    symlinkSync(join(repoRoot, "node_modules"), join(dir, "node_modules"));
    return dir;
  };
  const snapshot = (dir) => Object.fromEntries(walk(dir).map((path) => [path, readFileSync(path, "utf8")]));
  const quiet = { log: () => {} };
  const STUB = "plugins/pstack/.codex-plugin/prompts/tdd.md";
  const STRAY = "plugins/pstack/effort-agents/stray.md";

  test("the working tree is what the plan says", () => {
    expect(changes(repoRoot, plan(repoRoot))).toEqual([]);
  });

  test("plan computes from the sources, repeats itself, and writes nothing", () => {
    const root = repoCopy();
    const current = readFileSync(join(root, STUB), "utf8");
    writeFileSync(join(root, STUB), "stale\n");
    writeFileSync(join(root, STRAY), "orphan\n");
    const before = snapshot(root);
    const first = plan(root);
    expect(plan(root)).toEqual(first);
    expect(first.files[STUB]).toBe(current);
    expect(Object.hasOwn(first.files, STRAY)).toBe(false);
    expect(snapshot(root)).toEqual(before);
  });

  test("--check on a stale tree exits 1 naming each stale path, writes nothing, and passes once regenerated", () => {
    const root = repoCopy();
    writeFileSync(join(root, STUB), "stale\n");
    writeFileSync(join(root, STRAY), "orphan\n");
    const before = snapshot(root);
    const run = (...args) => spawnSync(process.execPath, [join(root, "tools/generate.mjs"), ...args], { encoding: "utf8" });
    const stale = run("--check");
    expect(stale.status).toBe(1);
    expect(stale.stderr).toContain(
      `FAIL: generated output is stale; run bun tools/generate.mjs:\n  write: ${STUB}\n  remove: ${STRAY}\n`,
    );
    expect(snapshot(root)).toEqual(before);
    expect(run().status).toBe(0);
    expect(run("--check").status).toBe(0);
  });

  test("apply rewrites only the files whose bytes differ", () => {
    const root = repoCopy();
    const intended = plan(root);
    writeFileSync(join(root, STUB), "stale\n");
    const past = new Date("2001-01-01T00:00:00Z");
    for (const path of Object.keys(intended.files)) utimesSync(join(root, path), past, past);
    expect(apply(root, intended, quiet)).toEqual([{ kind: "write", path: STUB }]);
    expect(readFileSync(join(root, STUB), "utf8")).toBe(intended.files[STUB]);
    const touched = Object.keys(intended.files).filter(
      (path) => statSync(join(root, path)).mtimeMs !== past.getTime(),
    );
    expect(touched).toEqual([STUB]);
  });

  test("apply writes each planned file and removes every other entry in an owned directory", () => {
    const root = scratch("pstack-apply-");
    mkdirSync(join(root, "out/leftover"), { recursive: true });
    writeFileSync(join(root, "out/a.md"), "old");
    writeFileSync(join(root, "out/extra.md"), "orphan");
    const intended = { files: { "out/a.md": "A", "out/b.md": "B", "top/c.json": "C" }, ownedDirs: ["out"] };
    expect(apply(root, intended, quiet)).toEqual([
      { kind: "write", path: "out/a.md" },
      { kind: "write", path: "out/b.md" },
      { kind: "write", path: "top/c.json" },
      { kind: "remove", path: "out/extra.md" },
      { kind: "remove", path: "out/leftover" },
    ]);
    expect(readdirSync(join(root, "out")).sort()).toEqual(["a.md", "b.md"]);
    expect(readFileSync(join(root, "out/a.md"), "utf8")).toBe("A");
    expect(readFileSync(join(root, "top/c.json"), "utf8")).toBe("C");
    expect(changes(root, intended)).toEqual([]);
  });

  test("apply refuses a symlink at a planned path before writing anything", () => {
    const root = scratch("pstack-apply-");
    const outside = join(scratch("pstack-outside-"), "target.md");
    writeFileSync(outside, "original");
    mkdirSync(join(root, "out"));
    symlinkSync(outside, join(root, "out/b.md"));
    const intended = { files: { "out/a.md": "A", "out/b.md": "B" }, ownedDirs: ["out"] };
    expect(() => apply(root, intended, quiet)).toThrow("out/b.md is a symlink; the generator never writes through one");
    expect(readFileSync(outside, "utf8")).toBe("original");
    expect(existsSync(join(root, "out/a.md"))).toBe(false);
  });

  test("apply removes a stray symlink in an owned directory without touching its target", () => {
    const root = scratch("pstack-apply-");
    const outside = scratch("pstack-outside-");
    writeFileSync(join(outside, "target.md"), "original");
    mkdirSync(join(root, "out"));
    symlinkSync(join(outside, "target.md"), join(root, "out/stray.md"));
    symlinkSync(outside, join(root, "out/stray-dir"), "dir");
    apply(root, { files: { "out/a.md": "A" }, ownedDirs: ["out"] }, quiet);
    expect(readdirSync(join(root, "out"))).toEqual(["a.md"]);
    expect(readFileSync(join(outside, "target.md"), "utf8")).toBe("original");
  });

  test("apply refuses a planned path under a symlinked directory", () => {
    const root = scratch("pstack-apply-");
    const outside = scratch("pstack-outside-");
    mkdirSync(join(root, "skills"));
    symlinkSync(outside, join(root, "skills/out"), "dir");
    for (const intended of [
      { files: { "skills/out/a.md": "A" }, ownedDirs: ["skills/out"] },
      { files: { "skills/out/deep/a.md": "A" }, ownedDirs: [] },
    ]) {
      expect(() => apply(root, intended, quiet)).toThrow("skills/out is a symlink; the generator never writes through one");
    }
    expect(readdirSync(outside)).toEqual([]);
  });

  test("apply refuses a symlinked owned directory with no planned files and deletes nothing through it", () => {
    const root = scratch("pstack-apply-");
    const outside = scratch("pstack-outside-");
    writeFileSync(join(outside, "keep.md"), "original");
    symlinkSync(outside, join(root, "out"), "dir");
    expect(() => apply(root, { files: {}, ownedDirs: ["out"] }, quiet)).toThrow(
      "out is a symlink; the generator never writes through one",
    );
    expect(readFileSync(join(outside, "keep.md"), "utf8")).toBe("original");
  });

  test("changes refuses a directory at a planned path", () => {
    const root = scratch("pstack-apply-");
    mkdirSync(join(root, "out/a.md"), { recursive: true });
    expect(() => changes(root, { files: { "out/a.md": "A" }, ownedDirs: ["out"] })).toThrow(
      "out/a.md is not a regular file; the generator never overwrites one",
    );
  });

  test("a planned file nested under an owned directory converges instead of being removed", () => {
    const root = scratch("pstack-apply-");
    const intended = { files: { "out/sub/a.md": "A" }, ownedDirs: ["out"] };
    apply(root, intended, quiet);
    expect(changes(root, intended)).toEqual([]);
    expect(readFileSync(join(root, "out/sub/a.md"), "utf8")).toBe("A");
  });

  test("plan refuses a portable copy outside the owned directories and an owned directory nested in another", () => {
    const cases = [
      [
        PORTABLE_ASSETS,
        { source: "NOTICE-skills.md", target: "poteto-mode/references/NOTICE.md" },
        "plugins/pstack/skills/poteto-mode/references/NOTICE.md is not directly inside a generator-owned directory",
      ],
      [
        PORTABLE_ASSETS,
        { source: "LICENSE", target: "poteto-mode/references/licenses/old/LICENSE" },
        "plugins/pstack/skills/poteto-mode/references/licenses/old/LICENSE is not directly inside a generator-owned directory",
      ],
      [
        OWNED_DIRS,
        "plugins/pstack/effort-agents/nested",
        "generator-owned directory plugins/pstack/effort-agents/nested is nested inside plugins/pstack/effort-agents",
      ],
    ];
    for (const [list, entry, message] of cases) {
      list.push(entry);
      try {
        expect(() => plan(repoRoot)).toThrow(message);
      } finally {
        list.pop();
      }
    }
  });

  const generate = (root, ...args) =>
    spawnSync(process.execPath, [join(root, "tools/generate.mjs"), ...args], { encoding: "utf8" });
  const append = (root, rel, text) => writeFileSync(join(root, rel), readFileSync(join(root, rel), "utf8") + text);
  const STRAY_SLUG = ["plugins/pstack/skills/tdd/SKILL.md", "\nUse claude-opus-99 here.\n"];

  test("plan restores every lead line removed by hand", () => {
    const root = repoCopy();
    const leadFiles = [...loadLeadLines(root)];
    expect(leadFiles.length).toBeGreaterThan(0);
    for (const [file, lines] of leadFiles) {
      for (const line of lines) {
        const text = readFileSync(join(root, file), "utf8");
        writeFileSync(join(root, file), text.replace(`\n\n${line}\n`, "\n"));
        expect(readFileSync(join(root, file), "utf8")).not.toContain(line);
      }
    }
    const { files } = plan(root);
    for (const [file] of leadFiles) expect(files[file]).toBe(readFileSync(join(repoRoot, file), "utf8"));
  });

  test("plan converges a duplicated lead line, so --check flags the file as stale", () => {
    const root = repoCopy();
    const file = "plugins/pstack/skills/how/SKILL.md";
    const original = readFileSync(join(root, file), "utf8");
    expect(original).toContain(`\n\n${codex.preamble}\n`);
    writeFileSync(join(root, file), original.replace(`\n\n${codex.preamble}\n`, `\n\n${codex.preamble}\n${codex.preamble}\n`));
    const intended = plan(root);
    expect(intended.files[file]).toBe(original);
    expect(changes(root, intended)).toEqual([{ kind: "write", path: file }]);
  });

  test("two producers on one path compose", () => {
    const root = repoCopy();
    const manifest = "plugins/pstack/.claude-plugin/plugin.json";
    const skill = "plugins/pstack/skills/how/SKILL.md";
    const text = (rel) => readFileSync(join(root, rel), "utf8");
    writeFileSync(
      join(root, manifest),
      JSON.stringify({ ...JSON.parse(text(manifest)), version: "0.0.1", agents: [] }, null, 2) + "\n",
    );
    writeFileSync(
      join(root, skill),
      text(skill)
        .replace(`\n\n${leads.get(skill)[0]}\n`, "\n")
        .replace(/^- how explorer: .*$/m, "- how explorer: stale"),
    );
    const { files } = plan(root);
    for (const rel of [manifest, skill]) expect(files[rel]).toBe(readFileSync(join(repoRoot, rel), "utf8"));
  });

  test("plan refuses a path two producers write whole with different text", () => {
    const target = "poteto-mode/references/licenses/LICENSE";
    PORTABLE_ASSETS.push({ source: "NOTICE-skills.md", target });
    try {
      expect(() => plan(repoRoot)).toThrow(`plugins/pstack/skills/${target} is planned twice with different text`);
    } finally {
      PORTABLE_ASSETS.pop();
    }
  });

  test.each(RUNTIMES.map((runtime) => [runtime.name, runtime]))("a %s per-skill note for a skill that does not exist fails", (_, runtime) => {
    const root = repoCopy();
    const tools = join(root, runtime.tools);
    writeFileSync(tools, readFileSync(tools, "utf8").replace(/^\| `why` \|/m, "| `gone` |"));
    expect(() => loadLeadLines(root)).toThrow(`${runtime.tools}: per-skill note for "gone", which has no SKILL.md`);
  });

  test("problems reports a lead line in a file that does not own it", () => {
    const root = repoCopy();
    append(root, "plugins/pstack/skills/tdd/SKILL.md", `\n${codex.preamble}\n`);
    const codexTools = "plugins/pstack/skills/poteto-mode/references/codex-tools.md";
    writeFileSync(join(root, codexTools), readFileSync(join(root, codexTools), "utf8").replace(/^\| `why` \|.*\n/m, ""));
    const failures = problems(root).filter((f) => f.startsWith("generator-owned lead lines"));
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("\nplugins/pstack/skills/why/SKILL.md:");
    expect(failures[0]).toContain("\nplugins/pstack/skills/tdd/SKILL.md:");
  });

  test("problems reports every broken contract, and --check prints each and exits 1", () => {
    const root = repoCopy();
    append(root, ...STRAY_SLUG);
    append(root, "plugins/pstack/skills/deslop/SKILL.md", "\n[gone](missing.md)\n");
    append(root, "plugins/pstack/skills/unslop/SKILL.md", '\nsubagent_type: "poteto-agent"\n');
    const failures = problems(root);
    expect(failures).toEqual([
      expect.stringContaining("plugins/pstack/skills/tdd/SKILL.md:"),
      "invalid local markdown links:\ndeslop/SKILL.md -> missing.md (missing)",
      expect.stringContaining("skills/unslop/SKILL.md:"),
    ]);
    const check = generate(root, "--check");
    expect(check.status).toBe(1);
    for (const failure of failures) expect(check.stderr).toContain(`FAIL: ${failure}\n`);
  });

  test("a write run regenerates before it validates, so a slug left only in a stale copy passes", () => {
    const root = repoCopy();
    const copy = "plugins/pstack/skills/poteto-mode/references/agents/comment-sicko.md";
    append(root, copy, "\nUse claude-opus-99 here.\n");
    expect(generate(root).status).toBe(0);
    expect(readFileSync(join(root, copy), "utf8")).toBe(
      readFileSync(join(root, "plugins/pstack/agents/comment-sicko.md"), "utf8"),
    );
  });

  test("--check reports a symlink at a planned path alongside the other failures and writes nothing", () => {
    const root = repoCopy();
    const outside = join(scratch("pstack-outside-"), "target.md");
    writeFileSync(outside, "original");
    rmSync(join(root, STUB));
    symlinkSync(outside, join(root, STUB));
    append(root, ...STRAY_SLUG);
    const check = generate(root, "--check");
    expect(check.status).toBe(1);
    expect(check.stderr).toContain(`FAIL: ${STUB} is a symlink; the generator never writes through one\n`);
    expect(check.stderr).toContain("FAIL: model names outside generator-owned regions");
    expect(readFileSync(outside, "utf8")).toBe("original");
  });

  test("problems reports an agent whose frontmatter strict YAML cannot read", () => {
    const root = repoCopy();
    const agent = "plugins/pstack/agents/comment-sicko.md";
    writeFileSync(
      join(root, agent),
      readFileSync(join(root, agent), "utf8").replace(/^description: .*$/m, "description: `backticked` first"),
    );
    expect(problems(root)).toEqual([
      expect.stringMatching(/^agent frontmatter is not readable YAML:\n\.\/agents\/comment-sicko\.md: /),
    ]);
  });

  test("problems reports an agent whose frontmatter name is not its file name", () => {
    const root = repoCopy();
    const agent = "plugins/pstack/agents/comment-sicko.md";
    writeFileSync(join(root, agent), readFileSync(join(root, agent), "utf8").replace(/^name: .*$/m, "name: sicko"));
    expect(problems(root)).toEqual([
      expect.stringContaining('./agents/comment-sicko.md: frontmatter name "sicko" != file name "comment-sicko"'),
    ]);
  });

  test("problems reports a malformed Codex manifest as one failure and still runs the other checks", () => {
    const root = repoCopy();
    const manifest = "plugins/pstack/.codex-plugin/plugin.json";
    append(root, ...STRAY_SLUG);
    for (const text of [readFileSync(join(root, manifest), "utf8") + "}\n", "null\n"]) {
      writeFileSync(join(root, manifest), text);
      expect(problems(root)).toEqual([
        expect.stringContaining(`${manifest}: `),
        expect.stringContaining("plugins/pstack/skills/tdd/SKILL.md:"),
      ]);
    }
  });

  test("problems checks the Copilot manifest and the hooks file it names", () => {
    const root = repoCopy();
    const manifest = "plugins/pstack/.github/plugin/plugin.json";
    const hooks = "plugins/pstack/hooks/copilot-hooks.json";
    writeFileSync(join(root, hooks), readFileSync(join(root, hooks), "utf8").replace("hooks/pre-tool-use.sh", "hooks/gone.sh"));
    expect(problems(root)).toEqual([expect.stringContaining("hooks/gone.sh does not exist")]);
    const text = readFileSync(join(root, manifest), "utf8");
    writeFileSync(join(root, manifest), text.replace('"name": "pstack"', '"name": "other"'));
    expect(problems(root)).toEqual([
      expect.stringContaining(`${manifest}: name "other"`),
      expect.stringContaining("hooks/gone.sh does not exist"),
    ]);
  });

  test("problems reports a hook path that resolves outside the plugin, through .. or through a symlink", () => {
    const root = repoCopy();
    const hooks = "plugins/pstack/hooks/hooks.json";
    const text = readFileSync(join(root, hooks), "utf8");
    writeFileSync(join(root, hooks), text.replace("hooks/session-start.sh", "../../tools/generate.mjs"));
    expect(problems(root)).toEqual([expect.stringContaining("../../tools/generate.mjs does not exist in the plugin")]);
    const outside = join(scratch("pstack-outside-"), "start.sh");
    writeFileSync(outside, "#!/bin/sh\n", { mode: 0o755 });
    symlinkSync(outside, join(root, "plugins/pstack/hooks/linked.sh"));
    writeFileSync(join(root, hooks), text.replace("hooks/session-start.sh", "hooks/linked.sh"));
    expect(problems(root)).toEqual([expect.stringContaining("hooks/linked.sh does not exist in the plugin")]);
  });

  test("problems reports a root with no plugin directory, down to the last check, and does not throw", () => {
    expect(problems(scratch("pstack-empty-"))).toContainEqual(expect.stringContaining("plugins/pstack/hooks/hooks.json"));
  });
});
