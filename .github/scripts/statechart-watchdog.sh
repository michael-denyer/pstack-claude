#!/bin/bash
# Runs the statechart suite under a watchdog. When npm test runs past
# WATCHDOG_LIMIT seconds, the watchdog sends SIGUSR2 to every node process so
# that --report-on-signal writes a diagnostic report, prints each report's stack
# and active handles, names each process that wrote none, prints the models the
# differential test left on disk, and exits 3. Otherwise it exits with npm
# test's status.
#
# CI run 40648025189 attempt 1 sat 16 minutes in differential.test.ts with the
# compiler worker alive and no Java process, then hit the job limit, which left
# a bare "operation was canceled". This step turns the next stall into a log
# that names the stuck process, its stack when it is idle, its CPU time when it
# is busy, and the model it was given.
#
# Arguments, when given, replace npm test as the command, so CI can run one
# group of test files per job.
[ $# -gt 0 ] || set -- npm test
limit=${WATCHDOG_LIMIT:-720}
tmp=${TMPDIR:-/tmp}
reports=${WATCHDOG_REPORTS:-$tmp/statechart-watchdog/reports}
node_command='^(/[^ ]*/)?node( |$)'
mkdir -p "$reports"
export NODE_OPTIONS="--report-on-signal --report-directory=$reports"
start=$(date +%s)
"$@" &
pid=$!
while kill -0 "$pid" 2>/dev/null; do
  if [ $(( $(date +%s) - start )) -gt "$limit" ]; then
    echo "::error::$* ran past ${limit}s; dumping every node process"
    echo "=== processes"
    ps -eo pid,ppid,pgid,etime,time,stat,args
    # Node 24 names its main thread MainThread, so pgrep -x node finds nothing.
    # Match the command line instead: "node ..." or "/path/to/node ...".
    pids=$(pgrep -f "$node_command")
    for p in $pids; do kill -USR2 "$p" 2>/dev/null; done
    sleep 10
    reported=""
    for report in "$reports"/*.json; do
      [ -e "$report" ] || continue
      # Report names are report.<date>.<time>.<pid>.<sequence>.json.
      reported="$reported $(basename "$report" | cut -d. -f4)"
      echo "=== report $report"
      node -e '
        const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
        console.log("pid:", r.header.processId, "argv:", r.header.commandLine.join(" ").slice(0, 300));
        console.log("cpu user/system seconds:", r.resourceUsage.userCpuSeconds, r.resourceUsage.kernelCpuSeconds);
        const stack = r.javascriptStack?.stack;
        console.log("stack:\n  " + (stack?.length ? stack.join("\n  ") : "no frames: the process was idle in its event loop"));
        for (const h of r.libuv) if (h.is_active && h.type !== "signal") console.log("active:", h.type, JSON.stringify(h).slice(0, 240));
      ' "$report"
    done
    # Node writes the report from its event loop, so a process stuck in
    # synchronous JavaScript writes none. Its CPU time in the process list
    # above and the model files below are what identify and replay it.
    for p in $pids; do
      case " $reported " in *" $p "*) continue ;; esac
      [ -d "/proc/$p" ] || continue
      echo "=== no report from pid $p, so it is busy in synchronous JavaScript: $(ps -o args= -p "$p" | cut -c1-200)"
    done
    echo "=== temp folders"
    ls -d "$tmp"/statechart-* 2>/dev/null
    for dir in "$tmp"/statechart-differential-*; do
      [ -d "$dir" ] || continue
      for f in "$dir"/*.tla "$dir"/*.cfg "$dir"/view.mjs; do
        [ -e "$f" ] || continue
        echo "=== $f"
        cat "$f"
      done
    done
    pkill -9 -f "$node_command"
    exit 3
  fi
  sleep 10
done
wait "$pid"
