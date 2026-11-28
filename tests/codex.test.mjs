// Codex mapping contract: codex-tools.md names the Claude-specific terms the
// skills use.
import { RUNTIMES } from "../tools/runtimes.mjs";
import { mappingCoverage } from "./mapping-coverage.mjs";

mappingCoverage(RUNTIMES.find((runtime) => runtime.name === "Codex"), [
  ["claude-project-dir.mjs", "`claude-project-dir.mjs`"],
  ["~/.claude/orchestrate", "`~/.claude/orchestrate/<slug>/`"],
]);
