param([string] $Runtime)
$ErrorActionPreference = 'Stop'

# Each runtime's hooks file passes its own name, as for session-start.sh.
switch -CaseSensitive ($Runtime) {
    'codex' {
        $sheetRoot = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
        $context = 'session-start-context.md'
    }
    default {
        [Console]::Error.WriteLine("session-start.ps1: unknown runtime '$Runtime' (expected codex)")
        exit 2
    }
}
$sheet = Join-Path $sheetRoot 'pstack-models.md'

# A missing or unreadable sheet leaves $sheetLines null and the hook on, as
# session-start.sh does.
$sheetLines = $null
if (Test-Path -LiteralPath $sheet -PathType Leaf) {
    try {
        $bytes = [System.IO.File]::ReadAllBytes($sheet)
        # Windows PowerShell 5.1's `>` writes UTF-16 LE with a byte-order mark.
        $encoding = if ($bytes.Length -ge 2 -and $bytes[0] -eq 0xFF -and $bytes[1] -eq 0xFE) { [System.Text.Encoding]::Unicode } else { [System.Text.UTF8Encoding]::new($false) }
        $sheetLines = $encoding.GetString($bytes).TrimStart([char]0xFEFF) -split "`n" | ForEach-Object { $_ -replace "`r$", '' }
    } catch { }
}
if ($sheetLines -ccontains 'session hook: off') {
    exit 0
}

[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::Write([System.IO.File]::ReadAllText((Join-Path $PSScriptRoot $context), [System.Text.Encoding]::UTF8))
