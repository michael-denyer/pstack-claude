# Prints the Muse SessionStart output as plain text: the poteto-mode
# mandate, then the saved model choices when the sheet has any. Run after
# setup-pstack's sheet.awk, with the sheet as input, -v found=<1 when the
# sheet exists>, and PSTACK_HOOKS=<this directory> in the environment.
# Only known role lines whose entries are model IDs or aliases reach the
# output, rebuilt from their checked values, so no other text in the sheet
# does. Unlike the Copilot sheet check, a panel of one vendor is fine here:
# Muse serves one family.
{ sheet_add($0) }

END {
  emit("session-start-muse.md")
  if (!found) exit
  # Muse keeps each usable line rather than the whole sheet or none, so the
  # problems string, which also counts missing roles, goes unused.
  sheet_problems()
  n = sheet_roles(roles, panel)
  lines = ""
  for (i = 1; i <= n; i++) if (SHEET_OK[roles[i]]) lines = lines roles[i] ": " VALUE[roles[i]] "\n"
  if (SHEET_EFFORT_OK) lines = lines "default effort: " VALUE["default effort"] "\n"
  if (lines == "") exit
  print ""
  emit("session-start-muse-sheet.md")
  printf "%s", lines
}

function emit(name,    file, line) {
  file = ENVIRON["PSTACK_HOOKS"] "/" name
  while ((getline line < file) > 0) print line
  close(file)
}
