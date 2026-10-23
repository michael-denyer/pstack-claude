---
name: create-project-guide
description: "Write down what agents can't learn from the code, such as what the product is for, who uses it, domain terms, limits, and data rules, as short docs linked from the project's agent instruction file. Everything else becomes a check, a link, a decision record, or a runnable skill. Use for /create-project-guide, 'document this project for agents', or when agents keep missing context the code doesn't show."
---

# Create a project guide

Agents relearn a project every session. Most of what they need is already in the repo. Manifests name the stack, the tree shows the structure, and lints and types enforce the conventions. This skill writes down only the rest, puts it where agents load it, and proves a cold agent finds it.

You write for the next agent, which reads the guide cold and mid-task. Every line must change a decision it would otherwise get wrong.

## 1. Sort every fact before writing it

Collect candidate facts from the repo and the user (step 2). Send each to the highest home that holds it. This is the **correct** skill's ladder applied to knowledge.

| The fact | Its home |
| --- | --- |
| The repo already states it, such as the stack, versions, scripts, directory layout, or test runner | Nowhere new. The guide links the manifest or config. |
| A tool could enforce it, such as import boundaries, naming, error shape, status codes, or API naming | A lint, type, or schema check, through the **correct** skill. |
| A short rule for writing code that needs judgment, such as "mock only at the payment gateway" | The agent instruction file, in the **correct** skill's rule table. |
| A procedure, such as build, deploy, roll back, or release | A project-local skill or script the agent runs, shaped like the one the **create-verification-skill** skill writes. |
| A choice among alternatives, such as the API versioning scheme or the primary datastore | A decision record in the project's decisions directory, `docs/adr/` when it has none. |
| Knowledge no tool can hold, such as purpose, users, non-goals, domain terms, invariants types cannot express, external limits, or data policy | Prose, in the guide. |

Only the last row becomes prose. A guide that restates the first row goes stale the day a manifest changes.

## 2. Interview the repo, then the user

Answer from the codebase first. Read the README, manifests, the tree, CI config, existing docs and agent instruction files, recent PRs, and the issue tracker if an MCP reaches it. Run the **how** skill over the subsystems that hold the core domain, for its terms and invariants.

Ask the user only what the repo cannot show. Purpose, target users, goals, non-goals, and data policy usually need them. Ask in one batch. Number each question, give your recommended answer from the repo evidence, and word it so "yes" accepts it. Under a full-autonomy grant, write your recommended answers, mark each `unconfirmed`, and list them in the reply.

## 3. Write the guide

Use the docs directory the project already keeps. Otherwise use `docs/`. Never add a second rules folder beside the agent instruction file.

- **product.md.** Purpose, users, the core workflow, goals, and non-goals. Non-goals stop agents from building what nobody asked for.
- **domain.md.** Each domain term with its meaning in this codebase, and the invariants that types and schemas cannot express. Skip it when an existing glossary covers this.
- **constraints.md.** Limits and policies the code cannot show. Vendor rate limits and quotas, supported platforms, which data is personal and how long it is kept, compliance rules, and versions pinned on purpose with the reason.

Write a file only when it has content. Keep each to one screen. Give every claim its source on the same line, in parentheses, as a file path, a PR or issue number, or `user` and the date for an answer from the user. A claim without a source is a guess, so confirm it or cut it.

## 4. Link it from the agent instruction file

Add one line per guide file to the project's agent instruction file, `CLAUDE.md` or `AGENTS.md`, whichever the project keeps. When it keeps both, add the lines to the one the other includes, or to both. Each line names the file and when to open it. In a monorepo, put a package's lines in that package's instruction file. Agents never open a file nothing links.

Hand the enforceable facts to the **correct** skill and the procedures to a project-local skill, each as its own change. This skill's change holds the guide and the pointer lines only.

## 5. Prove a cold agent finds it

Spawn a fresh subagent with the repo and no other context. Ask it four or five questions a new contributor needs, such as what the product is for, what a domain term means, and which limit a change must respect. It must answer from files it reached through the agent instruction file. A wrong or missing answer means a pointer or the guide failed. Fix it and ask again. Then check that no guide line restates a value a manifest holds.

## 6. Offer the maintenance loop

Point the user at `/maintain-project-guide` for keeping the guide true as the code and the product change. Suggest a cadence only if they ask.

**Reply:** each fact and where it went (guide, check, rule table, procedure, record, or link), the files written, the pointer lines added, the cold agent's answers, and the claims still `unconfirmed`.
