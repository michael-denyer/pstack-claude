param([string] $Runtime)
$ErrorActionPreference = 'Stop'

function ReadHookFile([string] $name) {
    [System.IO.File]::ReadAllText((Join-Path $PSScriptRoot $name), [System.Text.Encoding]::UTF8)
}

# -ccontains, -ceq, and EndsWith(string) compare by culture, which skips
# zero-width characters, so sheet text is compared ordinally, as sh and awk
# compare bytes. The runtime argument comes from the hooks files, not the
# sheet, so its switch and -ceq stay as they are.
function HasOrdinal([string[]] $list, [string] $item) {
    $null -ne $list -and [Array]::IndexOf($list, $item) -ge 0
}

# muse-context.awk prints each file one line at a time, so its last line ends
# with a newline even when the file's does not.
function AsLines([string] $text) {
    if ($text -and -not $text.EndsWith("`n", [System.StringComparison]::Ordinal)) { $text + "`n" } else { $text }
}

# The sheet's role lines whose entries are all model IDs or aliases, each with
# an optional known effort, then a usable default effort, in models.json order.
# These are the lines sheet.awk accepts for muse-context.awk.
function MuseRoleLines([string[]] $lines) {
    $models = [System.IO.File]::ReadAllText((Join-Path (Split-Path $PSScriptRoot -Parent) 'models.json'), [System.Text.Encoding]::UTF8) | ConvertFrom-Json
    $efforts = @($models.efforts)
    $value = [System.Collections.Generic.Dictionary[string, string]]::new([System.StringComparer]::Ordinal)
    foreach ($line in $lines) {
        $colon = $line.IndexOf(':')
        if ($colon -lt 0 -or $line -cmatch '^[ \t]') { continue }
        $value[$line.Substring(0, $colon).Trim([char[]]" `t")] = $line.Substring($colon + 1).Trim([char[]]" `t")
    }
    foreach ($role in $models.roles.role) {
        if (-not $value.ContainsKey($role)) { continue }
        $usable = $true
        foreach ($raw in $value[$role].Split(',')) {
            $entry = $raw.Trim([char[]]" `t")
            if ($entry -cmatch '[ \t]+@([a-z]+)$' -and (HasOrdinal $efforts $Matches[1])) {
                $entry = $entry.Substring(0, $entry.Length - $Matches[0].Length)
            }
            $usable = $usable -and $entry -cmatch '^[a-z0-9][a-z0-9.-]*$'
        }
        if ($usable) { "$($role): $($value[$role])" }
    }
    $effort = $value['default effort']
    if (HasOrdinal (@('session') + $efforts) $effort) { "default effort: $effort" }
}

# Each runtime's hooks file passes its own name, as for session-start.sh.
switch -CaseSensitive ($Runtime) {
    'codex' {
        $sheetRoot = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
        $sheet = Join-Path $sheetRoot 'pstack-models.md'
        $context = 'session-start-context.md'
    }
    'muse' {
        # A Linux Muse under WSL can reach powershell.exe through interop, and
        # the sh hook owns that session. Interop should run this script from a
        # \\wsl UNC path, and passes MUSE_PLUGIN_ROOT only when WSLENV shares
        # it; neither signal has been run under WSL.
        if ($PSScriptRoot -like '\\wsl*' -or $env:MUSE_PLUGIN_ROOT -like '/*') {
            exit 0
        }
        # Muse drops USERPROFILE from the hook environment.
        $userProfile = if ($env:USERPROFILE) { $env:USERPROFILE } else { [System.Environment]::GetFolderPath('UserProfile') }
        $sheetRoot = if ($env:XDG_CONFIG_HOME) { $env:XDG_CONFIG_HOME } else { Join-Path $userProfile '.config' }
        $sheet = Join-Path (Join-Path $sheetRoot 'muse') 'pstack-models.md'
        $context = 'session-start-muse.md'
    }
    default {
        [Console]::Error.WriteLine("session-start.ps1: unknown runtime '$Runtime' (expected codex or muse)")
        exit 2
    }
}

# A missing or unreadable sheet leaves $sheetLines null and the hook on, as
# session-start.sh does. Decoding itself never fails here, unlike iconv in
# read-sheet.sh, so malformed UTF-16 reads differently (#335).
$sheetLines = $null
if (Test-Path -LiteralPath $sheet -PathType Leaf) {
    try {
        $bytes = [System.IO.File]::ReadAllBytes($sheet)
        # Windows PowerShell 5.1's `>` writes UTF-16 LE with a byte-order mark.
        $encoding = if ($bytes.Length -ge 2 -and $bytes[0] -eq 0xFF -and $bytes[1] -eq 0xFE) { [System.Text.Encoding]::Unicode } else { [System.Text.UTF8Encoding]::new($false) }
        $sheetLines = ($encoding.GetString($bytes) -replace '^\uFEFF', '') -split "`n" | ForEach-Object { $_ -replace "`r$", '' }
    } catch { }
}
if (HasOrdinal $sheetLines 'session hook: off') {
    exit 0
}

$output = ReadHookFile $context
# Muse reads stdout as plain context, so the sheet's checked role lines follow
# the mandate, as muse-context.awk prints them.
if ($Runtime -ceq 'muse') {
    $output = AsLines $output
    $roleLines = if ($null -eq $sheetLines) { @() } else { @(MuseRoleLines $sheetLines) }
    if ($roleLines.Count -gt 0) {
        $output += "`n" + (AsLines (ReadHookFile 'session-start-muse-sheet.md')) + (($roleLines -join "`n") + "`n")
    }
}
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::Write($output)
