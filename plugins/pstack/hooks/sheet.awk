# Sheet helpers shared by the Copilot hooks. POSIX awk, run under LC_ALL=C.

# A role line is `role: value`. `session hook` and `panel vendors` are settings.
function sheet_role_line(line) {
  return line ~ /^[A-Za-z][A-Za-z0-9 ,\/_()-]*:[ \t]*[^ \t]/ && line !~ /^(session hook|panel vendors):/
}

function sheet_trim(s) {
  sub(/^[ \t]+/, "", s)
  sub(/[ \t]+$/, "", s)
  return s
}

# Drops a role value's reasoning effort suffix, as in `gpt-5.5 @xhigh`.
function sheet_model(e) {
  sub(/[ \t]+@(low|medium|high|xhigh|max)$/, "", e)
  return e
}

function sheet_alias(id) {
  return id == "inherit-parent" || id == "auto"
}

function sheet_vendor(id) {
  sub(/-.*/, "", id)
  return id
}

# The 17 roles every Copilot sheet names, in setup-pstack's sheet order.
# Fills roles[1..17] and panel[role] for the four panel lists.
function sheet_roles(roles, panel) {
  split("feature, refactoring|bug-fix|perf-issue|hillclimb|judgment and prose|strongest judgment|" \
    "how explorer|how explainer|why investigators|why synthesizer|reflect tooling|" \
    "reflect judgment, divergent, synthesizer|arena runners|arena cross-judge pool|swarm workers|" \
    "architect runners|interrogate reviewers", roles, "|")
  split("", panel)
  panel["arena runners"] = panel["arena cross-judge pool"] = panel["architect runners"] = panel["interrogate reviewers"] = 1
  return 17
}

# Collects the model IDs the sheet's lines for the 17 roles name, in order of
# first use. Returns the number of those lines, or -1 when the sheet cannot be
# read.
function sheet_ids(file, seen, order,    line, r, lines, n, k, i, e, E, roles, panel, want) {
  split("", seen)
  split("", order)
  sheet_roles(roles, panel)
  split("", want)
  for (i = 1; i <= 17; i++) want[roles[i]] = 1
  lines = 0
  k = 0
  while ((r = (getline line < file)) > 0) {
    sub(/\r$/, "", line)
    if (!index(line, ":") || !(substr(line, 1, index(line, ":") - 1) in want)) continue
    lines++
    n = split(substr(line, index(line, ":") + 1), E, ",")
    for (i = 1; i <= n; i++) {
      e = sheet_model(sheet_trim(E[i]))
      if (e != "" && !(e in seen)) { seen[e] = 1; order[++k] = e }
    }
  }
  close(file)
  SHEET_IDS = k
  return r < 0 ? -1 : lines
}

# Lists what is wrong with sheet text, or returns "" when it is well formed.
function sheet_problems(text,    L, n, i, line, key, roles, panel, want, seen, any, E, m, j, e, V, nv, vl, real, missing, bad, mono, out) {
  n = split(text, L, "\n")
  sheet_roles(roles, panel)
  split("", want)
  for (i = 1; i <= 17; i++) want[roles[i]] = 1
  any = 0
  for (i = 1; i <= n; i++) if (L[i] ~ /^panel vendors:[ \t]*any[ \t\r]*$/) any = 1
  split("", seen)
  bad = mono = ""
  for (i = 1; i <= n; i++) {
    line = L[i]
    sub(/\r$/, "", line)
    if (!index(line, ":")) continue
    key = substr(line, 1, index(line, ":") - 1)
    if (!(key in want)) continue
    seen[key] = 1
    m = split(substr(line, index(line, ":") + 1), E, ",")
    split("", V)
    nv = 0
    vl = ""
    real = 0
    for (j = 1; j <= m; j++) {
      e = sheet_model(sheet_trim(E[j]))
      if (e == "") { bad = bad "; an empty entry in " key; continue }
      if (sheet_alias(e)) continue
      real = 1
      if (e !~ /^[a-z0-9][a-z0-9.-]*$/) { bad = bad "; `" e "` in " key; continue }
      if (!(sheet_vendor(e) in V)) {
        V[sheet_vendor(e)] = 1
        nv++
        vl = vl (vl == "" ? "" : ", ") sheet_vendor(e)
      }
    }
    if (m == 0) bad = bad "; no model in " key
    if ((key in panel) && real && nv < 2 && !any) mono = mono "; " key " (" (vl == "" ? "no valid ID" : vl) ")"
  }
  missing = ""
  for (i = 1; i <= 17; i++) if (!(roles[i] in seen)) missing = missing (missing == "" ? "" : "; ") roles[i]
  out = ""
  if (missing != "") out = out " Missing roles: " missing "."
  if (bad != "") out = out " Malformed entries: " substr(bad, 3) "."
  if (mono != "") out = out " Panels from fewer than two vendors: " substr(mono, 3) "."
  return out
}
