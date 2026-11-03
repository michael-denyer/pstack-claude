---
name: principle-laziness-protocol
description: "Apply when refactoring, evaluating diff size, or tempted to add abstractions, layers, or signal threading. Bias toward deletion and the smallest change that solves the problem."
user-invocable: false
---

# Laziness Protocol

- **Prefer deletion.** When asked to refactor or improve, look for removals before additions.
- **Maintain a flat call hierarchy.** Avoid deep call chains. A rich interface that hides substantial work is not a deep call chain. If answering a question requires tracing through more than 3 files or layers, flatten it.
- **Consolidate decisions.** Do not repeat the same choice in several places. Put it behind one source of truth and pass the result as a simple flag.
- **Minimize the diff.** Make the smallest change that solves the problem. Fewer lines beat "elegant" boilerplate.
- **Question the threading.** If a task asks you to pass a new signal through types, schemas, or pipelines, stop and look for a more direct path.
