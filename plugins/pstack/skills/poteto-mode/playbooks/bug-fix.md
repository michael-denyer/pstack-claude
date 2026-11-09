### Bug fix

**You own this task. Plan, review, verify.** Delegate investigation and the fix to subagents, stay in the lead. Pick each subagent's reasoning level for the job, per the Subagents section.

Be scientific. Every shipped line traces to runtime evidence. Belt-and-suspenders that "might help" is a hypothesis, not a fix. It does not ship. When evidence refutes a hypothesis, revert what it motivated. The smallest change the evidence justifies ships, nothing more.

Before the fan-out in steps 2–3, check the [focused-fix exception](#focused-fix-exception). Select known non-sensitive fields before printing diagnostic configuration or service responses; do not dump whole configurations or environments.

1. Reproduce it yourself on the matching surface via the driver skill (Non-negotiables), even when a debug or instrumentation protocol says to ask the user to reproduce. Ask the user only with a stated, specific reason the control surface cannot reach the target, and only after driving it as far as it goes. If it won't reproduce directly, synthesize the trigger, tighten conditions, or instrument until it fires.
2. Binary-search the cause. Form the candidate hypotheses, then rule them out until one survives. Seed them with `how` over the affected subsystem and the **why** skill for regression history. Each pass, take the split that cuts the most remaining problem space, get runtime evidence, eliminate. When program state is unclear, add instrumentation or logging and read it as the code runs. Don't guess. Drive a long or stubborn hunt with Claude Code's `loop` skill. Confirm the surviving *mechanism* with runtime evidence before the step-3 architect/interrogate fan-out.
3. Plan the fix. If it crosses a function boundary, `architect` first. Delegate implementation to a subagent using your configured bug-fix model (default in poteto-mode's Models section) with a specific scope.
4. Verify on the same surface. The original repro now passes. "Inconclusive" or wrong-surface is not a pass. Flag it. Unit tests show branch behavior, not bug absence.
5. Stage the commits so the failing repro lands before the fix in git history. See the **tdd** skill for the failing-test-first cadence when the bug has a cheap local test path. Skip it when the test would be expensive, integration-heavy, or unclear.
   This is the canonical **sequence-verifiable-units** principle skill, the failing test first and the fix on top.
6. Run **Opening a PR**.

**Reply:** what was broken, root cause, fix, how you verified. Quote the decisive failing and passing output, trimmed to the assertion and the counts.

When publication or deployment is part of the task, also state what code was fixed and verified, what was published, what version and behavior the affected runtime actually served (through the authenticated path when relevant), and any blocker with the next action needed to resolve it. Missing or contradictory runtime evidence leaves the incident unresolved, even after a successful publication. Remove credentials and customer data from quoted evidence.

#### Focused-fix exception

One scoped bug-fix delegate may investigate the reproduced failure with a focused code and local-history read before invoking `how` or `why`. Skip those skills and step 3's `architect`, even across a function boundary, only when all of these hold:

- Runtime evidence establishes the cause in one subsystem.
- The correction preserves interfaces and state semantics, with no signature, ownership, schema, migration, authentication, authorization, concurrency, transaction, or deployment/routing change.
- A cheap regression check exercises the failure under the relevant runtime settings, and verification on the original surface is available.
- No competing design or contradictory evidence remains.

Record the evidence for these conditions in the existing checklist before the skip. The delegate implements the scoped fix; the lead still plans, reviews the diff, and verifies it. If any condition is false or remains unknown after the focused pass, or later evidence invalidates it, return to steps 2–3 without the exception. Every other step and any required independent review remain in force. Patch size alone never qualifies a fix.
