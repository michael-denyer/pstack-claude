# Decides one GitHub Copilot PreToolUse call for pstack. Run after json.awk and
# setup-pstack's sheet.awk, with the payload on stdin. Prints one decision
# object, or nothing, which leaves the call to Copilot's normal permission flow.
# Copilot sends Claude-format input to PascalCase hooks, so `view` arrives as
# `Read`.
BEGIN {
  jread()
  if (!jobject("")) exit 0
  if ("tool_name" in M) { tool = jdecode(M["tool_name"]); P = "tool_input." }
  else { tool = jdecode(M["toolName"]); P = "toolArgs." }
  cwd = jdecode(M["cwd"])
  root = ENVIRON["PSTACK_ROOT"]
  real = ENVIRON["PSTACK_REAL_ROOT"]
  sheet = ENVIRON["PSTACK_SHEET"]
  if (tool == "Read" || tool == "view") view_rule()
  else if (tool == "Agent" || tool == "Task" || tool == "task") task_rule()
  else if (tool == "Bash" || tool == "bash") script_rule(arg("command"))
  exit 0
}

function arg(k) { return (P k) in M ? jdecode(M[P k]) : "" }

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
# saved choices in a valid sheet. A call with no model, or for another agent,
# is not ours.
function task_rule(    type, model, n, roles, panel, i, j, m, E, e, seen, list, aliases) {
  type = arg("agent_type")
  model = arg("model")
  if (JBAD || index(type, "pstack:") != 1 || model == "") return
  if (!sheet_read(sheet) || sheet_problems() != "") return
  n = sheet_roles(roles, panel)
  split("", seen)
  list = ""
  aliases = 0
  for (i = 1; i <= n; i++) {
    m = split(VALUE[roles[i]], E, ",")
    for (j = 1; j <= m; j++) {
      e = sheet_model(sheet_trim(E[j]))
      if (e in seen) continue
      seen[e] = 1
      if (sheet_alias(e)) aliases = 1
      else list = list (list == "" ? "" : ", ") "`" e "`"
    }
  }
  if (model in seen) return
  if (list == "") {
    deny("pstack model check: every role in the user's saved pstack model choices (" sheet ") is inherit-parent or auto, so call `task` for " type " without `model`.")
    return
  }
  deny("pstack model check: `" model "` is not one of the user's saved pstack model choices (" sheet "). Set `model` to the model saved for this role: one of " list "." \
    (aliases ? " A role saved as inherit-parent or auto omits `model`." : "") \
    " To change the choices, the user reruns setup-pstack.")
}

# Runs a vendored script without a prompt only in the strict form
# `[node|sh|bash] <plugin>/skills/<skill>/scripts/<path> [arg ...]`, where each
# argument is a plain word or a single-quoted string, and any path argument
# stays in the workspace or the plugin.
function script_rule(cmd,    n, T, Q, i, first, script) {
  if (JBAD || cmd ~ /[;|&$`<>()\\"]/ || control(cmd)) return
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
