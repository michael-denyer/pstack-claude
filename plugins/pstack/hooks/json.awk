# JSON helpers for the Copilot hooks. POSIX awk, run under LC_ALL=C.

# Escapes s as JSON string content: backslash, double quote, tab, and carriage
# return are escaped, and other control characters are dropped.
function esc(s,    out, i, c) {
  if (!esc_ready) {
    for (i = 1; i < 32; i++) esc_ctl[sprintf("%c", i)] = 1
    esc_ctl[sprintf("%c", 127)] = 1
    delete esc_ctl["\t"]
    delete esc_ctl["\r"]
    esc_ready = 1
  }
  out = ""
  for (i = 1; i <= length(s); i++) {
    c = substr(s, i, 1)
    if (c == "\\") out = out "\\\\"
    else if (c == "\"") out = out "\\\""
    else if (c == "\t") out = out "\\t"
    else if (c == "\r") out = out "\\r"
    else if (!(c in esc_ctl)) out = out c
  }
  return out
}

# Decodes raw JSON string content. A \u escape above U+007F sets JBAD, because
# the byte form awk would write is not dependable; callers then stay silent.
function jdecode(s,    out, i, c, h) {
  out = ""
  while ((i = index(s, "\\")) > 0) {
    out = out substr(s, 1, i - 1)
    c = substr(s, i + 1, 1)
    if (c == "n") out = out "\n"
    else if (c == "t") out = out "\t"
    else if (c == "r") out = out "\r"
    else if (c == "b") out = out sprintf("%c", 8)
    else if (c == "f") out = out sprintf("%c", 12)
    else if (c == "u") {
      h = jhex(substr(s, i + 2, 4))
      if (h < 1 || h > 127) JBAD = 1
      else out = out sprintf("%c", h)
      s = substr(s, i + 6)
      continue
    } else out = out c
    s = substr(s, i + 2)
  }
  return out s
}

function jhex(h,    v, i, d) {
  if (h !~ /^[0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f]$/) return -1
  v = 0
  for (i = 1; i <= 4; i++) {
    d = index("0123456789abcdef", tolower(substr(h, i, 1))) - 1
    v = v * 16 + d
  }
  return v
}

# Reads the whole of standard input into J.
function jread(    line, first) {
  J = ""
  first = 1
  while ((getline line) > 0) {
    J = J (first ? "" : "\n") line
    first = 0
  }
  jpos = 1
  jlen = length(J)
}

function jws() {
  while (jpos <= jlen && index(" \t\r\n", substr(J, jpos, 1)) > 0) jpos++
}

# Consumes the string at jpos and leaves its raw content in JRAW.
function jstring() {
  if (!match(substr(J, jpos), /^"([^"\\\001-\037]|\\(["\\\/bfnrt]|u[0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f]))*"/)) return 0
  JRAW = substr(J, jpos + 1, RLENGTH - 2)
  jpos += RLENGTH
  return 1
}

function jprim() {
  if (!match(substr(J, jpos), /^(-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?|true|false|null)/)) return 0
  jpos += RLENGTH
  return 1
}

function jvalue(path,    c) {
  jws()
  c = substr(J, jpos, 1)
  if (c == "{") return jobject(path)
  if (c == "[") return jarray(path)
  if (c == "\"") {
    if (!jstring()) return 0
    JT[path] = "string"
    M[path] = JRAW
    return 1
  }
  JT[path] = "primitive"
  return jprim()
}

# JSON Pointer escapes preserve literal slashes, tildes, and dotted keys.
function jkey(key) {
  gsub(/~/, "~0", key)
  gsub(/\//, "~1", key)
  return key
}

# Stores node types in JT and raw string values in M. Duplicate object keys
# are rejected so a permission decision never depends on parser precedence.
function jobject(prefix,    key, c, path) {
  jws()
  if (substr(J, jpos, 1) != "{") return 0
  JT[prefix] = "object"
  jpos++
  jws()
  if (substr(J, jpos, 1) == "}") { jpos++; return 1 }
  while (1) {
    jws()
    if (substr(J, jpos, 1) != "\"" || !jstring()) return 0
    key = jdecode(JRAW)
    path = prefix "/" jkey(key)
    if (path in JT) return 0
    jws()
    if (substr(J, jpos, 1) != ":") return 0
    jpos++
    if (!jvalue(path)) return 0
    jws()
    c = substr(J, jpos, 1)
    jpos++
    if (c == "}") return 1
    if (c != ",") return 0
  }
}

function jarray(path,    c, i) {
  JT[path] = "array"
  i = 0
  jpos++
  jws()
  if (substr(J, jpos, 1) == "]") { jpos++; return 1 }
  while (1) {
    if (!jvalue(path "/" i++)) return 0
    jws()
    c = substr(J, jpos, 1)
    jpos++
    if (c == "]") return 1
    if (c != ",") return 0
  }
}

# The hook consumes one complete object, never a valid prefix of bad input.
function jparse() {
  jread()
  if (!jobject("")) return 0
  jws()
  return !JBAD && jpos > jlen
}

function jget(path) {
  return JT[path] == "string" ? jdecode(M[path]) : ""
}
