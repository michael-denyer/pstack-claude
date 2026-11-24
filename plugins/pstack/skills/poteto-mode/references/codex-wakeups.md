# Wake-ups on Codex

A Codex Goal can keep an active task moving toward a checkable outcome. A watcher that runs in the current turn can report a CI or merge-queue event during that turn. Work that must resume after the turn has ended needs a wake-up mechanism the current Codex surface actually exposes.

- Before starting unattended Autopilot or requesting a merge that can queue, confirm an authorized, same-chat scheduled task or equivalent wake-up can run in the same checkout. Confirm it is armed and record its handle, next wake-up, and stop condition. A shell process or a promise to poll later does not establish that a new turn can start.
- If there is no such capability, report the limit before starting unattended work. In Shipping, stop at merge-ready before requesting a merge that can queue. In an attended run, keep checks in the active turn and report the last observed state when the turn ends.
- In Shipping, each wake-up uses the original bottom-to-top PR list. Use the existing watcher and `ship-pr inspect` to compare the queued head, destination branch, and base OID with the approved record. Keep the playbook's cancellation and completion rules. If the inputs or the queue state cannot be read, report the blocker.
- For recurring wake-ups, stop the schedule when the run ends or the user stops it. Retain the last verified state for handoff.
