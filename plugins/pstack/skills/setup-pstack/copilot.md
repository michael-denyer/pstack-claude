# Setup pstack on GitHub Copilot

On GitHub Copilot this file replaces the model, effort, and hook questions in steps 1, 3, and 4 of [setup-pstack](SKILL.md) and the sheet header in step 6. Steps 2, 5, 7, and 8 still apply. pstack ships no Copilot model defaults, so every model in the sheet comes from the user's answers.

Run setup on a model at least as strong as gpt-5.4-mini or a Sonnet-class Claude model. On a Haiku-class model, setup picked models the user never chose in about half of the smoke runs.

## Asking

Copilot's `ask_user` takes one question per call with a fixed choice list. That list is a `choices` list, or one `oneOf` string property of a `requestedSchema` where `ask_user` takes an elicitation form. Its UI adds a free-text option on its own. Treat it as single-select, because the Copilot app's `ask_user` has no multi-select. Ask every model question through `ask_user` with a `choices` list. Never ask for models as one open question, such as which roles should change and to what, and never bundle two questions into one call. Emulate multi-select with sequential single-select questions, as the panel slots below do.

- Do not propose, pre-select, or label any model `(Recommended)`. A first setup has no default to recommend.
- On a re-run, put step 2's saved value for the question first, labeled `(current)`. Picking it keeps that value.
- A typed answer counts only when it is a detected model ID or `inherit-parent`; otherwise ask the same question again.
- An answer the user already gave in the request counts. Ask only the questions it leaves open.
- When `ask_user` is not available (a `-p` run, or `--no-ask-user`) and a model question is still open, do not choose for the user and do not write the sheet. Tell the user to run `setup-pstack` in an interactive session, and run this session's roles as `inherit-parent`.

## Current state and writing

On Copilot, step 2's saved values are the saved pstack model choices the plugin hook put in context. When the context says this Copilot home has no pstack model sheet yet, there are none. Read the sheet only when neither is in context, as in a skills-only install. Do not test for the sheet or its directory with `bash`. Each such command touches a path outside the workspace and asks for access. `${COPILOT_HOME:-~/.copilot}` exists whenever Copilot runs. Write the sheet in one tool call, so the write asks for path access at most once. Use `create` for a new sheet. Replace a saved one with a single `bash` heredoc in exactly this form, with the absolute sheet path in single quotes and the sheet text between the lines:

```sh
cat > '/absolute/path/to/pstack-models.md' <<'EOF'
# pstack model configuration
...
EOF
```

The plugin's PreToolUse hook checks the sheet text in a `create`, an `edit`, or that heredoc before it runs. It denies a write that drops one of the 17 roles, holds an entry that is not `inherit-parent`, `auto`, or a model ID, or leaves a panel with models from fewer than two vendors without the `panel vendors: any` line. When it denies a write, fix the text its reason names and write the whole sheet again. Do not route around it with another command.

## Sheet header

A Copilot sheet uses step 6's role lines and settings under this header in place of step 6's paragraph, because every role keeps a line and the hook checks that:

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

## Question sequence

Ask in this order. Each model question is the vendor and model pair above; every other question is one `ask_user` call.

1. **Default model.** "Default model: runs feature and refactoring work, judgment and prose, the how explorer and explainer, the why investigators and synthesizer, reflect, and swarm workers." It writes `feature, refactoring`, `judgment and prose`, `how explorer`, `how explainer`, `why investigators`, `why synthesizer`, `reflect tooling`, `reflect judgment, divergent, synthesizer`, and `swarm workers`.
2. **Strongest model.** "Strongest model: runs bug-fix, perf-issue, hillclimb, and strongest judgment." It writes `bug-fix`, `perf-issue`, `hillclimb`, and `strongest judgment`.
3. **Panel model 1 of 3**, then **panel model 2 of 3**, then **panel model 3 of 3**, as three separate questions. "Panel model N of 3: panels run one subagent per model, and models from different vendors catch different mistakes." In slots 2 and 3, list the vendors not yet in the panel first, then the rest, then `inherit-parent`. Do not offer a model already in the panel.
4. **More panel models.** "Add a 4th panel model?" with `Done` as the first choice and `Add a 4th` second. Adding asks one more slot the same way, then asks again for a 5th. Stop offering at 5 models.
5. **Vendor check.** When the panel's model IDs, not counting `inherit-parent`, all come from one vendor and more than one vendor is detected, ask "The panel is single-vendor (Claude), so its cross-checks share blind spots." with `Pick the panel again` and `Keep it anyway`. Picking again returns to panel model 1. `Keep it anyway` writes the line `panel vendors: any` after the `session hook` line. When only one vendor is detected, skip this question, write `panel vendors: any`, and say in step 8 that the panel's diversity is reduced. A panel of only `inherit-parent` needs no check.
6. **Overrides.** "Override any individual role?" with `No, write the sheet (Recommended)` first, then one choice per group: `feature, refactoring`, `judgment and prose`, `how explorer and explainer`, `why investigators and synthesizer`, `reflect roles`, `swarm workers`, `bug-fix, perf-issue, hillclimb`, `strongest judgment`, and `a panel role`. Show each group's value in its label, as `swarm workers (<its model ID>)`. A group asks one model as in [Choosing one model](#choosing-one-model), with its value first as `(current)`, and writes that value to every role in the group. `a panel role` first asks which of `arena runners`, `arena cross-judge pool`, `architect runners`, and `interrogate reviewers`, then asks that list's slots as in questions 3 through 5. After each override, ask this question again, until the answer is `No, write the sheet`.
7. **Session hook.** "Keep the session hook that routes tasks to poteto-mode?" with `On (default)` and `Off`. On a re-run, the saved value comes first as `(current)`.
8. **Default effort.** "Default reasoning effort for pstack subagents?" with `session (keep the parent's effort)` first, then `low`, `medium`, `high`, `xhigh`, and `max`. It writes the `default effort` line. On a re-run, the saved value comes first as `(current)`. Ask no per-role effort; a saved `@<level>` suffix on a role value stays as written.

The panel from questions 3 through 5 writes `arena runners`, `arena cross-judge pool`, `architect runners`, and `interrogate reviewers`, in slot order. On a re-run, the saved value for question 1 is the `feature, refactoring` line, for question 2 the `bug-fix` line, and for panel model N the Nth entry of `arena runners`. A role whose saved value differs from its question's saved value keeps it, and question 6 shows it.

Then validate and write the sheet as steps 5 and 6 describe, and show the written role lines in step 8.
