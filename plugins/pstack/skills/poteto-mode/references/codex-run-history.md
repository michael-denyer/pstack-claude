# Codex run history

Use the transcript lookup in [Codex tool mapping](codex-tools.md#tool-actions). Before opening history, identify the canonical working directory and its Git worktrees (use `git worktree list --porcelain` for a Git project). For an eval, record each candidate's expected working directory and thread ID at dispatch and allow only that candidate directory, even when it is a scratch directory.

Match the `session_meta` record to the expected working directory and, where known, to the exact thread ID. For a thread with more than one rollout, use only the current rollout from Codex's state index. Treat missing or ambiguous history as unavailable. When resuming without a transcript, continue with the cloud-agent URL or pushed branch if one was provided. When evaluating or mining history, report the missing evidence rather than substituting a different transcript or relying on a candidate's summary.
