#!/usr/bin/env bash
# Read-only worktree prune audit. Classifies every git worktree by size, merge
# state, uncommitted work, remote/PR state, and the most recent chat that
# operated in it. Emits a table sorted by size with a suggested bucket. Never
# deletes anything; deletion stays a human-gated step in the playbook.
#
# Usage: worktree-audit.sh [repo-path]   (defaults to the current repo)
set -u

repo="${1:-$(git rev-parse --show-toplevel 2>/dev/null)}"
[ -z "$repo" ] && { echo "not in a git repo; pass a repo path" >&2; exit 1; }
cd "$repo" || exit 1

# GNU and BSD spell file mtime and epoch-to-date differently; pick once.
if stat -c %Y . >/dev/null 2>&1; then
    mtime() { stat -c %Y "$@"; }
    ymd() { date -u -d "@$1" +%Y-%m-%d; }
else
    mtime() { stat -f %m "$@"; }
    ymd() { date -u -r "$1" +%Y-%m-%d; }
fi

# Main worktree is the first entry; everything else is a candidate.
main_wt=$(git worktree list --porcelain | awk '/^worktree /{print $2; exit}')

# origin/main drives the merge check. Best-effort; stale is fine for a first pass.
if ! fetch_err=$(git fetch origin main 2>&1 >/dev/null); then
    echo "warn: could not fetch origin/main; merged column may be stale: $fetch_err" >&2
fi

# PR state by branch, fetched once. Empty if gh is unavailable.
if ! prs=$(gh pr list --author "@me" --state all --limit 1000 --json number,state,headRefName 2>&1); then
    echo "warn: gh pr list failed; PR column will be empty: $prs" >&2
    prs="[]"
fi

# jq reads that JSON and rg finds the transcripts. Without either, the PR and
# LAST_CHAT columns blank out and no row can reach verify-recent-chat, so an
# in-use worktree buckets as safe. Say so rather than return a confident table.
command -v jq >/dev/null || echo "warn: jq not found; PR column will be empty" >&2
command -v rg >/dev/null || echo "warn: rg not found; LAST_CHAT column will be empty and no row can bucket verify-recent-chat" >&2

# Transcripts: ~/.claude/projects/<encoded-cwd>/<uuid>.jsonl, where <encoded-cwd> is a
# session's cwd with every "/" turned into "-". A session run inside a worktree lives
# under that worktree's own directory, so scan the whole projects tree, not one repo's.
transcripts="$HOME/.claude/projects"
now=$(date +%s)

printf "SIZE\tAGE\tMERGED\tDIRTY\tREMOTE\tPR\tLAST_CHAT\tBUCKET\tWORKTREE\n"

# One line per worktree: "<path>\t<prunable|ok>". git already knows when a
# worktree's directory is gone; such a row needs no per-directory commands.
git worktree list --porcelain | awk '
    /^worktree /{ if (wt != "") print wt "\t" state; wt = $2; state = "ok" }
    /^prunable/{ state = "prunable" }
    END{ if (wt != "") print wt "\t" state }
' | while IFS=$'\t' read -r wt state; do
    [ "$wt" = "$main_wt" ] && continue

    if [ "$state" = prunable ]; then
        printf "%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n" "-" "?" "-" "-" "-" "-" "-" prunable "$wt"
        continue
    fi

    size=$(du -sh "$wt" | awk '{print $1}')
    head=$(git -C "$wt" rev-parse HEAD)
    head_ts=$(git -C "$wt" log -1 --format='%ct' HEAD)
    age="$(( (now - head_ts) / 86400 ))d"

    # Squash-merged branches are not ancestors of main, so PR state is the
    # real signal; merge-base only catches fast-forward/rebase merges.
    if git merge-base --is-ancestor "$head" origin/main; then merged=YES; else merged=no; fi

    # Distinguish real WIP (tracked edits) from disposable untracked scratch.
    porcelain=$(git -C "$wt" status --porcelain)
    wip_n=$(printf '%s\n' "$porcelain" | grep -cv '^??' || true)
    scratch_n=$(printf '%s\n' "$porcelain" | grep -c '^??' || true)
    if [ -z "$porcelain" ]; then dirty=clean
    elif [ "$wip_n" -gt 0 ]; then dirty="wip:$wip_n"
    else dirty="scratch:$scratch_n"; fi

    branch=$(git -C "$wt" rev-parse --abbrev-ref HEAD)
    [ "$branch" = HEAD ] && branch=""
    remote_sha=$([ -n "$branch" ] && git -C "$wt" for-each-ref --format='%(objectname)' "refs/remotes/origin/$branch")
    if [ -z "$branch" ]; then remote=detached
    elif [ -z "$remote_sha" ]; then remote=no-remote
    elif [ "$remote_sha" = "$head" ]; then remote=pushed
    else remote="ahead$(git -C "$wt" rev-list --count "origin/$branch..HEAD")"; fi

    pr=$([ -n "$branch" ] && jq -r --arg b "$branch" \
        '.[] | select(.headRefName==$b) | "#\(.number)/\(.state)"' <<<"$prs" | head -1)
    [ -z "$pr" ] && pr="-"

    # Most recent chat whose transcript operated in this worktree. Match path
    # followed by "/" or a quote so glint-482 does not match glint-482-r37.
    last="-"; last_ts=0
    if [ -d "$transcripts" ]; then
        newest=$(rg -l -e "${wt}/" -e "${wt}\"" "$transcripts" | while read -r f; do
            printf '%s %s\n' "$(mtime "$f")" "$f"
        done | sort -rn | head -1)
        if [ -n "$newest" ]; then
            last_ts=${newest%% *}
            last=$(ymd "$last_ts")
        fi
    fi
    if [ "$last_ts" -gt 0 ] && [ $(( (now - last_ts) / 86400 )) -le 4 ]; then recent=yes; else recent=no; fi

    case "$dirty" in wip:*) bucket=hold-wip ;; *)
        case "$pr" in *OPEN*) bucket=hold-open-pr ;; *)
            if [ "$recent" = yes ]; then bucket=verify-recent-chat
            elif [ "$merged" = YES ] || [ "$pr" != "-" ]; then bucket=safe
            else bucket=review; fi ;;
        esac ;;
    esac

    printf "%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n" \
        "$size" "$age" "$merged" "$dirty" "$remote" "$pr" "$last" "$bucket" "$wt"
done | sort -t$'\t' -k1,1 -rh
