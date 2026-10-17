---
name: principle-guard-the-context-window
description: "Apply before streaming CI output or broad MCP tool discovery, especially with an exact deep link, and when large outputs, long files, repeated reads, or fan-out planning threaten context. Bound output before execution; keep summaries in the main thread."
user-invocable: false
---

# Guard the Context Window

**Why:** Context overflow degrades reasoning quality, creates compression artifacts, and halts progress.

**Pattern:**
- **Size phases and cap scope.** Limit files per phase, set turn budgets, account for mechanism costs.
