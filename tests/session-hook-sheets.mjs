// The off-switch grammar every SessionStart implementation must agree on:
// session-start.sh, session-start.ps1, and Pi's parseSheet. Only an exact
// `session hook: off` line, with LF or CRLF endings and an optional UTF-8
// byte-order mark, disables injection. A sheet that cannot be read as a file
// leaves injection on, as a missing sheet does.
import { mkdirSync, writeFileSync } from "node:fs";

export const UNREADABLE = Symbol("unreadable sheet");

export const sheetCases = [
  { name: "no session hook line", sheet: "bug-fix: configured-model\n", off: false },
  { name: "on", sheet: "bug-fix: configured-model\nsession hook: on\n", off: false },
  { name: "off", sheet: "bug-fix: configured-model\nsession hook: off\n", off: true },
  { name: "off without a trailing newline", sheet: "session hook: off", off: true },
  { name: "off with CRLF endings", sheet: "bug-fix: configured-model\r\nsession hook: off\r\n", off: true },
  { name: "off after a byte-order mark", sheet: "\uFEFFsession hook: off\n", off: true },
  { name: "capitalised key", sheet: "Session hook: off\n", off: false },
  { name: "uppercase value", sheet: "session hook: OFF\n", off: false },
  { name: "leading space", sheet: " session hook: off\n", off: false },
  { name: "trailing space", sheet: "session hook: off \n", off: false },
  { name: "longer value", sheet: "session hook: offline\n", off: false },
  { name: "a directory in place of the file", sheet: UNREADABLE, off: false },
];

// Write a case's sheet at path; UNREADABLE puts a directory there instead.
export function writeSheet(path, sheet) {
  if (sheet === UNREADABLE) mkdirSync(path);
  else writeFileSync(path, sheet);
}
