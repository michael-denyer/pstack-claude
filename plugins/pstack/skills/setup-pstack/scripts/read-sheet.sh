#!/bin/sh
# Decode the sheet once, before any consumer interprets its lines. PowerShell
# 5.1 writes UTF-16LE; other writers may add a UTF-8 BOM or CRLF line endings.
set -eu
sheet=$1
[ -f "$sheet" ] && [ -r "$sheet" ] || exit 1
utf16=false
if [ "$(od -An -tx1 -N2 "$sheet" | tr -d ' ')" = fffe ]; then
  # A sheet iconv cannot decode counts as missing, and iconv's message stays
  # off the hook's stderr.
  iconv -f UTF-16LE -t UTF-8 "$sheet" >/dev/null 2>&1 || exit 1
  utf16=true
fi
bom=$(printf '\357\273\277')
cr=$(printf '\r')
# Command substitution in the callers drops NUL bytes, which would join the
# text around a NUL into a line the sheet never held. NUL travels as \001
# instead: neither byte can appear in a line any consumer accepts.
if $utf16; then iconv -f UTF-16LE -t UTF-8 "$sheet"; else cat "$sheet"; fi |
  tr '\000' '\001' | sed -e "1s/^$bom//" -e "s/$cr\$//"
