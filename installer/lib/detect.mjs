import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";

// Look `bin` up on PATH ourselves, so a test can stub PATH and win32's
// PATHEXT shims resolve. Returns the full path, or null.
export function which(bin, { env, platform }) {
  const dirs = (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean);
  const exts =
    platform === "win32"
      ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
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

// The shared skills dir has no bin to find, and Codex and OpenCode also read
// it, so it is never chosen by default: a native install plus the links would
// load every skill twice. Pick it by id or number.
export const detect = (harness, ctx) => harness.bin !== null && which(harness.bin, ctx) !== null;
