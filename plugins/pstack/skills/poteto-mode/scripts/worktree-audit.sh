#!/usr/bin/env bash
# Read-only worktree prune audit. Classifies every git worktree by size, merge
# state, uncommitted work, remote/PR state, and the most recent chat that
# operated in it. Emits a table sorted by size with a suggested bucket. Never
# deletes anything; deletion stays a human-gated step in the playbook.
#
# Usage: worktree-audit.sh [repo-path] [transcripts-path]
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

# Emit complete worktree records as NUL-delimited path/state pairs. A blank
# porcelain record terminates each worktree; the first emitted record is the
# primary worktree and is skipped by the consumer below.
parse_worktrees() {
    local field="" wt="" state="ok"
    while IFS= read -r -d '' field; do
        if [ -z "$field" ]; then
            if [ -n "$wt" ]; then
                printf '%s\0%s\0' "$wt" "$state"
            fi
            wt=""
            state="ok"
        elif [ "${field#worktree }" != "$field" ]; then
            wt="${field#worktree }"
        elif [ "${field#prunable}" != "$field" ]; then
            state="prunable"
        fi
    done < <(git worktree list --porcelain -z)
    if [ -n "$wt" ]; then
        printf '%s\0%s\0' "$wt" "$state"
    fi
}

# Decide from explicit facts. Unknown facts can never establish safe.
classify_bucket() {
    local dirty_state="$1"
    local pr_state="$2"
    local recent="$3"
    local ancestry="$4"
    local merged_head_match="$5"
    local facts_known="$6"

    case "$dirty_state" in
        wip:*) echo hold-wip; return ;;
    esac
    if [ "$pr_state" = OPEN ]; then
        echo hold-open-pr
        return
    fi
    if [ "$recent" = yes ]; then
        echo verify-recent-chat
        return
    fi
    if [ "$facts_known" != yes ]; then
        echo review
        return
    fi
    if [ "$ancestry" = YES ]; then
        echo safe
        return
    fi
    if [ "$pr_state" = MERGED ] && [ "$merged_head_match" = yes ]; then
        echo safe
        return
    fi
    echo review
}

# Keep displaying partial facts when discovery fails, but never label them safe.
discovery_known=yes
if ! fetch_err=$(git fetch origin main 2>&1 >/dev/null); then
    discovery_known=no
    echo "warn: could not fetch origin/main; merged column may be stale: $fetch_err" >&2
fi

# PR state by branch, fetched once. Empty if gh is unavailable.
if ! prs=$(gh pr list --author "@me" --state all --limit 1000 --json number,state,headRefName,headRefOid 2>&1); then
    discovery_known=no
    echo "warn: gh pr list failed; PR column will be empty: $prs" >&2
    prs="[]"
fi

# jq reads that JSON and rg finds the transcripts. Without either, the PR and
# LAST_CHAT columns blank out and no row can reach verify-recent-chat.
if ! command -v jq >/dev/null; then
    discovery_known=no
    echo "warn: jq not found; PR column will be empty" >&2
fi
if ! command -v rg >/dev/null; then
    discovery_known=no
    echo "warn: rg not found; LAST_CHAT column will be empty" >&2
fi

# Transcripts: ~/.claude/projects/<encoded-cwd>/<uuid>.jsonl, where <encoded-cwd> is a
# session's cwd with every "/" turned into "-". A session run inside a worktree lives
# under that worktree's own directory, so scan the whole projects tree, not one repo's.
transcripts="${2:-$HOME/.claude/projects}"
now=$(date +%s)

printf "SIZE\tAGE\tMERGED\tDIRTY\tREMOTE\tPR\tLAST_CHAT\tBUCKET\tWORKTREE\n"

parse_worktrees | while IFS= read -r -d '' wt && IFS= read -r -d '' state; do
    if [ "${primary:-yes}" = yes ]; then
        primary=no
        continue
    fi

    if [ "$state" = prunable ]; then
        printf "%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n" "-" "?" "-" "-" "-" "-" "-" prunable "$wt"
        continue
    fi

    if size_output=$(du -sh "$wt" 2>/dev/null); then
        size=$(printf '%s\n' "$size_output" | awk '{print $1}')
    else
        size="?"
    fi

    facts_known="$discovery_known"
    if head=$(git -C "$wt" rev-parse HEAD 2>/dev/null); then
        if head_ts=$(git -C "$wt" log -1 --format='%ct' HEAD 2>/dev/null); then
            age="$(( (now - head_ts) / 86400 ))d"
        else
            age="?"
            facts_known=no
        fi
    else
        head="?"
        age="?"
        facts_known=no
    fi

    ancestry="?"
    if [ "$head" != "?" ]; then
        git merge-base --is-ancestor "$head" origin/main >/dev/null 2>&1
        merge_status=$?
        if [ "$merge_status" -eq 0 ]; then
            ancestry=YES
        elif [ "$merge_status" -eq 1 ]; then
            ancestry=no
        else
            facts_known=no
        fi
    else
        facts_known=no
    fi
    merged="$ancestry"

    if porcelain=$(git -C "$wt" status --porcelain 2>/dev/null); then
        wip_n=$(printf '%s\n' "$porcelain" | grep -cv '^??' || true)
        scratch_n=$(printf '%s\n' "$porcelain" | grep -c '^??' || true)
        if [ -z "$porcelain" ]; then
            dirty=clean
        elif [ "$wip_n" -gt 0 ]; then
            dirty="wip:$wip_n"
        else
            dirty="scratch:$scratch_n"
        fi
    else
        dirty=unknown
        facts_known=no
    fi

    if branch=$(git -C "$wt" rev-parse --abbrev-ref HEAD 2>/dev/null); then
        [ "$branch" = HEAD ] && branch=""
    else
        branch=""
        facts_known=no
    fi

    remote_sha=""
    if [ -n "$branch" ]; then
        if remote_sha=$(git -C "$wt" for-each-ref --format='%(objectname)' "refs/remotes/origin/$branch" 2>/dev/null); then
            if [ -n "$remote_sha" ]; then
                if [ "$remote_sha" = "$head" ]; then
                    remote=pushed
                else
                    if ahead_count=$(git -C "$wt" rev-list --count "origin/$branch..HEAD" 2>/dev/null); then
                        remote="ahead$ahead_count"
                    else
                        remote=unknown
                        facts_known=no
                    fi
                fi
            else
                remote=no-remote
            fi
        else
            remote=unknown
            facts_known=no
        fi
    else
        remote=detached
    fi

    pr="-"
    pr_state="-"
    pr_head_oid="-"
    if [ -n "$branch" ] && command -v jq >/dev/null 2>&1; then
        if pr_fields=$(jq -r --arg b "$branch" \
            '.[] | select(.headRefName==$b) | [.number,.state,.headRefOid // ""] | @tsv' <<<"$prs"); then
            if [ -n "$pr_fields" ]; then
                IFS=$'\t' read -r pr_number pr_state pr_head_oid <<<"$pr_fields"
                pr="#$pr_number/$pr_state"
            fi
        else
            facts_known=no
        fi
    fi

    # Match paths literally so regex metacharacters in a worktree path are inert.
    last="-"
    last_ts=0
    if [ -d "$transcripts" ] && command -v rg >/dev/null 2>&1; then
        if matches=$(rg -F -l -e "${wt}/" -e "${wt}\"" -- "$transcripts"); then
            while IFS= read -r f; do
                [ -z "$f" ] && continue
                if timestamp=$(mtime "$f"); then
                    case "$timestamp" in
                        ''|*[!0-9]*) facts_known=no ;;
                        *) if [ "$timestamp" -gt "$last_ts" ]; then last_ts=$timestamp; fi ;;
                    esac
                else
                    facts_known=no
                fi
            done <<<"$matches"
        else
            search_status=$?
            # rg uses 1 for a successful search with no matches.
            if [ "$search_status" -ne 1 ]; then facts_known=no; fi
        fi
        if [ "$last_ts" -gt 0 ]; then
            if ! last=$(ymd "$last_ts"); then facts_known=no; fi
        fi
    fi
    if [ "$last_ts" -gt 0 ] && [ $(( (now - last_ts) / 86400 )) -le 4 ]; then
        recent=yes
    else
        recent=no
    fi

    merged_head_match=no
    if [ "$pr_state" = MERGED ] && [ "$head" != "?" ] && [ "$pr_head_oid" = "$head" ]; then
        merged_head_match=yes
    fi
    bucket=$(classify_bucket "$dirty" "$pr_state" "$recent" "$ancestry" "$merged_head_match" "$facts_known")

    printf "%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n" \
        "$size" "$age" "$merged" "$dirty" "$remote" "$pr" "$last" "$bucket" "$wt"
done | sort -t$'\t' -k1,1 -rh
