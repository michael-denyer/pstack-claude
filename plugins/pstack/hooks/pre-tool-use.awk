# Decides one GitHub Copilot PreToolUse call for pstack. Run after json.awk,
# sheet.awk, and script-contracts.awk, with the payload on stdin. Prints one decision
# object, or nothing, which leaves the call to Copilot's normal permission flow.
# Copilot sends Claude-format input to PascalCase hooks, so `view` arrives as
# `Read`.
BEGIN {
  if (!jparse()) exit 0
  if ("/tool_name" in JT) { tool = jget("/tool_name"); P = "/tool_input" }
  else { tool = jget("/toolName"); P = "/toolArgs" }
  if (JT[P] != "object") exit 0
  cwd = jget("/cwd")
  root = ENVIRON["PSTACK_ROOT"]
  real = ENVIRON["PSTACK_REAL_ROOT"]
  sheet = ENVIRON["PSTACK_SHEET"]
  if (tool == "Read" || tool == "view") view_rule()
  else if (tool == "Agent" || tool == "Task" || tool == "task") task_rule()
  else if (tool == "Bash" || tool == "bash") script_rule(arg("command"))
  exit 0
}

function arg(k) { return jget(P "/" k) }

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
function task_rule(    type, model) {
  type = arg("agent_type")
  model = arg("model")
  if (JBAD || index(type, "pstack:") != 1 || model == "") return
  if (!sheet_read(sheet) || sheet_problems() != "") return
  if (model in SHEET_MODELS) return
  if (MODEL_LIST == "") {
    deny("pstack model check: every role in the user's saved pstack model choices (" sheet ") is inherit-parent or auto, so call `task` for " type " without `model`.")
    return
  }
  deny("pstack model check: `" model "` is not one of the user's saved pstack model choices (" sheet "). Set `model` to the model saved for this role: one of " MODEL_LIST "." \
    (MODEL_ALIASES ? " A role saved as inherit-parent or auto omits `model`." : "") \
    " To change the choices, the user reruns setup-pstack.")
}

# Tokenize a strict shell form, then let the registered script contract select
# its path operands. Prose and operation names are not filesystem paths.
function script_rule(cmd,    n, T, Q, first, script, runner, rel) {
  if (JBAD || cmd ~ /[;|&$`<>()\\"]/ || control(cmd)) return
  cwd = resolve(cwd)
  # A workspace that holds the plugin, or sits in it, could rewrite its files.
  if (root == "" || cwd == "" || root == cwd || under(root, cwd) || under(cwd, root) \
    || real == cwd || under(real, cwd) || under(cwd, real)) return
  n = words(cmd, T, Q)
  if (n <= 0) return
  first = 1
  if (!Q[1] && (T[1] == "node" || T[1] == "sh" || T[1] == "bash")) {
    runner = T[1]
    first = 2
  }
  if (first > n) return
  script = T[first]
  if (under(script, root)) rel = substr(script, length(root) + 2)
  else if (under(script, real)) rel = substr(script, length(real) + 2)
  else return
  if (script_contract(rel, runner, T, first + 1, n)) allow()
}

# Called only for path operands identified by a script contract.
function safe_path(p,    n, seg, i) {
  if (p == "") return 0
  n = split(p, seg, "/")
  for (i = 1; i <= n; i++) if (seg[i] == "..") return 0
  if (substr(p, 1, 1) != "/") {
    if (cwd == "") return 0
    p = cwd "/" p
  }
  return inside(resolve(p))
}

# Path operands stay in the workspace: one in the plugin could rewrite the
# context every later session loads.
function inside(p) {
  return p != "" && (p == cwd || under(p, cwd))
}

# Copilot reports cwd as a real path (/private/tmp on macOS), while the agent
# may write the path it was given. Resolves the longest existing directory
# prefix of p. File and dangling symlinks take the normal permission flow.
function resolve(p,    d, rest, cmd, out, extra, i) {
  if (p == "" || p ~ /'/ || control(p)) return ""
  d = p
  rest = ""
  while (d != "" && d != "/") {
    cmd = "if cd '" d "' 2>/dev/null; then pwd -P; elif [ -L '" d "' ]; then printf '%s\\n' '!symlink'; fi"
    out = ""
    if ((cmd | getline out) > 0 && out != "") {
      if ((cmd | getline extra) > 0) out = ""
      close(cmd)
      if (out == "" || out == "!symlink" || control(out)) return ""
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
