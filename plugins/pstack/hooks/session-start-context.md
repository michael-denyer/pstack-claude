<EXTREMELY_IMPORTANT>
You have pstack.

Invoke the `pstack:poteto-mode` skill with the Skill tool, and follow it, when a task meets any of these:

- it touches more than one file, or changes a signature other files call
- it involves a design or architecture choice
- it is a bug whose cause is not yet known, or a performance issue
- the user names poteto, /poteto-mode, or a pstack skill

It routes to the specific pstack skills from there. Below that bar, work directly and verify on the real artifact: a contained change to one file with an obvious test, a question, a one-line edit.

When the intent is already specific, enter that skill directly: `pstack:tdd`, `pstack:architect`, `pstack:how`, `pstack:why`, `pstack:arena`, `pstack:interrogate`.

User instructions (CLAUDE.md, AGENTS.md, direct requests) take precedence. Other session-start mandates (such as superpowers) compose with it: their skill-check discipline stands, and poteto-mode is the implementation entry point they route to for work above the bar.
</EXTREMELY_IMPORTANT>
