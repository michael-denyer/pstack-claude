# Reads and checks a pstack model sheet. Shared by check-sheet.sh, which
# setup-pstack runs after it writes a GitHub Copilot sheet, and by the Copilot
# plugin hooks, which check the sheet again each time they read it. POSIX awk,
# run under LC_ALL=C.

# Fills roles[1..n] with the roles every sheet names, in sheet order, and
# panel[role] for the panel lists, and SHEET_EFFORT[level] for the reasoning
# effort levels. Returns n.
function sheet_roles(roles, panel,    n) {
  split("", roles)
  split("", panel)
  n = 0
  # Stamped from plugins/pstack/models.json; edit there and rerun tools/generate.mjs.
  roles[++n] = "feature, refactoring"
  roles[++n] = "bug-fix"
  roles[++n] = "perf-issue"
  roles[++n] = "hillclimb"
  roles[++n] = "judgment and prose"
  roles[++n] = "strongest judgment"
  roles[++n] = "how explorer"
  roles[++n] = "how explainer"
  roles[++n] = "why investigators"
  roles[++n] = "why synthesizer"
  roles[++n] = "reflect tooling"
  roles[++n] = "reflect judgment, divergent, synthesizer"
  roles[++n] = "arena runners"
  roles[++n] = "arena cross-judge pool"
  roles[++n] = "swarm workers"
  roles[++n] = "architect runners"
  roles[++n] = "interrogate reviewers"
  panel["arena runners"] = 1
  panel["arena cross-judge pool"] = 1
  panel["architect runners"] = 1
  panel["interrogate reviewers"] = 1
  SHEET_EFFORT["low"] = 1
  SHEET_EFFORT["medium"] = 1
  SHEET_EFFORT["high"] = 1
  SHEET_EFFORT["xhigh"] = 1
  SHEET_EFFORT["max"] = 1
  return n
}

# Adds one line decoded by read-sheet.sh to SHEET[1..SHEET_N].
function sheet_add(line) {
  SHEET[++SHEET_N] = line
}

# Quote one literal shell argument, including paths containing apostrophes.
function sheet_quote(s) {
  gsub(/'/, "'\"'\"'", s)
  return "'" s "'"
}

# Every consumer uses the same decoder. A failed read publishes no policy.
function sheet_read(file,    line, r, cmd, status) {
  SHEET_N = 0
  cmd = "sh " sheet_quote(ENVIRON["PSTACK_SHEET_READER"]) " " sheet_quote(file)
  while ((r = (cmd | getline line)) > 0) sheet_add(line)
  status = close(cmd)
  return r == 0 && status == 0
}

function sheet_trim(s) {
  sub(/^[ \t]+/, "", s)
  sub(/[ \t]+$/, "", s)
  return s
}

# Drops a role value's reasoning effort suffix, as in `gpt-5.5 @xhigh`.
# Call sheet_roles first.
function sheet_model(e,    level) {
  if (match(e, /[ \t]+@[a-z]+$/)) {
    level = substr(e, RSTART)
    sub(/^[ \t]+@/, "", level)
    if (level in SHEET_EFFORT) e = substr(e, 1, RSTART - 1)
  }
  return e
}

function sheet_alias(id) {
  return id == "inherit-parent" || id == "auto"
}

function sheet_vendor(id) {
  sub(/-.*/, "", id)
  return id
}

# The key of `key: value` at the start of a line, or "" for any other line.
function sheet_key(line) {
  return line ~ /^[^ \t]/ && index(line, ":") ? sheet_trim(substr(line, 1, index(line, ":") - 1)) : ""
}

function sheet_value(line) {
  return sheet_trim(substr(line, index(line, ":") + 1))
}

# Parses SHEET. VALUE[role] is the last line's value for each known role, and
# VALUE["default effort"] the default effort. Returns what is wrong with the
# sheet as "; "-separated problems, or "" when it is well formed: a missing
# role, an entry that is not inherit-parent, auto, or a model ID with an
# optional effort, a default effort that is not session or a level, or a panel
# with models from fewer than two vendors without a `panel vendors: any` line.
# A problem quotes no unchecked sheet text, since the hook adds it to the
# session context.
# On success, SHEET_MODELS is the model set, MODEL_LIST its display list of
# explicit IDs, and MODEL_ALIASES records whether any role inherits its model.
function sheet_problems(    roles, panel, n, want, any, i, key, out, E, m, j, e, V, nv, vl, real) {
  n = sheet_roles(roles, panel)
  split("", want)
  for (i = 1; i <= n; i++) want[roles[i]] = 1
  split("", VALUE)
  split("", SHEET_MODELS)
  MODEL_LIST = ""
  MODEL_ALIASES = 0
  any = 0
  for (i = 1; i <= SHEET_N; i++) {
    key = sheet_key(SHEET[i])
    if (key in want || key == "default effort") VALUE[key] = sheet_value(SHEET[i])
    else if (key == "panel vendors" && sheet_value(SHEET[i]) == "any") any = 1
  }
  out = ""
  for (i = 1; i <= n; i++) if (!(roles[i] in VALUE)) out = out "; missing role `" roles[i] "`"
  if (("default effort" in VALUE) && VALUE["default effort"] != "session" && !(VALUE["default effort"] in SHEET_EFFORT)) {
    out = out "; default effort is not session or a level"
  }
  for (i = 1; i <= n; i++) {
    key = roles[i]
    if (!(key in VALUE)) continue
    m = split(VALUE[key], E, ",")
    if (m == 0) out = out "; no model in `" key "`"
    split("", V)
    nv = 0
    vl = ""
    real = 0
    for (j = 1; j <= m; j++) {
      e = sheet_model(sheet_trim(E[j]))
      if (e == "") { out = out "; an empty entry in `" key "`"; continue }
      if (sheet_alias(e)) { MODEL_ALIASES = 1; SHEET_MODELS[e] = 1; continue }
      if (e !~ /^[a-z0-9][a-z0-9.-]*$/) { out = out "; `" key "` has an entry that is not a model ID"; continue }
      if (!(e in SHEET_MODELS)) MODEL_LIST = MODEL_LIST (MODEL_LIST == "" ? "" : ", ") "`" e "`"
      SHEET_MODELS[e] = 1
      real = 1
      if (!(sheet_vendor(e) in V)) {
        V[sheet_vendor(e)] = 1
        nv++
        vl = vl (vl == "" ? "" : ", ") sheet_vendor(e)
      }
    }
    if ((key in panel) && real && nv < 2 && !any) out = out "; `" key "` has models from one vendor (" vl ")"
  }
  return substr(out, 3)
}
