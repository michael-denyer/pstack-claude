{ body = body esc($0) "\\n" }
END {
  note = "On Devin CLI, read " mapping " before using pstack. It maps tools and saved role choices to Devin profiles."
  print "{\"hookSpecificOutput\":{\"hookEventName\":\"SessionStart\",\"additionalContext\":\"" body "\\n" esc(note) "\"}}"
}
