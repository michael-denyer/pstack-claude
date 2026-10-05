// The off-switch grammar every SessionStart implementation must agree on:
// session-start.sh, session-start.ps1, and Pi's parseSheet. The sheet is
// UTF-8, or UTF-16 LE when it starts with that byte-order mark, which is what
// Windows PowerShell 5.1's `>` writes. A leading byte-order mark is dropped,
// lines end at LF, and one CR before the LF is dropped; any other CR is part of
// the line. Only a line that is then exactly `session hook: off` disables
// injection. A sheet that cannot be read as a file leaves injection on, as a
// missing sheet does.
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";

export const UNREADABLE = Symbol("unreadable sheet");
export const NO_READ_PERMISSION = Symbol("sheet without read permission");

// chmod cannot deny a read on Windows, or to root.
export const chmodDeniesReads = process.platform !== "win32" && process.getuid?.() !== 0;

export const sheetCases = [
  { name: "no session hook line", sheet: "bug-fix: configured-model\n", off: false },
  { name: "on", sheet: "bug-fix: configured-model\nsession hook: on\n", off: false },
  { name: "off", sheet: "bug-fix: configured-model\nsession hook: off\n", off: true },
  { name: "off without a trailing newline", sheet: "session hook: off", off: true },
  { name: "off with CRLF endings", sheet: "bug-fix: configured-model\r\nsession hook: off\r\n", off: true },
  { name: "off after a byte-order mark", sheet: "﻿session hook: off\n", off: true },
  { name: "off in UTF-16 LE after a byte-order mark", sheet: Buffer.from("﻿session hook: off\r\n", "utf16le"), off: true },
  { name: "a CR before the LF and another after off", sheet: "session hook: off\r\r\n", off: false },
  { name: "lone CRs around off", sheet: "a\rsession hook: off\r", off: false },
  { name: "a CR inside off", sheet: "session hook: o\rff\n", off: false },
  { name: "capitalised key", sheet: "Session hook: off\n", off: false },
  { name: "uppercase value", sheet: "session hook: OFF\n", off: false },
  { name: "leading space", sheet: " session hook: off\n", off: false },
  { name: "trailing space", sheet: "session hook: off \n", off: false },
  { name: "longer value", sheet: "session hook: offline\n", off: false },
  { name: "a directory in place of the file", sheet: UNREADABLE, off: false },
  ...(chmodDeniesReads ? [{ name: "no read permission on the file", sheet: NO_READ_PERMISSION, off: false }] : []),
];

// Write a case's sheet at path; UNREADABLE puts a directory there instead, and
// NO_READ_PERMISSION an off sheet that only a reader ignoring permissions could see.
export function writeSheet(path, sheet) {
  if (sheet === UNREADABLE) mkdirSync(path);
  else if (sheet === NO_READ_PERMISSION) {
    writeFileSync(path, "session hook: off\n");
    chmodSync(path, 0o000);
  } else writeFileSync(path, sheet);
}
