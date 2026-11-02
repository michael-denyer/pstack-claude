// The Windows janitor for statechart.ts. Windows has no process groups and no /bin/sh, so when
// the command's pipe closes this kills the worker's process tree and removes its folders.
import { spawnSync } from "node:child_process";
import fs from "node:fs";

const [pid, ...dirs] = process.argv.slice(2);

process.stdin.on("end", () => {
  spawnSync("taskkill", ["/T", "/F", "/PID", pid], { stdio: "ignore", windowsHide: true });
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});
process.stdin.resume();
