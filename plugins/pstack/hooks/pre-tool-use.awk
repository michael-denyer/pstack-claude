# Decides one GitHub Copilot PreToolUse call for pstack. Run after json.awk and
# sheet.awk, with the payload on stdin. Prints one decision object, or nothing,
# which leaves the call to Copilot's normal permission flow.
BEGIN {
  jread()
  if (!jobject("")) exit 0
  if ("tool_name" in M) { tool = jdecode(M["tool_name"]); P = "tool_input." }
  else { tool = jdecode(M["toolName"]); P = "toolArgs." }
  cwd = jdecode(M["cwd"])
  root = ENVIRON["PSTACK_ROOT"]
  real = ENVIRON["PSTACK_REAL_ROOT"]
  sheet = ENVIRON["PSTACK_SHEET"]
  sheet_real = ENVIRON["PSTACK_SHEET_REAL"]
  if (tool == "Read" || tool == "view") view_rule()
  else if (tool == "Agent" || tool == "Task" || tool == "task") task_rule()
  else if (tool == "Bash" || tool == "bash") bash_rule()
  else if (tool == "Write" || tool == "create") write_rule("create")
  else if (tool == "Edit" || tool == "edit") write_rule("edit")
  exit 0
}

function has(k) { return (P k) in M }
function arg(k) { return has(k) ? jdecode(M[P k]) : "" }

function allow() { print "{\"permissionDecision\":\"allow\"}" }
function deny(reason) { print "{\"permissionDecision\":\"deny\",\"permissionDecisionReason\":\"" esc(reason) "\"}" }

function control(s) { return s ~ /[\001-\037\177]/ }

# True when path is strictly below dir and every segment after dir is a name.
function under(path, dir,    rel, n, i, seg) {
  if (dir == "" || index(path, dir "/") != 1) return 0
  rel = substr(path, length(dir) + 2)
  n = split(rel, seg, "/")
  if (n == 0) return 0
  for (i = 1; i <= n; i++) if (seg[i] == "" || seg[i] == "." || seg[i] == "..") return 0
  return 1
}

# The plugin's own files: playbooks, references, and scripts.
function view_rule(    path) {
  path = arg("path")
  if (JBAD || path ~ /["\\]/ || control(path)) return
  if (under(path, root) || under(path, real)) allow()
}

# A pstack agent dispatched with an explicit model must use one of the user's
# saved choices. A call with no model, or for another agent, is not ours.
function task_rule(    type, model, seen, order, lines, i, list, aliases) {
  type = arg("agent_type")
  model = arg("model")
  if (JBAD || index(type, "pstack:") != 1 || model == "") return
  lines = sheet_ids(sheet, seen, order)
  if (lines <= 0 || (model in seen)) return
  list = ""
  aliases = 0
  for (i = 1; i <= SHEET_IDS; i++) {
    if (sheet_alias(order[i])) { aliases = 1; continue }
    list = list (list == "" ? "" : ", ") "`" order[i] "`"
  }
  if (list == "") {
    deny("pstack model check: every role in the user's saved pstack model choices (" sheet ") is inherit-parent or auto, so call `task` for " type " without `model`.")
    return
  }
  deny("pstack model check: `" model "` is not one of the user's saved pstack model choices (" sheet "). Set `model` to the model saved for this role: one of " list "." \
    (aliases ? " A role saved as inherit-parent or auto omits `model`." : "") \
    " To change the choices, the user reruns setup-pstack.")
}

# The sheet is checked before it is written, when the resulting text is known.
function write_rule(kind,    path, text, cur, old, rep, i, problems) {
  path = arg("path")
  if (path == "" || (path != sheet && path != sheet_real)) return
  if (kind == "create") {
    if (!has("file_text")) return
    text = arg("file_text")
  } else {
    if (!has("old_str") || !has("new_str")) return
    old = arg("old_str")
    rep = arg("new_str")
    if (old == "" || !slurp(path)) return
    cur = SLURP
    i = index(cur, old)
    if (i == 0 || index(substr(cur, i + 1), old) > 0) return
    text = substr(cur, 1, i - 1) rep substr(cur, i + length(old))
  }
  if (JBAD) return
  check_sheet(text)
}

function check_sheet(text,    problems) {
  problems = sheet_problems(text)
  if (problems == "") return
  deny("pstack sheet check: this write to " sheet " was blocked." problems \
    " Every role needs a line; each entry is inherit-parent, auto, or a model ID of lowercase letters, digits, dots, and hyphens;" \
    " and each panel needs models from at least two vendors, unless the user chose to keep a single-vendor panel, which the sheet records as the line `panel vendors: any`." \
    " Fix the text and write the sheet again.")
}

function slurp(file,    line, r) {
  SLURP = ""
  while ((r = (getline line < file)) > 0) SLURP = SLURP line "\n"
  close(file)
  return r == 0
}

function bash_rule(    cmd) {
  cmd = arg("command")
  if (JBAD) return
  if (index(cmd, sheet) || (sheet_real != "" && index(cmd, sheet_real))) heredoc_rule(cmd)
  else script_rule(cmd)
}

# setup-pstack replaces a saved sheet with `cat > '<sheet>' <<'EOF'`. A quoted
# delimiter keeps the body literal, so the written text is known.
function heredoc_rule(cmd,    L, n, h, tag, last, i, text, target) {
  n = split(cmd, L, "\n")
  h = L[1]
  if (!match(h, /[ ]+<<[ ]*('[A-Za-z_][A-Za-z0-9_]*'|"[A-Za-z_][A-Za-z0-9_]*")[ ]*$/)) return
  tag = substr(h, RSTART, RLENGTH)
  sub(/^[ ]+<<[ ]*./, "", tag)
  sub(/.[ ]*$/, "", tag)
  target = substr(h, 1, RSTART - 1)
  if (!sub(/^[ ]*cat[ ]+>[ ]*/, "", target)) return
  if (target ~ /^'.*'$/ || target ~ /^".*"$/) target = substr(target, 2, length(target) - 2)
  if (target != sheet && target != sheet_real) return
  last = n
  while (last > 1 && L[last] == "") last--
  if (last < 2 || L[last] != tag) return
  text = ""
  for (i = 2; i < last; i++) text = text L[i] "\n"
  check_sheet(text)
}

# Runs a vendored script without a prompt only in the strict form
# `[node|sh|bash] <plugin>/skills/<skill>/scripts/<path> [arg ...]`, where each
# argument is a plain word or a single-quoted string, and any path argument
# stays in the workspace or the plugin.
function script_rule(cmd,    n, T, Q, i, first, script) {
  if (cmd ~ /[;|&$`<>()\\"]/ || control(cmd)) return
  if (root == "" || (cwd != "" && (root == cwd || under(root, cwd) || real == cwd || under(real, cwd)))) return
  n = words(cmd, T, Q)
  if (n <= 0) return
  first = 1
  if (!Q[1] && (T[1] == "node" || T[1] == "sh" || T[1] == "bash")) first = 2
  if (first > n) return
  script = T[first]
  if (!script_path(script, root) && !script_path(script, real)) return
  for (i = first + 1; i <= n; i++) if (!safe_arg(T[i])) return
  allow()
}

function script_path(path, dir,    rel) {
  if (!under(path, dir)) return 0
  rel = substr(path, length(dir) + 2)
  return rel ~ /^skills\/[^\/]+\/scripts\/[^\/]/
}

# A path-like argument may not climb with `..` or reach outside the workspace
# and the plugin; in `--flag=/path`, the part after `=` is the path.
function safe_arg(a,    p, n, seg, i) {
  n = split(a, seg, "/")
  for (i = 1; i <= n; i++) if (seg[i] == "..") return 0
  p = a
  if (p ~ /^[^\/]*=\//) sub(/^[^\/]*=/, "", p)
  if (substr(p, 1, 1) != "/") return 1
  if (inside(p)) return 1
  return inside(resolve(p))
}

function inside(p) {
  return p == cwd || under(p, cwd) || under(p, root) || under(p, real)
}

# Copilot reports cwd as a real path (/private/tmp on macOS), while the agent
# may write the path it was given. Resolves the longest existing prefix of p.
# p holds no single quote, so quoting it for the shell is safe.
function resolve(p,    d, rest, cmd, out, i) {
  d = p
  rest = ""
  while (d != "" && d != "/") {
    cmd = "cd '" d "' 2>/dev/null && pwd -P"
    out = ""
    if ((cmd | getline out) > 0 && out != "") {
      close(cmd)
      return out rest
    }
    close(cmd)
    i = length(d)
    while (i > 0 && substr(d, i, 1) != "/") i--
    rest = substr(d, i) rest
    d = substr(d, 1, i - 1)
  }
  return p
}

# Splits cmd into T[1..n] on spaces. A word is plain, from a strict safe set, or
# single-quoted with no quote inside (Q[i] = 1). Returns -1 on anything else.
function words(cmd, T, Q,    n, rest, c, j) {
  n = 0
  rest = cmd
  while (1) {
    sub(/^ +/, "", rest)
    if (rest == "") return n
    c = substr(rest, 1, 1)
    if (c == "'") {
      j = index(substr(rest, 2), "'")
      if (j == 0) return -1
      T[++n] = substr(rest, 2, j - 1)
      Q[n] = 1
      rest = substr(rest, j + 2)
    } else {
      if (!match(rest, /^[A-Za-z0-9_.\/:=@%+,-]+/)) return -1
      T[++n] = substr(rest, 1, RLENGTH)
      Q[n] = 0
      rest = substr(rest, RLENGTH + 1)
    }
    if (rest != "" && substr(rest, 1, 1) != " ") return -1
  }
}
