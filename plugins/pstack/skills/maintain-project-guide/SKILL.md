---
name: maintain-project-guide
description: "Periodic pass that keeps a project guide true to the code. Checks each claim against its source, swaps facts the repo now states for links, confirms changed answers with the user, and ships at most one PR of corrections. Use for /maintain-project-guide or 'update the project guide'."
---

# Maintain a project guide

A guide drifts the moment the code or the product changes. This skill is the upkeep loop for a guide the **create-project-guide** skill wrote, or any project docs the agent instruction file links. The unit of rigor is the claim. Every claim gets checked against its source.

## Outcomes

Pick one, and say which:

- **clean.** Every claim was checked and nothing needs changing. No branch, no PR.
- **changed.** One PR ships the corrections.
- **blocked.** Checking could not finish, or a correction needs an answer the user has not given. Say exactly what blocked it.

## Edit scope

Edit only the guide files and their pointer lines in the agent instruction file. Never edit product code. When the code contradicts the guide, either the guide is stale, the code broke a rule the guide still holds, or the decision changed. Fix the guide only when the evidence shows it is stale. Report the other two to the user.

## Pass

0. **Locate the guide.** Read the project's agent instruction file, `CLAUDE.md` or `AGENTS.md`, and follow its pointer lines. With no guide linked, stop and point at `/create-project-guide` instead of writing one.
1. **Pointer hygiene.** Every pointer resolves to a file, and every guide file has one pointer. Fix dead, missing, and duplicate pointers.
2. **Claim wave.** One read-only subagent per guide file, launched concurrently. For each claim it reads the cited source, finds when the claim's line last changed with `git blame`, and checks whether the source changed after that. It returns each claim as `holds`, `stale` with the evidence, `now in the repo` with the file that states it, `now enforceable` with the check that could hold it, or `no source`. It also lists facts from recent commits that belong in the guide, each with a concrete source path. Subagents never edit files.
3. **Reconcile.** Check every `stale` finding against the code yourself. Don't re-prove claims that hold. Replace each `now in the repo` claim with a link to the file that states it. List `now enforceable` claims for the **correct** skill as a separate change, and keep them in the guide until that check lands. Add the new facts that the sorting table in the **create-project-guide** skill sends to the guide.
4. **Ask the user once.** Collect every user-sourced claim whose code changed, every `no source` claim, and every contradiction from Edit scope. Ask in one batch. Number each question, give your recommended answer, and word it so "yes" accepts it. Under a full-autonomy grant, mark these `unconfirmed` and report them instead of waiting.
5. **Cold-agent check.** Spawn a fresh subagent with the repo and no other context. Ask four or five questions a new contributor needs, drawn from the corrected guide. It must answer from files it reached through the agent instruction file. A wrong or missing answer is a fix in this pass.
6. **Ship or stop.** For changed, re-read every changed file, then open one PR of corrections. For clean or blocked, report the outcome and what was checked, with no PR.

Keep run notes (claims checked, stale claims fixed, questions asked, outcome) in a scratch location. Don't commit them.

**Reply:** the outcome, how many claims were checked and how many held, each correction with its evidence, the claims handed to **correct**, the questions asked and their answers, and the PR link when one shipped.
