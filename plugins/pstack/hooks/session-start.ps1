$ErrorActionPreference = 'Stop'

$sheetRoot = $env:CODEX_HOME
if (-not $sheetRoot) {
    $sheetRoot = Join-Path $env:USERPROFILE '.codex'
}
$sheet = Join-Path $sheetRoot 'pstack-models.md'
if ((Test-Path -LiteralPath $sheet) -and ([System.IO.File]::ReadAllLines($sheet) -ccontains 'session hook: off')) {
    exit 0
}

[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::Write([System.IO.File]::ReadAllText((Join-Path $env:CLAUDE_PLUGIN_ROOT 'hooks/session-start-context.md'), [System.Text.Encoding]::UTF8))
