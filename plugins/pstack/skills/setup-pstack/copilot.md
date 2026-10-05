# Setup pstack on GitHub Copilot

On GitHub Copilot this file replaces the model, effort, and hook questions in steps 1, 3, and 4 of [setup-pstack](SKILL.md), the sheet header in step 6, and step 7. Steps 2, 5, 8, and 9 still apply. pstack ships no Copilot model defaults, so every model in the sheet comes from the user's answers. Never pick a model the user has not chosen, and never write the Claude Code names in [Models](SKILL.md#models) or step 6's values into a Copilot sheet.

Run setup on a model at least as strong as gpt-5.4-mini or a Sonnet-class Claude model. On a Haiku-class model, setup picked models the user never chose in about half of the smoke runs.

## Asking

Copilot's `ask_user` takes one question per call with a fixed choice list. That list is a `choices` list, or one `oneOf` string property of a `requestedSchema` where `ask_user` takes an elicitation form. Its UI adds a free-text option on its own. Treat it as single-select, because the Copilot app's `ask_user` has no multi-select. Ask every model question through `ask_user` with a `choices` list. Never ask for models as one open question, such as which roles should change and to what, and never bundle two questions into one call. Emulate multi-select with sequential single-select questions, as the panel slots below do.

- Do not propose, pre-select, or label any model `(Recommended)`. A first setup has no default to recommend.
- On a re-run, put step 2's saved value for the question first, labeled `(current)`. Picking it keeps that value.
- A typed answer counts only when it is a detected model ID or `inherit-parent`; otherwise ask the same question again.
- An answer the user already gave in the request counts. Ask only the questions it leaves open.
- When `ask_user` is not available (a `-p` run, or `--no-ask-user`) and a model question is still open, do not choose for the user and do not write the sheet. Tell the user to run `setup-pstack` in an interactive session, and run this session's roles as `inherit-parent`.

## Current state

On Copilot, step 2's saved values are the role lines the plugin hook put in context. When the context says this Copilot home has no pstack model sheet yet, or that the sheet is invalid, there are none. Read the sheet only when none of these is in context, as in a skills-only install. Do not test for the sheet or its directory with `bash`. Each such command touches a path outside the workspace and asks for access. `${COPILOT_HOME:-~/.copilot}` exists whenever Copilot runs, so do not create it.

## Sheet header

A Copilot sheet uses step 6's role lines and settings under this header in place of step 6's paragraph, because every role keeps a line and `check-sheet.sh` checks that:

```markdown
# pstack model configuration

Per-role model choices for pstack skills on GitHub Copilot, written by setup-pstack. Every role keeps its line; rerun setup-pstack to change one. A value of `inherit-parent` or `auto` runs that role on the parent session's model (the `task` call omits `model`); an alias entry in a panel list still counts toward that panel's fan-out. A model may carry a reasoning effort, as in `gpt-5.5 @xhigh` (levels: low, medium, high, xhigh, max), which the `task` call passes as `reasoning_effort`. `default effort` sets the level for a value without one; `session` keeps the parent session's effort. `session hook: off` stops the SessionStart hook from injecting the poteto-mode mandate; any other value, or no line, leaves it on. `panel vendors: any` records that the user kept a panel whose models come from one vendor.
```

## Detect models

The detected set is the `model` enum of the `task` tool, with full IDs exactly as the enum lists them. Never shorten one to a family name. If this session has no `task` tool or its enum is not visible, write `inherit-parent` for every role, skip the model questions, and tell the user to rerun `setup-pstack` in a session with the `task` tool. The Claude Code names in [Models](SKILL.md#models) and the values in step 6's sheet shape are not Copilot model IDs; never write them into a Copilot sheet.

Group the detected IDs by vendor, from each ID's text before its first hyphen. `claude` is Claude, `gpt` is GPT, `gemini` is Gemini, `grok` is Grok, `kimi` is Kimi, and any other ID is Other. Keep the enum's order within a vendor.

## Choosing one model

Each model question below picks one value in two `ask_user` calls, so no choices list holds the whole enum:

1. **Vendor.** One choice per vendor with its model count, such as `GPT (12 models)`, then `inherit-parent (run on the session's model)`. A vendor with a single model shows that model's ID instead, and picking it ends the question.
2. **Model.** That vendor's IDs, then `Back to vendors`.

When the detected set plus `inherit-parent` is 8 choices or fewer, skip the vendor step and list every ID in one question. `auto` means the same as `inherit-parent` in pstack, so it is not a separate choice; a saved `auto` shows as `auto (current)` on a re-run.

## Roles by tier

Each tier question below writes every role in its row. The panel row's roles each take the whole panel list.

| Tier | Roles |
| --- | --- |
| Default | `feature, refactoring`, `judgment and prose`, `how explorer`, `how explainer`, `why investigators`, `why synthesizer`, `reflect tooling`, `reflect judgment, divergent, synthesizer`, `swarm workers` |
| Strongest | `bug-fix`, `perf-issue`, `hillclimb`, `strongest judgment` |
| Panel | `arena runners`, `arena cross-judge pool`, `architect runners`, `interrogate reviewers` |

## Question sequence

Ask in this order. Each model question is the vendor and model pair above; every other question is one `ask_user` call.

0. **Session model.** "Run every pstack role on this session's model?" with `Yes, use the session's model for every role` and `No, choose models by tier`. This is for a plan that offers one model or only automatic selection, and for anyone who wants no per-role choices. On a re-run, put the choice that matches the saved sheet first, labeled `(current)`. Yes skips questions 1 through 6 and the model detection. Set every role line to `inherit-parent`, with three `inherit-parent` entries in each panel role. Ask questions 7 and 8, then say in step 8 that the panels' diversity is reduced and that panel entries can differ only by reasoning effort. This path needs no `panel vendors: any` line, because a panel of only `inherit-parent` needs no vendor check. No answers the questions below.
1. **Default model.** "Default model: runs <the Default row's roles>." It writes every role in the Default row.
2. **Strongest model.** "Strongest model: runs <the Strongest row's roles>." It writes every role in the Strongest row.
3. **Panel model 1 of 3**, then **panel model 2 of 3**, then **panel model 3 of 3**, as three separate questions. "Panel model N of 3: panels run one subagent per model, and models from different vendors catch different mistakes." In slots 2 and 3, list the vendors not yet in the panel first, then the rest, then `inherit-parent`. Do not offer a model already in the panel.
4. **More panel models.** "Add a 4th panel model?" with `Done` as the first choice and `Add a 4th` second. Adding asks one more slot the same way, then asks again for a 5th. Stop offering at 5 models.
5. **Vendor check.** When the panel's model IDs, not counting `inherit-parent`, all come from one vendor and more than one vendor is detected, ask "The panel is single-vendor (Claude), so its cross-checks share blind spots." with `Pick the panel again` and `Keep it anyway`. Picking again returns to panel model 1. `Keep it anyway` writes the line `panel vendors: any` after the `session hook` line. When only one vendor is detected, skip this question, write `panel vendors: any`, and say in step 8 that the panel's diversity is reduced. A panel of only `inherit-parent` needs no check.
6. **Overrides.** "Override any individual role?" with `No, write the sheet (Recommended)` first, then one choice per tier row, with the row's current value in its label, as `Strongest (<its model ID>)`. Picking a row asks which of its roles to change, then asks one model for that role as in [Choosing one model](#choosing-one-model), with its value first as `(current)`. A panel role asks its list's slots as in questions 3 through 5 instead. After each override, ask this question again, until the answer is `No, write the sheet`.
7. **Session hook.** "Keep the session hook that routes tasks to poteto-mode?" with `On (default)` and `Off`. On a re-run, the saved value comes first as `(current)`.
8. **Default effort.** "Default reasoning effort for pstack subagents?" with `session (keep the parent's effort)` first, then `low`, `medium`, `high`, `xhigh`, and `max`. It writes the `default effort` line. On a re-run, the saved value comes first as `(current)`. Ask no per-role effort; a saved `@<level>` suffix on a role value stays as written.

The panel from questions 3 through 5 writes every panel role, in slot order. On a re-run, the saved value for each tier question is the first role in its row, and for panel model N the Nth entry of the first panel role. A role whose saved value differs from its question's saved value keeps it, and question 6 shows it.

## Write and check

Validate as step 5 describes. Copilot's file tools expand neither `~` nor variables, so print the sheet's absolute path with `echo "${COPILOT_HOME:-$HOME/.copilot}/pstack-models.md"` in `bash`, and write the whole sheet to exactly that path in one tool call, so the write asks for path access at most once.

Then run `sh <this skill's directory>/scripts/check-sheet.sh` through `bash`, with the directory's absolute path and no arguments. It checks the Copilot sheet as the plugin hook does at session start: every role has a line, every entry is `inherit-parent`, `auto`, or a model ID with an optional `@<level>`, and each panel names models from two vendors unless the sheet has `panel vendors: any`. It prints `sheet ok`, or `sheet invalid:` and each problem. On `sheet invalid`, fix those lines and write the whole sheet again, then rerun the check. The plugin hook approves the check without a prompt.

For the rest of this session, use the values you just wrote; do not read the sheet back. Later sessions get them from the plugin hook and do not ask again.

## Wire it in

Add no include line: Copilot does not expand `@~/` paths in user instructions, and the plugin hook injects the sheet's role lines at session start. If the hook is on but this session's context lacks the routing mandate (the block that opens `You have pstack.`), another hook or a skills-only install has displaced it. Offer to append this standing instruction to `~/.copilot/copilot-instructions.md` instead:

```text
pstack: for a task that touches more than one file, changes a signature other files call, involves a design choice, or is a bug with an unknown cause or a performance issue, load the poteto-mode skill and follow it. Resolve Claude tool and model names through poteto-mode's references/copilot-tools.md; role models are in ~/.copilot/pstack-models.md.
```
