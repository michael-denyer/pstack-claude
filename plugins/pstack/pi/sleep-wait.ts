// Whether a bash command line waits on a foreground `sleep`, the way a model
// polls for a background agent it should leave alone.
//
// A token rule, not a shell parser. After heredoc bodies, quoted strings, and
// comments are removed, the word `sleep` followed by a literal duration of
// MIN_WAIT_S or more blocks, anywhere in the line, unless that sleep itself is
// directly backgrounded (`sleep 30 &`, never `&&` or `&>`). It errs toward
// blocking: a wrongly blocked command costs one rephrased turn, a missed poll
// loop costs minutes. Known misses: a sleep inside a quoted script such as
// `bash -c 'sleep 30'`, a quoted duration (`sleep "30"`), a variable duration
// (`sleep $N`), and a poll loop of sleeps under two seconds. Known over-blocks:
// a sleep inside a backgrounded group (`(sleep 30; echo done) &`), a
// backgrounded sleep with a redirection before the `&`, and
// `timeout 5 sleep 30`. tests/pi/sleep-wait.test.mjs lists each, so changing
// one is a visible decision.
const MIN_WAIT_S = 2;
const SLEEP_UNITS: Record<string, number> = { "": 1, s: 1, m: 60, h: 3600, d: 86400 };

// Seconds a literal sleep argument asks for (30, 2.5, 1m, 1m30s, infinity);
// 0 when it is not a literal.
function sleepSeconds(arg: string): number {
  if (/^inf(inity)?$/.test(arg)) return Infinity;
  const parts = arg.match(/\d*\.?\d+[smhd]?/g);
  if (!parts || parts.join("") !== arg) return 0;
  return parts.reduce((sum, part) => {
    const unit = /[smhd]$/.exec(part)?.[0] ?? "";
    return sum + Number(part.slice(0, part.length - unit.length)) * SLEEP_UNITS[unit];
  }, 0);
}

// One line with its quoted strings replaced by "" and a comment cut off, in a
// single left-to-right pass. An unterminated quote drops the rest of the line.
function stripQuotesAndComment(line: string): string {
  let out = "";
  let quote: string | undefined;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === "\\" && quote === '"') i++;
      else if (c === quote) {
        quote = undefined;
        out += '""';
      }
    } else if (c === "\\") {
      out += c + (line[i + 1] ?? "");
      i++;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "#" && (i === 0 || /\s/.test(line[i - 1]))) break;
    else out += c;
  }
  return out;
}

// The command text the shell would run: heredoc bodies, quoted strings, and
// comments removed, one pass over the lines so the cost stays linear. The
// line that opens a heredoc is kept, since commands can follow the `<<`.
function shellText(command: string): string {
  const kept: string[] = [];
  let terminator: string | undefined;
  for (const line of command.split("\n")) {
    if (terminator !== undefined) {
      if (line.trim() === terminator) terminator = undefined;
      continue;
    }
    kept.push(stripQuotesAndComment(line));
    terminator = /<<-?\s*(["']?)(\w+)\1/.exec(line)?.[2];
  }
  return kept.join("\n");
}

export function isForegroundWait(command: string): boolean {
  for (const m of shellText(command).matchAll(/\bsleep\s+([^\s;|&()<>]+)\s*(&(?![&>]))?/g)) {
    if (m[2] === undefined && sleepSeconds(m[1]) >= MIN_WAIT_S) return true;
  }
  return false;
}
