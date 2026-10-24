# Compose pstack with OpenSpec

Use this reference when the request or a project rule selects OpenSpec, when the work belongs to an existing OpenSpec change, or when you create one. Otherwise keep the ordinary pstack flow.

## Create a change

Create a change when the work benefits from a durable contract: several tasks, work that spans sessions, or acceptance worth recording. A one-step fix does not need one. Use the installed OpenSpec skills and CLI for the root, the schema, and the artifacts, and read their output instead of assuming paths or artifact names. Write only the artifacts the schema requires. Do not copy OpenSpec workflows into pstack. Never initialize OpenSpec or install skills as a side effect. If OpenSpec is required but unavailable, report that before writing.

For a request to implement, use an installed artifact-creation workflow compatible with continuing to Apply, such as Fast-forward, after reading its instructions. Continue under the original implementation authorization only when that workflow permits it. Stop when the request is planning-only, a project rule requires sign-off, an open question changes the approach or acceptance, or the selected workflow requires a stop. Whenever Propose is invoked, preserve its mandatory stop and wait for a new implementation request. Approving a plan does not authorize implementation.

When Explore runs first, write nothing in it except change artifacts the request or a confirmation covers, and end it by stating its findings. Ending Explore authorizes nothing. Remaining artifacts come through the selected creation workflow. Worktrees, servers, repro scripts, and code come only after that workflow and the request permit implementation.

## Drive the tasks

`tasks.md` is the task list, and its checkboxes are the task state. Repeat until every task is checked:

1. Follow the installed Apply workflow, including its start-of-apply reads. Between tasks, refresh its instructions, context files, task statuses, and source locations. The loop owner selects from those refreshed pending tasks under step 2.
2. Take an unchecked task whose explicit dependencies and natural prerequisites in `tasks.md` are complete. When more than one task is ready, file order breaks ties. Independent ready tasks may run in parallel under the existing delegate and worktree rules.
3. Do the work the task names with the matching playbook steps that apply to it, including a keep-or-revert decision about that task's own change, and run the task's own check. Preserve incremental commits and committed-base worktree rules. A playbook step that another task names runs in that task. Change-level steps, such as review and same-surface verification no task names, are not repeated per task. Rerun any check whose evidence a later fix invalidates. Defer only PR publication and delivery to closure.
4. Check the task's box only after its verification passes on the real artifact. If its evidence later fails, uncheck the box and say why.

Closure triggers from Opening a PR and poteto-mode's Non-negotiables apply to every commit and to landing, including the owner's own commits and a delegate's. Invoke `/deslop` before each code commit. The owner and every committing delegate invoke `/technical-writing` and `/unslop` before writing their first commit body, and write every commit body with them. Name these in every code delegate's brief. Finish `/no-comments` before the independent review starts, and list live agents before a local merge. Apply's completion does not replace them.

Only the owner running this loop edits `tasks.md`. Delegates and parallel worktrees return code and evidence. pstack todos, plans, decision trails, and ledgers record pstack work, not task state.

On a blocker, stop as Apply says. A change to scope or acceptance needs an OpenSpec Update, with its confirmations, before more code. An autonomy grant does not skip those confirmations. Unrelated work stays out of the change and its PR.

## Close

Close through the ordinary pstack flow, from Opening a PR through Babysit and Shipping. Name the change in the PR's `## Scope`. A PR, green CI, a merge, a checked task, and Archive are separate events. A merge checks no box and archives nothing. After landing, report whether Sync or Archive remains, and run them only on request with the OpenSpec skill's own confirmations.
