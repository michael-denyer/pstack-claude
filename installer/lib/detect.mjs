import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";

// Look `bin` up on PATH ourselves, so a test can stub PATH and win32's
// PATHEXT shims resolve. Returns the full path, or null.
export function which(bin, { env, platform }) {
  const dirs = (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean);
  const exts =
    platform === "win32"
      ? ["", ...(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)]
      : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      const file = join(dir, bin + ext);
      try {
        if (!statSync(file).isFile()) continue;
        if (platform !== "win32") accessSync(file, constants.X_OK);
        return file;
      } catch {}
    }
  }
  return null;
}

// A harness with no bin (the shared skills dir) is always available.
export const detect = (harness, ctx) => (harness.bin === null ? true : which(harness.bin, ctx) !== null);
