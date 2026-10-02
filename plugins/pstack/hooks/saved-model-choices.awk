# Replaces the marker in the stamped Copilot context with the sheet's role
# lines, escaped as JSON string content. POSIX awk, run under LC_ALL=C, after
# json.awk and sheet.awk.
BEGIN {
  marker = "@PSTACK_SAVED_MODEL_CHOICES@"
  sheet = ENVIRON["PSTACK_SHEET"]
  cap = 4096
  body = ""; kept = 0; seen = 0; truncated = 0
  while ((getline line < sheet) > 0) {
    seen += length(line) + 1
    if (seen > 16 * cap) { truncated = 1; break }
    sub(/\r$/, "", line)
    if (!sheet_role_line(line)) continue
    if (kept + length(line) + 1 > cap) { truncated = 1; break }
    kept += length(line) + 1
    body = body (body == "" ? "" : "\\n") esc(line)
  }
  close(sheet)
  if (body == "") body = "(no role lines: every role omits `model`)"
  if (truncated) body = body "\\n(truncated: the sheet has more than the plugin hook injects; view it for the rest)"
}

{
  i = index($0, marker)
  if (i) $0 = substr($0, 1, i - 1) body substr($0, i + length(marker))
  print
}
