# PowerShell compatibility for read-sheet.sh and sheet.awk. All native hooks
# use the same decoder; unreadable or undecodable sheets count as missing.
function ReadSheet([string] $path) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $null }
    try {
        $bytes = [System.IO.File]::ReadAllBytes($path)
        # Windows PowerShell 5.1's `>` writes UTF-16 LE with a byte-order mark.
        # Throw where iconv fails: on an odd byte count or an unpaired surrogate.
        $encoding = if ($bytes.Length -ge 2 -and $bytes[0] -eq 0xFF -and $bytes[1] -eq 0xFE) { [System.Text.UnicodeEncoding]::new($false, $false, $true) } else { [System.Text.UTF8Encoding]::new($false) }
        return ,(($encoding.GetString($bytes) -replace '^\uFEFF', '') -split "`n" | ForEach-Object { $_ -replace "`r$", '' })
    } catch { return $null }
}

# PowerShell's culture-based comparisons skip zero-width characters; sh and
# awk compare bytes, so sheet keys and values need ordinal comparisons.
function HasOrdinal([string[]] $list, [string] $item) {
    $null -ne $list -and [Array]::IndexOf($list, $item) -ge 0
}

function SheetValues([string[]] $lines) {
    $value = [System.Collections.Generic.Dictionary[string, string]]::new([System.StringComparer]::Ordinal)
    foreach ($line in $lines) {
        $colon = $line.IndexOf(':')
        if ($colon -lt 0 -or $line -cmatch '^[ \t]') { continue }
        $value[$line.Substring(0, $colon).Trim([char[]]" `t")] = $line.Substring($colon + 1).Trim([char[]]" `t")
    }
    return ,$value
}

# Muse keeps each usable role line, even when the whole sheet is not valid.
function MuseRoleLines([string[]] $lines) {
    $models = [System.IO.File]::ReadAllText((Join-Path (Split-Path $PSScriptRoot -Parent) 'models.json'), [System.Text.Encoding]::UTF8) | ConvertFrom-Json
    $efforts = @($models.efforts)
    $value = SheetValues $lines
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

# sheet_problems(): Copilot only uses role lines from a fully valid sheet.
function Get-SheetState([string[]]$lines) {
    $modelsPath = Join-Path (Split-Path $PSScriptRoot -Parent) 'models.json'
    $models = [System.IO.File]::ReadAllText($modelsPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
    $roles = @($models.roles | ForEach-Object { $_.role })
    $efforts = @($models.efforts)
    $panels = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($role in $models.roles) {
        if ($role.models -eq 'panel') { [void]$panels.Add($role.role) }
    }

    $values = SheetValues $lines
    $panelVendorsAny = $false
    foreach ($line in $lines) {
        if ($line.Length -eq 0 -or $line[0] -eq ' ' -or $line[0] -eq "`t") { continue }
        $colon = $line.IndexOf(':')
        if ($colon -lt 0) { continue }
        $key = $line.Substring(0, $colon).Trim([char[]]" `t")
        $value = $line.Substring($colon + 1).Trim([char[]]" `t")
        if ($key.Equals('panel vendors', [StringComparison]::Ordinal) -and $value.Equals('any', [StringComparison]::Ordinal)) { $panelVendorsAny = $true }
    }

    $problems = [System.Collections.Generic.List[string]]::new()
    $sheetModels = [System.Collections.Generic.Dictionary[string, bool]]::new([StringComparer]::Ordinal)
    $modelList = [System.Collections.Generic.List[string]]::new()
    $aliases = $false
    foreach ($role in $roles) {
        if (-not $values.ContainsKey($role)) { [void]$problems.Add("; missing role ``$role``") }
    }
    $effortOk = $values.ContainsKey('default effort') -and
        (HasOrdinal (@('session') + $efforts) $values['default effort'])
    if ($values.ContainsKey('default effort') -and -not $effortOk) {
        [void]$problems.Add('; default effort is not session or a level')
    }

    foreach ($role in $roles) {
        if (-not $values.ContainsKey($role)) { continue }
        if ($values[$role].Length -eq 0) {
            [void]$problems.Add("; no model in ``$role``")
            continue
        }
        $entries = $values[$role].Split(',')
        $vendors = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
        $hasRealModel = $false
        foreach ($raw in $entries) {
            $entry = $raw.Trim([char[]]" `t")
            $effort = [regex]::Match($entry, '[ \t]+@([a-z]+)$')
            if ($effort.Success -and (HasOrdinal $efforts $effort.Groups[1].Value)) {
                $entry = $entry.Substring(0, $entry.Length - $effort.Length)
            }
            if ($entry.Length -eq 0) {
                [void]$problems.Add("; an empty entry in ``$role``")
                continue
            }
            if (HasOrdinal @('inherit-parent', 'auto') $entry) {
                $aliases = $true
                $sheetModels[$entry] = $true
                continue
            }
            if ($entry -cnotmatch '^[a-z0-9][a-z0-9.-]*$') {
                [void]$problems.Add("; ``$role`` has an entry that is not a model ID")
                continue
            }
            if (-not $sheetModels.ContainsKey($entry)) {
                [void]$modelList.Add("``$entry``")
                $sheetModels[$entry] = $true
            }
            $hasRealModel = $true
            $vendor = $entry -replace '-.*$', ''
            [void]$vendors.Add($vendor)
        }
        if ($panels.Contains($role) -and $hasRealModel -and $vendors.Count -lt 2 -and -not $panelVendorsAny) {
            [void]$problems.Add("; ``$role`` has models from one vendor ($([string]::Join(', ', @($vendors))))")
        }
    }
    $problemText = if ($problems.Count) { $problems -join '' } else { '' }
    if ($problemText.StartsWith('; ', [StringComparison]::Ordinal)) {
        $problemText = $problemText.Substring(2)
    }
    $roleLines = [System.Collections.Generic.List[string]]::new()
    if ($problemText -eq '') {
        foreach ($role in $roles) { [void]$roleLines.Add("$role`: $($values[$role])") }
        if ($values.ContainsKey('default effort')) { [void]$roleLines.Add("default effort`: $($values['default effort'])") }
    }
    return [pscustomobject]@{
        Problems = $problemText
        Models = $sheetModels
        ModelList = [string]::Join(', ', $modelList)
        Aliases = $aliases
        RoleLines = @($roleLines)
    }
}
