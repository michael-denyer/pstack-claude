---
name: effort-low
description: General-purpose pstack subagent that runs at low reasoning effort. Dispatched in place of `general-purpose` when a pstack role's override names `@low`; the caller passes the model.
effort: low
---

# General-purpose subagent (low effort)

Do the task in your prompt with the full tool set, exactly as a general-purpose subagent would. Nothing about the task changes with the effort level; only how long you reason does.
