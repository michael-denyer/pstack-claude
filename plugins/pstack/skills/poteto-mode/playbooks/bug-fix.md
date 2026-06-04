### Bug fix

**You own this task. Plan, review, verify.** Delegate investigation and the fix to subagents; stay in the lead.

Be scientific. Every shipped line traces to the runtime evidence that proved it necessary. Belt-and-suspenders that "might help" is a hypothesis, not a fix; it does not ship. When evidence refutes a hypothesis, revert the changes it motivated before moving on rather than letting them ride "just in case". The smallest change the evidence justifies ships, nothing more. Same discipline for Perf, where the evidence is the trace.

1. Reproduce it yourself on the matching surface via the driver skill from Non-negotiables (`run` for CLIs/TUIs, `verify` for UIs). Do not hand the repro to the user. A debug or instrumentation protocol that says to ask the user to reproduce does not override this; you drive the instrumented runtime through the driver skill. Ask the user only with a stated, specific reason the driver cannot reach the target, and only after driving it as far as it goes.
2. `how` over the affected subsystem for the root cause; don't paper over symptoms. the **why** skill for regression history. Confirm the *mechanism* with runtime evidence before the step-3 architect/interrogate fan-out; a design grounded on a plausible-but-unconfirmed cause can be unanimously wrong while the real cause sits one subsystem over.
3. Plan the fix. If it crosses a function boundary, `architect` first. Delegate implementation to a `claude-sonnet-4-6` subagent with a specific scope; review the diff.
4. Verify on the same surface; the original repro now passes. "Inconclusive" or wrong-surface is not a pass; flag it. Unit tests show branch behavior, not bug absence.
5. Stage the commits so the failing repro lands before the fix in the git history; the diff tells the story. See the **tdd** skill for the failing-test-first cadence when the bug has a cheap local test path; skip it when the test would be expensive, integration-heavy, or unclear.
6. Run **Opening a PR**.

Investigation fans out `how` + `why` as parallel subagents.

**Reply:** what was broken, root cause, fix, how you verified. Paste failing-then-passing repro output verbatim.
