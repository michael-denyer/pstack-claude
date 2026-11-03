# Prints the Antigravity SessionStart output: one JSON object whose injectSteps
# systemMessage is the poteto-mode mandate for Antigravity. Run after json.awk.
{ lines[++n] = $0 }

END {
  out = ""
  for (i = 1; i <= n; i++) out = out (i > 1 ? "\\n" : "") esc(lines[i])
  print "{\"injectSteps\":[{\"systemMessage\":{\"systemMessage\":\"" out "\"}}]}"
}
