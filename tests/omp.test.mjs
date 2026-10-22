// The OMP build is a shared-skills runtime: a mapping file, install docs, and
// native model roles. These checks keep the mapping honest and stop a copy of
// another runtime's tool or model names from creeping in.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const mappingPath = "plugins/pstack/skills/poteto-mode/references/omp-tools.md";
const mapping = readFileSync(join(repoRoot, mappingPath), "utf8");
const potetoMode = readFileSync(join(repoRoot, "plugins/pstack/skills/poteto-mode/SKILL.md"), "utf8");

describe("OMP mapping", () => {
  test("poteto-mode's Platform Adaptation points at it once", () => {
    expect(potetoMode).toContain("On OMP, read [`references/omp-tools.md`](references/omp-tools.md) instead.");
  });

  test("the mapping carries the required sections", () => {
    for (const heading of ["## Tool actions", "## Task contract", "## Subagent policy", "## Models", "## `/loop`", "## Skills and paths", "## Session routing", "## Per-skill notes"]) {
      expect(mapping).toContain(heading);
    }
  });

  test("the mapping names OMP's native tools and task shape", () => {
    for (const term of ["`read`", "`write`", "`edit`", "`bash`", "`eval`", "`grep`", "`glob`", "`task`", "`ask`", "`todo`", "`wait`", "`web_search`", "`history://`", "`agent://`", "`solutionSpace`", "`context`"]) {
      expect(mapping).toContain(term);
    }
  });

  test("OMP's native model roles are the stated authority", () => {
    expect(mapping).toContain("`modelRoles` and `task.agentModelOverrides`");
    expect(mapping).toContain("A pstack model sheet, the Codex model panel, and per-call task `model` fields are not OMP inputs.");
    expect(mapping).toContain("Do not put a `model` field in a normal task item.");
  });

  test("the mapping does not hard-code a user's home directory", () => {
    expect(mapping).not.toMatch(/\/Users\/[^<]/);
    expect(mapping).not.toMatch(/\/home\/[^<]/);
  });

  test("the install docs and the setup skill name the OMP path", () => {
    const readme = readFileSync(join(repoRoot, "README.md"), "utf8");
    const reference = readFileSync(join(repoRoot, "docs/reference.md"), "utf8");
    const setup = readFileSync(join(repoRoot, "plugins/pstack/skills/setup-pstack/SKILL.md"), "utf8");
    for (const text of [readme, reference, setup]) expect(text).toContain("references/omp-tools.md");
    expect(readme).toContain('<a id="omp"></a>');
    expect(reference).toContain("### OMP");
    expect(setup).toContain("| OMP |");
  });
});
