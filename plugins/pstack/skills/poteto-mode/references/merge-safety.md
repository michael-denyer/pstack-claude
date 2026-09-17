# Merge and restack safety

Use this reference with [Shipping](../playbooks/shipping.md) and before topology changes in [Autopilot-stack](../playbooks/autopilot-stack.md). Keep the existing watcher responsible for CI and blocker classification. These operations add revision and destination checks; they do not grant merge authority.

## Read both pending mechanisms

GitHub exposes automatic requests and queue membership separately. Query both for each affected PR, using explicit repository identity:

```sh
gh api graphql -f query='query($owner:String!,$repo:String!,$pr:Int!) {
  repository(owner:$owner,name:$repo) {
    pullRequest(number:$pr) {
      id state headRefOid baseRefName
      autoMergeRequest { enabledAt }
      mergeQueueEntry { id }
      mergeCommit { oid }
    }
  }
}' -f owner="$owner" -f repo="$repo" -F pr="$pr"
```

Treat errors, missing fields, null repository/PR, or unsupported APIs as unknown state. A successful read with both fields explicitly null establishes no pending request at that observation only. It does not prevent another actor from rearming.

Before rewriting or retargeting, capture the dependency chain and remote heads, coordinate its topology writer, and cancel each affected pending mechanism. Disable auto-merge with `gh pr merge "$pr" --repo "$owner/$repo" --disable-auto`. Reread queue membership after disabling auto-merge. If it remains, remove it separately:

```sh
gh api graphql -f query='mutation($id:ID!) {
  dequeuePullRequest(input:{pullRequestId:$id}) {
    mergeQueueEntry { id }
  }
}' -f id="$pr_node_id"
```

Read both fields again for every affected PR and require an open PR with neither pending mechanism before mutating topology. Do not cancel unrelated PRs. If state changes or is unreadable, stop and reconcile. On Origin, establish and verify the equivalent pending states and cancellation operations with the installed service; GitHub fields cannot describe Origin's state.

## Preserve concurrent writes and child changes

Capture the remote branch SHA before rewriting with `git ls-remote --exit-code origin "refs/heads/$branch"`, and validate that exactly the intended ref was returned. Keep that SHA in the operation record. An implicit lease or a prior read alone is insufficient; a background fetch can move a tracking ref.

After confirming the parent squash landed in the intended destination, fetch trunk and identify the recorded old parent tip on which this child was built. Verify it is an ancestor of the child and inspect `old-parent..child` to confirm the range contains only child work. If it does not, reconstruct the boundary before proceeding. Never infer it from the parent's new squash commit.

```sh
git merge-base --is-ancestor "$old_parent_tip" "$child"
git rebase --onto "$trunk_tip" "$old_parent_tip" "$child"
git push --force-with-lease="refs/heads/$child:$captured_remote_head" \
  origin "HEAD:refs/heads/$child"
```

Run the rebase in the child's clean worktree, where `HEAD` is the prepared child. This excludes the parent's old commits. Inspect the resulting diff and content, reassess review applicability, and run checks at the new head. If the lease refuses the push, fetch and reconcile the concurrent work; do not refresh the lease and retry the overwrite blindly. Retarget only after cancellation has been verified. Keep the recorded boundary for each remaining child when preparing later levels.

## What the service guards

GitHub's immediate merge head condition is `--match-head-commit` in `gh`, `expectedHeadOid` in GraphQL `mergePullRequest`, or `sha` in the REST merge endpoint. Use one, carrying the exact verified SHA. None of these supplies an expected base-branch condition. Observe the base immediately before and after and coordinate retargeting; do not call those observations atomic.

A queue or automatic request may outlive its admission revision. Use it only when existing repository rules enforce the required verification for the eventual revision and merge context. A prose verdict or a green check on an older head is not such a gate. If those guarantees cannot be established, keep watching for an immediate guarded merge. If the repository requires a queue, stop at that unmet gate rather than bypassing protection.

After a merge, confirm state `MERGED`, the approved final head, the intended base, and a non-null merge commit. Fetch the destination and run `git merge-base --is-ancestor "$merge_commit" "$destination_tip"`; then check resulting content before advancing. If the service cannot report the relevant facts, the outcome remains unconfirmed.

Service references: [GitHub CLI merge flags](https://cli.github.com/manual/gh_pr_merge), [GraphQL pull requests and queue mutations](https://docs.github.com/en/graphql/reference/pulls), and [REST merge endpoint](https://docs.github.com/en/rest/pulls/pulls#merge-a-pull-request). Recheck installed service capabilities when these differ. Test service behavior in a disposable repository, never with production PRs.
