param([string] $Runtime)
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'sheet.ps1')

# PowerShell compatibility for cat and the context awk readers. Keep file
# reading shared; each output format chooses its newline convention.
function ReadHookFile([string] $name) {
    [System.IO.File]::ReadAllText((Join-Path $PSScriptRoot $name), [System.Text.Encoding]::UTF8)
}

# muse-context.awk's emit() ends each line with a newline.
function AsLines([string] $text) {
    if ($text -and -not $text.EndsWith("`n", [System.StringComparison]::Ordinal)) { $text + "`n" } else { $text }
}

# copilot-context.awk's text() omits the file's final newline.
function AsText([string] $text) {
    if ($text.EndsWith("`n", [System.StringComparison]::Ordinal)) { $text.Substring(0, $text.Length - 1) } else { $text }
}

# Follow session-start.sh's runtime -> sheet/off -> output flow. Native home
# paths and Muse's interop guard are Windows compatibility.
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
        $userHomePath = if ($env:HOME) { $env:HOME } else { $env:USERPROFILE }
        $sheetRoot = if ($env:COPILOT_HOME) { $env:COPILOT_HOME } else { Join-Path $userHomePath '.copilot' }
        $sheet = Join-Path $sheetRoot 'pstack-models.md'
        $context = 'session-start-context.md'
    }
    default {
        [Console]::Error.WriteLine("session-start.ps1: unknown runtime '$Runtime' (expected codex, copilot, or muse)")
        exit 2
    }
}

$sheetLines = ReadSheet $sheet
if (HasOrdinal $sheetLines 'session hook: off') {
    exit 0
}

# PowerShell compatibility for the runtime output programs in session-start.sh.
switch -CaseSensitive ($Runtime) {
    'codex' {
        $output = ReadHookFile $context
    }
    'muse' {
        $output = AsLines (ReadHookFile $context)
        $roleLines = if ($null -eq $sheetLines) { @() } else { @(MuseRoleLines $sheetLines) }
        if ($roleLines.Count -gt 0) {
            $output += "`n" + (AsLines (ReadHookFile 'session-start-muse-sheet.md')) + (($roleLines -join "`n") + "`n")
        }
    }
    'copilot' {
        $output = AsText (ReadHookFile $context)
        $notes = AsText (ReadHookFile 'session-start-copilot.md')
        $sheetState = if ($null -eq $sheetLines) { $null } else { Get-SheetState $sheetLines }
        if ($null -ne $sheetState -and $sheetState.Problems -eq '') {
            $notes += "`n`n" + (AsText (ReadHookFile 'session-start-copilot-sheet.md')) + "`n"
            $notes += "`n" + ($sheetState.RoleLines -join "`n")
        } else {
            if ($null -ne $sheetState) { $notes += "`n`nsheet invalid: $($sheetState.Problems)" }
            $notes += "`n`n" + (AsText (ReadHookFile 'session-start-copilot-setup.md'))
        }
        $closeTag = '</EXTREMELY_IMPORTANT>'
        $index = $output.IndexOf($closeTag, [System.StringComparison]::Ordinal)
        if ($index -ge 0) {
            $output = $output.Substring(0, $index) + "`n" + $notes + "`n" + $output.Substring($index)
        } else {
            $output += "`n" + $notes
        }
        $output = (ConvertTo-Json -InputObject @{ additionalContext = $output + "`n" } -Compress) + "`n"
    }
}

[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::Write($output)
