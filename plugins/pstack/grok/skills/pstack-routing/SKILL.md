---
name: pstack-routing
description: On every task, read pstack's poteto-mode skill first and follow its routing instructions when applicable. The user can disable pstack in Grok's plugin settings.
---

# Pstack routing for Grok Build

Read the plugin's `skills/poteto-mode/SKILL.md` and follow its routing instructions when applicable. Grok Build exposes plugin skill paths in the session's skills list. Use `read_file` to open the poteto-mode path listed there.

Grok Build passes skill descriptions to the model. This instruction depends on the model following that description; it is not a guaranteed session-start injection.
