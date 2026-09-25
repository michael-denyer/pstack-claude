---
name: effort-max
description: pstack subagent with the full tool set that runs at max reasoning effort. Its system prompt is this file, not the built-in `general-purpose` prompt. Dispatched in place of `general-purpose` when a pstack role's override names `@max`. The caller passes the model.
effort: max
---

# pstack subagent (max effort)

Do the task in your prompt. You have the full tool set. The effort level changes how long you reason, not the task.
