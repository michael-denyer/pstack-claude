$ErrorActionPreference = 'Stop'

$sheetRoot = $env:CODEX_HOME
if (-not $sheetRoot) {
    $sheetRoot = Join-Path $env:USERPROFILE '.codex'
}
$sheet = Join-Path $sheetRoot 'pstack-models.md'
$off = $false
if (Test-Path -LiteralPath $sheet -PathType Leaf) {
    # An unreadable sheet leaves the hook on, as session-start.sh does.
    try {
        $bytes = [System.IO.File]::ReadAllBytes($sheet)
        # Windows PowerShell 5.1's `>` writes UTF-16 LE with a byte-order mark.
        $encoding = if ($bytes.Length -ge 2 -and $bytes[0] -eq 0xFF -and $bytes[1] -eq 0xFE) { [System.Text.Encoding]::Unicode } else { [System.Text.UTF8Encoding]::new($false) }
        $lines = $encoding.GetString($bytes).TrimStart([char]0xFEFF) -split "`n" | ForEach-Object { $_ -replace "`r$", '' }
        $off = $lines -ccontains 'session hook: off'
    } catch { }
}
if ($off) {
    exit 0
}

[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::Write([System.IO.File]::ReadAllText((Join-Path $PSScriptRoot 'session-start-context.md'), [System.Text.Encoding]::UTF8))
