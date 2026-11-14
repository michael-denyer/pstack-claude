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

# copilot-context.awk's text() drops only the file's final newline.
function AsText([string] $text) {
    if ($text.EndsWith("`n", [System.StringComparison]::Ordinal)) { $text.Substring(0, $text.Length - 1) } else { $text }
}

# sheet.awk's sheet_problems(), in its order and wording, and the role lines
# whose entries are all model IDs or aliases, each with an optional known
# effort, then a usable default effort, in models.json order. Muse keeps each
# usable line. Copilot takes the lines only from a sheet with no problems. A
# problem quotes no unchecked sheet text, since both reach the session context.
function ModelSheet([string[]] $lines) {
    $models = [System.IO.File]::ReadAllText((Join-Path (Split-Path $PSScriptRoot -Parent) 'models.json'), [System.Text.Encoding]::UTF8) | ConvertFrom-Json
    $efforts = @($models.efforts)
    $value = [System.Collections.Generic.Dictionary[string, string]]::new([System.StringComparer]::Ordinal)
    $anyVendor = $false
    foreach ($line in $lines) {
        $colon = $line.IndexOf(':')
        if ($colon -lt 0 -or $line -cmatch '^[ \t]') { continue }
        $key = $line.Substring(0, $colon).Trim([char[]]" `t")
        $value[$key] = $line.Substring($colon + 1).Trim([char[]]" `t")
        if ($key.Equals('panel vendors', [System.StringComparison]::Ordinal) -and $value[$key].Equals('any', [System.StringComparison]::Ordinal)) { $anyVendor = $true }
    }
    $problems = ''
    foreach ($role in $models.roles.role) {
        if (-not $value.ContainsKey($role)) { $problems += "; missing role ``$role``" }
    }
    if ($value.ContainsKey('default effort') -and -not (HasOrdinal (@('session') + $efforts) $value['default effort'])) {
        $problems += '; default effort is not session or a level'
    }
    $roleLines = @()
    foreach ($role in $models.roles) {
        $name = $role.role
        if (-not $value.ContainsKey($name)) { continue }
        if ($value[$name].Length -eq 0) {
            $problems += "; no model in ``$name``"
            continue
        }
        $vendors = [System.Collections.Generic.List[string]]::new()
        $real = $false
        $usable = $true
        foreach ($raw in $value[$name].Split(',')) {
            $entry = $raw.Trim([char[]]" `t")
            if ($entry -cmatch '[ \t]+@([a-z]+)$' -and (HasOrdinal $efforts $Matches[1])) {
                $entry = $entry.Substring(0, $entry.Length - $Matches[0].Length)
            }
            if ($entry.Length -eq 0) {
                $problems += "; an empty entry in ``$name``"
                $usable = $false
                continue
            }
            if (HasOrdinal @('inherit-parent', 'auto') $entry) { continue }
            if ($entry -cnotmatch '^[a-z0-9][a-z0-9.-]*$') {
                $problems += "; ``$name`` has an entry that is not a model ID"
                $usable = $false
                continue
            }
            $real = $true
            $vendor = $entry -replace '-.*$', ''
            if (-not $vendors.Contains($vendor)) { $vendors.Add($vendor) }
        }
        if ($usable) { $roleLines += "$($name): $($value[$name])" }
        if ($role.models -ceq 'panel' -and $real -and $vendors.Count -lt 2 -and -not $anyVendor) {
            $problems += "; ``$name`` has models from one vendor ($($vendors -join ', '))"
        }
    }
    $effort = $value['default effort']
    if (HasOrdinal (@('session') + $efforts) $effort) { $roleLines += "default effort: $effort" }
    [pscustomobject]@{ Problems = $(if ($problems) { $problems.Substring(2) } else { '' }); RoleLines = $roleLines }
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
    'copilot' {
        $sheetRoot = if ($env:COPILOT_HOME) { $env:COPILOT_HOME } else { Join-Path $env:USERPROFILE '.copilot' }
        $sheet = Join-Path $sheetRoot 'pstack-models.md'
        $context = 'session-start-context.md'
    }
    default {
        [Console]::Error.WriteLine("session-start.ps1: unknown runtime '$Runtime' (expected codex, copilot, or muse)")
        exit 2
    }
}

# A missing, unreadable, or undecodable sheet leaves $sheetLines null and the
# hook on, as session-start.sh does.
$sheetLines = $null
if (Test-Path -LiteralPath $sheet -PathType Leaf) {
    try {
        $bytes = [System.IO.File]::ReadAllBytes($sheet)
        # Windows PowerShell 5.1's `>` writes UTF-16 LE with a byte-order mark.
        # The decoder throws where iconv in read-sheet.sh fails: on an odd byte
        # count or an unpaired surrogate.
        $encoding = if ($bytes.Length -ge 2 -and $bytes[0] -eq 0xFF -and $bytes[1] -eq 0xFE) { [System.Text.UnicodeEncoding]::new($false, $false, $true) } else { [System.Text.UTF8Encoding]::new($false) }
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
    $roleLines = if ($null -eq $sheetLines) { @() } else { @((ModelSheet $sheetLines).RoleLines) }
    if ($roleLines.Count -gt 0) {
        $output += "`n" + (AsLines (ReadHookFile 'session-start-muse-sheet.md')) + (($roleLines -join "`n") + "`n")
    }
}
# Copilot reads one JSON object, as copilot-context.awk prints it: the mandate
# with the Copilot notes and the sheet's role lines or setup's note before its
# closing tag.
if ($Runtime -ceq 'copilot') {
    $notes = AsText (ReadHookFile 'session-start-copilot.md')
    $state = if ($null -eq $sheetLines) { $null } else { ModelSheet $sheetLines }
    if ($null -ne $state -and $state.Problems.Length -eq 0) {
        $notes += "`n`n" + (AsText (ReadHookFile 'session-start-copilot-sheet.md')) + "`n`n" + ($state.RoleLines -join "`n")
    } else {
        if ($null -ne $state) { $notes += "`n`nsheet invalid: $($state.Problems)" }
        $notes += "`n`n" + (AsText (ReadHookFile 'session-start-copilot-setup.md'))
    }
    $output = AsText $output
    $close = $output.IndexOf('</EXTREMELY_IMPORTANT>', [System.StringComparison]::Ordinal)
    if ($close -ge 0) { $output = $output.Substring(0, $close) + "`n" + $notes + "`n" + $output.Substring($close) } else { $output += "`n" + $notes }
    $output = (ConvertTo-Json -InputObject @{ additionalContext = $output + "`n" } -Compress) + "`n"
}
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::Write($output)
