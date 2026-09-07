// Unit tests for the generator's pure functions: the region model that stamps
// model policy into skills, the version stamp, and the validators. The
// end-to-end contract (regenerate, then git diff --exit-code) lives in CI.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  applyRegions,
  assertChangesHeading,
  fenceUnder,
  promptStub,
  publicSkills,
  readmeCommands,
  regions,
  section,
  stampVersion,
  strayModelSlugs,
  tableRows,
  validateCodexMarketplace,
  validateHooks,
} from "../tools/generate.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const models = JSON.parse(readFileSync(join(repoRoot, "plugins/pstack/models.json"), "utf8"));

const lines = (text) => text.split("\n");

describe("locators", () => {
  test("section spans from the heading to the next ## heading", () => {
    const doc = lines("# T\n\n## Models\n\nold\n\n## Next\nx");
    expect(section("Models")(doc)).toEqual([3, 6]);
    expect(section("Next")(doc)).toEqual([7, 8]);
    expect(section("Absent")(doc)).toBeNull();
  });

  test("fenceUnder spans the inside of the first matching fence after the heading", () => {
    const doc = lines("### 5. Write the override sheet\n\ntext\n```markdown\na\nb\n```\nafter");
    expect(fenceUnder("### 5. Write", "markdown")(doc)).toEqual([4, 6]);
    expect(fenceUnder("### 5. Write", "yaml")(doc)).toBeNull();
    expect(fenceUnder("### 9.", "markdown")(doc)).toBeNull();
    expect(fenceUnder("### 5. Write", "markdown")(lines("### 5. Write\n```markdown\nunclosed"))).toBeNull();
  });

  test("tableRows spans the consecutive rows with the prefix after the separator", () => {
    const doc = lines("| Subagent | Default model |\n| --- | --- |\n| Reviewer A | x |\n| Reviewer B | y |\n\ntext");
    expect(tableRows("| Subagent | Default model |", "| Reviewer ")(doc)).toEqual([2, 4]);
    expect(tableRows("| Other |", "|")(doc)).toBeNull();
  });
});

describe("regions", () => {
  test("every skill in models.json owns exactly one stamped region", () => {
    const skills = new Set(models.roles.map((r) => r.skill));
    for (const skill of skills) {
      const owned = regions(models).filter((r) => r.file === `plugins/pstack/skills/${skill}/SKILL.md`);
      expect(owned).toHaveLength(1);
    }
  });

  test("applyRegions stamps in place and is idempotent", () => {
    const file = "plugins/pstack/skills/how/SKILL.md";
    const text = "# how\n\n## Models\n\nstale\n\n## After\nkeep\n";
    const once = applyRegions(file, text, models);
    expect(once).not.toContain("stale");
    expect(once).toContain("## After\nkeep\n");
    expect(once).toContain("- how explorer:");
    expect(applyRegions(file, once, models)).toBe(once);
  });

  test("applyRegions throws when an owned file lost its anchor", () => {
    expect(() => applyRegions("plugins/pstack/skills/how/SKILL.md", "# how\n\nno section\n", models)).toThrow(
      "plugins/pstack/skills/how/SKILL.md: no anchor for the Models section to stamp",
    );
  });

  test("applyRegions leaves a file the generator does not own untouched", () => {
    const text = "# other\n\n## Models\n\nprose\n";
    expect(applyRegions("plugins/pstack/skills/other/SKILL.md", text, models)).toBe(text);
  });
});

describe("strayModelSlugs", () => {
  test("a slug inside an owned region is exempt", () => {
    const file = "plugins/pstack/skills/how/SKILL.md";
    const text = applyRegions(file, "# how\n\n## Models\n\nx\n", models);
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
    const text = applyRegions(file, "# how\n\n## Models\n\nx\n\n## Setup\n\nPrefer claude-sonnet-4-6.\n", models);
    const strays = strayModelSlugs(file, text, models);
    expect(strays).toHaveLength(1);
    expect(strays[0]).toContain("Prefer claude-sonnet-4-6.");
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
  test("accepts a bare or suffixed heading and rejects a missing one", () => {
    expect(() => assertChangesHeading("## 0.9.1\n", "0.9.1")).not.toThrow();
    expect(() => assertChangesHeading("## 0.9.1 - title\n", "0.9.1")).not.toThrow();
    expect(() => assertChangesHeading("## 0.9.10 - title\n", "0.9.1")).toThrow('no "## 0.9.1" heading');
  });
});

describe("validateCodexMarketplace", () => {
  const manifest = (plugins) => JSON.stringify({ plugins });
  test("needs one entry whose name matches and whose path exists", () => {
    const ok = { name: "pstack", source: { path: "./plugins/pstack" } };
    expect(() =>
      validateCodexMarketplace(manifest([ok]), { expectedName: "pstack", pathExists: () => true }),
    ).not.toThrow();
    expect(() => validateCodexMarketplace(manifest([]), { expectedName: "pstack", pathExists: () => true })).toThrow(
      "expected 1 plugin entry, found 0",
    );
    expect(() =>
      validateCodexMarketplace(manifest([{ ...ok, name: "other" }]), { expectedName: "pstack", pathExists: () => true }),
    ).toThrow('plugin name "other" != Codex manifest name "pstack"');
    expect(() => validateCodexMarketplace(manifest([ok]), { expectedName: "pstack", pathExists: () => false })).toThrow(
      "does not resolve to a directory",
    );
  });
});

describe("validateHooks", () => {
  const hooks = (command) =>
    JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command }] }] } });
  const exec = { mode: 0o755 };
  const plain = { mode: 0o644 };

  test("accepts an executable script under the plugin root", () => {
    const statOf = (rel) => (rel === "hooks/session-start" ? exec : null);
    expect(() => validateHooks(hooks('"${CLAUDE_PLUGIN_ROOT}/hooks/session-start"'), { statOf })).not.toThrow();
  });

  test("names a missing or non-executable target", () => {
    expect(() => validateHooks(hooks('"${CLAUDE_PLUGIN_ROOT}/hooks/nope"'), { statOf: () => null })).toThrow(
      "SessionStart: hooks/nope does not exist",
    );
    expect(() => validateHooks(hooks('"${CLAUDE_PLUGIN_ROOT}/hooks/session-start"'), { statOf: () => plain })).toThrow(
      "hooks/session-start is not executable",
    );
  });

  test("rejects a command that does not go through the plugin root", () => {
    expect(() => validateHooks(hooks("cat /etc/motd"), { statOf: () => exec })).toThrow(
      "does not reference ${CLAUDE_PLUGIN_ROOT}",
    );
  });
});

describe("readmeCommands", () => {
  const readme = (rows) => `# R\n\n| command | use it when |\n| --- | --- |\n${rows.join("\n")}\n\nafter\n`;

  test("reads name and menu text in row order", () => {
    const text = readme(["| `/b` | second thing |", "| `/a` | first thing |"]);
    expect(readmeCommands(text, ["a", "b"])).toEqual([
      { name: "b", menu: "second thing" },
      { name: "a", menu: "first thing" },
    ]);
  });

  test("names a skill without a row and a row without a skill", () => {
    expect(() => readmeCommands(readme(["| `/a` | x |", "| `/gone` | y |"]), ["a", "new"])).toThrow(
      "row without a skill: gone; skill without a row: new",
    );
  });

  test("rejects a malformed row and a missing table", () => {
    expect(() => readmeCommands(readme(["| /a | x |"]), ["a"])).toThrow("row 1 is not");
    expect(() => readmeCommands("# R\n\nno table\n", ["a"])).toThrow("table header not found");
  });

  test("the live README names exactly the public skills", () => {
    const text = readFileSync(join(repoRoot, "README.md"), "utf8");
    const rows = readmeCommands(text, publicSkills(join(repoRoot, "plugins/pstack/skills")));
    expect(rows[0].name).toBe("poteto-mode");
    for (const row of rows) expect(promptStub(row)).toContain(`description: ${row.menu}\n`);
  });
});
