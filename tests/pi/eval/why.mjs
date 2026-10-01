// `why` on a zustand clone: zustand/traditional came in c6900a4 "feat: deprecate
// equalityFn and add createWithEqualityFn (#1945)", whose body defers to RFC
// discussion #1937 for the rationale.
// The sheet puts the two roles on different models so each spawn's role line
// is observable.
import { agentPrompt, MINUTE, readPiTools, sessionModels, settled } from "../eval-lib.mjs";

const CATEGORIES = [
  ["source control", /source control|git history/i],
  ["issue tracker", /issue|ticket/i],
  ["long-form documents", /long-form|documents?\b/i],
  ["team chat", /chat/i],
  ["infrastructure observability", /observability/i],
  ["error tracking", /error|exception/i],
  ["product analytics", /analytics|warehouse/i],
];

export default {
  name: "why",
  repo: "zustand",
  sheet: "why investigators: sonnet\nwhy synthesizer: fable\n",
  drive: (w, { piPrint }) =>
    piPrint(
      w,
      "/skill:why Why does createWithEqualityFn live in its own zustand/traditional entry point (src/traditional.ts) " +
        "instead of create from zustand taking an equality function?",
      { timeoutMs: 30 * MINUTE },
    ),
  checks({ w, run, t }) {
    const rs = [...t.records].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
    const synth = rs.length > 1 ? rs.at(-1) : undefined;
    const investigators = rs.slice(0, -1);
    const firstSpawn = Math.min(...rs.map((r) => Date.parse(r.startedAt)));
    // An agent's output reaches the lead as its first completion notice, or as
    // the result of a foreground agent call; later notices come from resumes the
    // lead's own send_message calls start.
    const findingsAt = (r) =>
      Math.min(
        ...t.parent.filter((e) => e.type === "custom_message" && e.customType === "pstack-agent" && String(e.content).includes(`agentId: ${r.id}`)).map((e) => Date.parse(e.timestamp)),
        ...t.calls(t.parent).filter((c) => c.name === "agent" && c.output.includes(`agentId: ${r.id}`)).map((c) => c.resultAt),
      );
    const anchored = t.calls(t.parent).some((c) => c.name === "bash" && /\bgit\b[^|;&]*\b(log|blame|show)\b/.test(String(c.args.command)) && c.resultAt <= firstSpawn);
    const spawns = t.calls(t.parent).filter((c) => c.name === "agent");
    const realSha = (text) =>
      (text.match(/\b[0-9a-f]{7,40}\b/g) ?? []).some((sha) => {
        try {
          return w.git("cat-file", "-t", sha) === "commit";
        } catch {
          return false;
        }
      });
    const carriesAnchor = (r) => /traditional\.ts/.test(agentPrompt(t, r)) && realSha(agentPrompt(t, r));
    // The answer is the lead's last message with the output format's Sources Consulted section.
    const presented = t.texts(t.parent).findLast((x) => /sources consulted/i.test(x.text));
    const answer = presented?.text ?? "";
    const sources = answer.split(/sources consulted/i)[1] ?? "";
    return [
      ["pi exited 0 and settled", run.status === 0 && settled(run)],
      ["the lead read pi-tools.md", readPiTools(t)],
      ["the lead read git history for the code anchor before spawning", rs.length > 0 && anchored],
      ["one source-control investigator, since the world has no MCP servers", investigators.length === 1],
      ["one synthesizer started after every investigator's findings reached the lead", Boolean(synth) && investigators.every((r) => findingsAt(r) < Date.parse(synth.startedAt))],
      ["the synthesizer got the synthesizer prompt", Boolean(synth) && /synthes/i.test(agentPrompt(t, synth))],
      ["every agent was general-purpose with readonly off", rs.length > 0 && rs.every((r) => r.subagentType === "general-purpose" && r.readonly !== true)],
      ["every agent was a background agent call", spawns.length === rs.length && spawns.every((c) => c.args.run_in_background === true)],
      ["investigators ran on the why investigators line's model", investigators.length > 0 && investigators.every((r) => r.model === w.models.get("sonnet"))],
      ["the synthesizer ran on the why synthesizer line's model", synth?.model === w.models.get("fable")],
      ["each agent's session used its own model", rs.length > 0 && rs.every((r) => JSON.stringify(sessionModels(t, r)) === JSON.stringify([r.model]))],
      ["every agent completed", rs.length > 0 && rs.every((r) => r.status === "completed")],
      ["every agent's prompt carried the code anchor (file and real commits)", rs.length > 0 && rs.every(carriesAnchor)],
      ["nothing was edited and the tree is clean", !t.allCalls().some((c) => c.name === "edit" || c.name === "write") && w.git("status", "--porcelain") === ""],
      ["the answer came after the synthesizer's output reached the lead", Boolean(synth) && Boolean(presented) && presented.at > findingsAt(synth)],
      ["the answer cites c6900a4 / PR #1945 or the RFC it fixes, discussion #1937", /\bc6900a4|#1945\b|#1937\b|discussions\/1937\b/.test(answer)],
      ["Sources Consulted names all seven evidence categories", CATEGORIES.every(([, re]) => re.test(sources))],
    ];
  },
};
