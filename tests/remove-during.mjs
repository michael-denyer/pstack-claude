// Reproduces session cleanup racing a transcript scan: runs `body` under node
// with `fs[call]` removing `victims` right after it first touches `trigger`.
// syncBuiltinESMExports carries the patch into the scripts' named `node:fs`
// imports; bun ignores it, so these runs need node.
import { spawnSync } from "node:child_process";

export function removeDuring(call, trigger, victims, body) {
  const seam = `
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    const real = fs.${call};
    let fired = false;
    fs.${call} = (path, ...rest) => {
      const result = real(path, ...rest);
      if (!fired && path === ${JSON.stringify(trigger)}) {
        fired = true;
        for (const victim of ${JSON.stringify(victims)}) fs.rmSync(victim, { recursive: true });
      }
      return result;
    };
    syncBuiltinESMExports();
    ${body}
  `;
  return spawnSync("node", ["--input-type=module", "-e", seam], { encoding: "utf8" });
}
