# Approved entry points and their argument shapes. Adding a script under
# skills/ does not grant it automatic approval. Unknown forms stay silent.
BEGIN {
  CONTRACT["skills/show-me-your-work/scripts/log.sh"] = "log"
  CONTRACT["skills/reflect/scripts/find-transcript.mjs"] = "transcript"
  CONTRACT["skills/setup-pstack/scripts/check-sheet.sh"] = "optional-path"
  CONTRACT["skills/poteto-mode/scripts/check-playbooks.mjs"] = "optional-path"
  CONTRACT["skills/poteto-mode/scripts/check-plan.mjs"] = "one-path"
  CONTRACT["skills/poteto-mode/scripts/worktree-audit.mjs"] = "paths"
  CONTRACT["skills/poteto-mode/scripts/resume.mjs"] = "resume"
}

function script_contract(script, runner, T, first, n,    kind, count, i) {
  if (!(script in CONTRACT)) return 0
  kind = CONTRACT[script]
  if (runner != "") {
    if (kind == "log") { if (runner != "bash") return 0 }
    else if (script ~ /\.sh$/) { if (runner != "sh" && runner != "bash") return 0 }
    else if (runner != "node") return 0
  }
  count = n - first + 1
  if (kind == "log") return count == 6 && safe_path(T[first])
  if (kind == "transcript") {
    return (count == 2 || count == 3) && safe_path(T[first]) && T[first + 1] != "" \
      && (count == 2 || safe_path(T[first + 2]))
  }
  if (kind == "resume") return resume_contract(T, first, n)
  if (kind == "one-path" && count != 1) return 0
  if (kind == "optional-path" && count > 1) return 0
  for (i = first; i <= n; i++) if (!safe_path(T[i])) return 0
  return 1
}

# resume.mjs: operation first, then named paths. Only publication accepts
# note/artifact inputs. Both --option=value and --option value are supported.
function resume_contract(T, first, n,    op, i, arg, eq, key, value, seen) {
  op = T[first]
  if (op != "begin" && op != "read" && op != "publish") return 0
  for (i = first + 1; i <= n; i++) {
    arg = T[i]
    eq = index(arg, "=")
    key = eq ? substr(arg, 1, eq - 1) : arg
    if (key != "--project" && key != "--note" && key != "--artifact") return 0
    if (op != "publish" && key != "--project") return 0
    if (key != "--artifact" && key in seen) return 0
    seen[key] = 1
    if (eq) value = substr(arg, eq + 1)
    else {
      if (++i > n || T[i] ~ /^--/) return 0
      value = T[i]
    }
    if (!safe_path(value)) return 0
  }
  return op != "publish" || ("--note" in seen)
}
