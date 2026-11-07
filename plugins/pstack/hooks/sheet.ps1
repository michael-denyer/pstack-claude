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
