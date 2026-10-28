#!/bin/bash
# Runs the statechart suite HUNT_RUNS times from the scripts folder. When a run
# exceeds HUNT_LIMIT seconds, sends SIGUSR2 to every node process so that
# --report-on-signal writes a diagnostic report, prints each report's stack and
# active handles into the job log, and exits 3.
runs=${HUNT_RUNS:-3}
limit=${HUNT_LIMIT:-600}
reports=${HUNT_REPORTS:-/tmp/statechart-hunt/reports}
logs=${HUNT_LOGS:-/tmp/statechart-hunt/logs}
mkdir -p "$reports" "$logs"
export NODE_OPTIONS="--report-on-signal --report-directory=$reports"
for run in $(seq 1 "$runs"); do
  start=$(date +%s)
  log=$logs/run-$run.log
  npm test > "$log" 2>&1 &
  pid=$!
  while kill -0 "$pid" 2>/dev/null; do
    elapsed=$(( $(date +%s) - start ))
    if [ "$elapsed" -gt "$limit" ]; then
      echo "HANG run=$run elapsed=${elapsed}s"
      echo "=== processes"
      ps -eo pid,ppid,pgid,etime,time,stat,args
      echo "=== finished tests, last 12"
      grep -a -E "^(✔|✖) " "$log" | tail -12
      for p in $(pgrep -x node); do kill -USR2 "$p" 2>/dev/null; done
      sleep 10
      for report in "$reports"/*.json; do
        [ -e "$report" ] || continue
        echo "=== report $report"
        node -e '
          const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
          console.log("pid:", r.header.processId, "argv:", r.header.commandLine.join(" ").slice(0, 300));
          console.log("cpu user/system seconds:", r.resourceUsage.userCpuSeconds, r.resourceUsage.kernelCpuSeconds);
          console.log("stack:\n  " + r.javascriptStack.stack.join("\n  "));
          for (const h of r.libuv) if (h.is_active && h.type !== "signal") console.log("active:", h.type, JSON.stringify(h).slice(0, 240));
        ' "$report"
      done
      echo "=== statechart temp folders"
      ls -la "${TMPDIR:-/tmp}"
      echo "HUNT REPORT DONE"
      pkill -9 -x node
      exit 3
    fi
    sleep 10
  done
  wait "$pid"
  code=$?
  echo "run=$run exit=$code elapsed=$(( $(date +%s) - start ))s $(grep -a -E '^ℹ (pass|fail) ' "$log" | tr '\n' ' ')"
done
echo "NO HANG in $runs runs"
