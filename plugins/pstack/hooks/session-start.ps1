$ErrorActionPreference = 'Stop'

$sheetRoot = $env:CODEX_HOME
if (-not $sheetRoot) {
    $sheetRoot = Join-Path $env:USERPROFILE '.codex'
}
$sheet = Join-Path $sheetRoot 'pstack-models.md'
$off = $false
if (Test-Path -LiteralPath $sheet -PathType Leaf) {
    # An unreadable sheet leaves the hook on, as session-start.sh does.
    try { $off = [System.IO.File]::ReadAllLines($sheet) -ccontains 'session hook: off' } catch { }
}
if ($off) {
    exit 0
}

[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::Write([System.IO.File]::ReadAllText((Join-Path $PSScriptRoot 'session-start-context.md'), [System.Text.Encoding]::UTF8))
