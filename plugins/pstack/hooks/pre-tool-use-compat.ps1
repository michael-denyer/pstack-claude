$ErrorActionPreference = 'Stop'

# PowerShell 5.1 compatibility for json.awk: ConvertFrom-Json loses duplicate
# keys and ordinal key identity. Keep the same strict, string-only field access.
function Read-HookInput {
    $reader = [System.IO.StreamReader]::new(
        [Console]::OpenStandardInput(),
        [System.Text.UTF8Encoding]::new($false, $false)
    )
    $text = $reader.ReadToEnd()
    $script:JsonText = $text
    $script:JsonPosition = 0
    $script:JsonFailed = $false
    $value = Read-JsonValue
    Skip-JsonWhitespace
    if ($script:JsonFailed -or $script:JsonPosition -ne $text.Length) { return $null }
    return ,$value
}

function Skip-JsonWhitespace {
    while ($script:JsonPosition -lt $script:JsonText.Length -and
        [char]::IsWhiteSpace($script:JsonText[$script:JsonPosition]) -and
        [int]$script:JsonText[$script:JsonPosition] -in @(9, 10, 13, 32)) {
        $script:JsonPosition++
    }
}

function Read-JsonString {
    if ($script:JsonPosition -ge $script:JsonText.Length -or $script:JsonText[$script:JsonPosition] -ne '"') {
        $script:JsonFailed = $true
        return ''
    }
    $script:JsonPosition++
    $builder = [System.Text.StringBuilder]::new()
    $badUnicodeEscape = $false
    while ($script:JsonPosition -lt $script:JsonText.Length) {
        $character = $script:JsonText[$script:JsonPosition]
        $script:JsonPosition++
        if ($character -eq '"') {
            return [pscustomobject]@{ JsonString = $builder.ToString(); BadUnicodeEscape = $badUnicodeEscape }
        }
        if ([int]$character -lt 32) { $script:JsonFailed = $true; return '' }
        if ($character -ne '\') {
            [void]$builder.Append($character)
            continue
        }
        if ($script:JsonPosition -ge $script:JsonText.Length) { break }
        $escape = $script:JsonText[$script:JsonPosition]
        $script:JsonPosition++
        switch -CaseSensitive ($escape) {
            '"' { [void]$builder.Append('"') }
            '\' { [void]$builder.Append('\') }
            '/' { [void]$builder.Append('/') }
            'b' { [void]$builder.Append([char]8) }
            'f' { [void]$builder.Append([char]12) }
            'n' { [void]$builder.Append("`n") }
            'r' { [void]$builder.Append("`r") }
            't' { [void]$builder.Append("`t") }
            'u' {
                if ($script:JsonPosition + 4 -gt $script:JsonText.Length) {
                    $script:JsonFailed = $true
                    return ''
                }
                $hex = $script:JsonText.Substring($script:JsonPosition, 4)
                if ($hex -notmatch '^[0-9A-Fa-f]{4}$') {
                    $script:JsonFailed = $true
                    return ''
                }
                $code = [Convert]::ToInt32($hex, 16)
                if ($code -gt 127) { $badUnicodeEscape = $true }
                [void]$builder.Append([char]$code)
                $script:JsonPosition += 4
            }
            default { $script:JsonFailed = $true; return '' }
        }
    }
    $script:JsonFailed = $true
    return ''
}

function Read-JsonValue {
    Skip-JsonWhitespace
    if ($script:JsonPosition -ge $script:JsonText.Length) {
        $script:JsonFailed = $true
        return $null
    }
    $character = $script:JsonText[$script:JsonPosition]
    if ($character -eq '"') { return Read-JsonString }
    if ($character -eq '{') { return ,(Read-JsonObject) }
    if ($character -eq '[') { return ,(Read-JsonArray) }
    $remaining = $script:JsonText.Substring($script:JsonPosition)
    if ($remaining -cmatch '^(true|false|null)') {
        $script:JsonPosition += $Matches[1].Length
        return $null
    }
    $number = [regex]::Match($remaining, '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?')
    if ($number.Success) {
        $script:JsonPosition += $number.Length
        return $null
    }
    $script:JsonFailed = $true
    return $null
}

function Read-JsonObject {
    $script:JsonPosition++
    $value = [System.Collections.Generic.Dictionary[string, object]]::new([StringComparer]::Ordinal)
    Skip-JsonWhitespace
    if ($script:JsonPosition -lt $script:JsonText.Length -and $script:JsonText[$script:JsonPosition] -eq '}') {
        $script:JsonPosition++
        return ,$value
    }
    while ($script:JsonPosition -lt $script:JsonText.Length) {
        Skip-JsonWhitespace
        $key = Read-JsonString
        if ($script:JsonFailed -or $key -isnot [pscustomobject] -or
            $key.BadUnicodeEscape -or $value.ContainsKey($key.JsonString)) {
            $script:JsonFailed = $true
            return ,$value
        }
        Skip-JsonWhitespace
        if ($script:JsonPosition -ge $script:JsonText.Length -or $script:JsonText[$script:JsonPosition] -ne ':') {
            $script:JsonFailed = $true
            return ,$value
        }
        $script:JsonPosition++
        $item = Read-JsonValue
        $value.Add($key.JsonString, $item)
        if ($script:JsonFailed) { return ,$value }
        Skip-JsonWhitespace
        if ($script:JsonPosition -ge $script:JsonText.Length) { break }
        $separator = $script:JsonText[$script:JsonPosition]
        $script:JsonPosition++
        if ($separator -eq '}') { return ,$value }
        if ($separator -ne ',') { break }
    }
    $script:JsonFailed = $true
    return ,$value
}

function Read-JsonArray {
    $script:JsonPosition++
    $value = [System.Collections.Generic.List[object]]::new()
    Skip-JsonWhitespace
    if ($script:JsonPosition -lt $script:JsonText.Length -and $script:JsonText[$script:JsonPosition] -eq ']') {
        $script:JsonPosition++
        return ,$value
    }
    while ($script:JsonPosition -lt $script:JsonText.Length) {
        $value.Add((Read-JsonValue))
        if ($script:JsonFailed) { return ,$value }
        Skip-JsonWhitespace
        if ($script:JsonPosition -ge $script:JsonText.Length) { break }
        $separator = $script:JsonText[$script:JsonPosition]
        $script:JsonPosition++
        if ($separator -eq ']') { return ,$value }
        if ($separator -ne ',') { break }
    }
    $script:JsonFailed = $true
    return ,$value
}

function Get-JsonString([object]$object, [string]$name) {
    if ($object -is [System.Collections.Generic.Dictionary[string, object]] -and $object.ContainsKey($name)) {
        $value = $object[$name]
        if ($null -ne $value -and $value.PSObject.Properties['JsonString']) {
            if ($value.BadUnicodeEscape) { return '' }
            return $value.JsonString
        }
    }
    return ''
}

function Write-HookJson([object]$value) {
    $json = ConvertTo-Json -InputObject $value -Compress -Depth 4
    $bytes = [System.Text.UTF8Encoding]::new($false).GetBytes($json + "`n")
    $stream = [Console]::OpenStandardOutput()
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Flush()
}

# Windows path compatibility for pre-tool-use.awk's POSIX path checks.
function Test-PathText([string]$path) {
    return -not [string]::IsNullOrEmpty($path) -and $path -notmatch '[\x00-\x1f\x7f"]'
}

function Test-NoParentSegment([string]$path, [switch]$NoCurrent) {
    foreach ($segment in $path -split '[\\/]') {
        if ($segment -eq '..' -or ($NoCurrent -and $segment -eq '.')) { return $false }
    }
    return $true
}

function Get-FullWindowsPath([string]$path, [string]$base) {
    if (-not (Test-PathText $path) -or -not (Test-NoParentSegment $path)) { return '' }
    $normalized = $path.Replace('/', '\')
    if ($normalized.StartsWith('\\?\') -or $normalized.StartsWith('\\.\')) { return '' }
    $absolute = $normalized -match '^[A-Za-z]:\\' -or $normalized -match '^\\\\[^\\]+\\[^\\]+(?:\\|$)'
    if (-not $absolute) {
        if ([string]::IsNullOrEmpty($base)) { return '' }
        $normalized = [System.IO.Path]::Combine($base, $normalized)
    }
    try {
        $full = [System.IO.Path]::GetFullPath($normalized)
        $root = [System.IO.Path]::GetPathRoot($full)
        if ($full.Length -gt $root.Length) { $full = $full.TrimEnd('\') }
        return $full
    } catch { return '' }
}

function Test-NoReparsePoint([string]$path) {
    if ([string]::IsNullOrEmpty($path)) { return $false }
    $full = Get-FullWindowsPath $path ''
    if (-not $full) { return $false }
    $root = [System.IO.Path]::GetPathRoot($full)
    if (-not $root) { return $false }
    $current = $root
    $parts = $full.Substring($root.Length) -split '[\\/]'
    foreach ($part in $parts) {
        if (-not $part) { continue }
        $current = [System.IO.Path]::Combine($current, $part)
        if (Test-Path -LiteralPath $current) {
            try {
                if (([System.IO.File]::GetAttributes($current) -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { return $false }
            } catch { return $false }
        }
    }
    return $true
}

function Test-WithinPath([string]$path, [string]$base, [switch]$Strict) {
    if (-not $path -or -not $base) { return $false }
    $fullPath = Get-FullWindowsPath $path ''
    $fullBase = Get-FullWindowsPath $base ''
    if (-not $fullPath -or -not $fullBase) { return $false }
    if ($fullPath.Equals($fullBase, [StringComparison]::OrdinalIgnoreCase)) { return -not $Strict }
    $prefix = $fullBase.TrimEnd('\') + '\'
    return $fullPath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
}

function Resolve-SafePath([string]$path, [string]$cwd) {
    if (-not (Test-PathText $path) -or -not (Test-NoParentSegment $path)) { return '' }
    $full = Get-FullWindowsPath $path $cwd
    if (-not $full -or -not (Test-NoReparsePoint $full)) { return '' }
    return $full
}

function Get-PluginRelativePath([string]$path) {
    if (-not (Test-NoParentSegment $path -NoCurrent)) { return '' }
    $full = Resolve-SafePath $path ''
    if (-not $full -or -not (Test-WithinPath $full $script:Root -Strict)) { return '' }
    return $full.Substring($script:Root.TrimEnd('\').Length + 1).Replace('\', '/')
}

function Test-SafeWorkspacePath([string]$path, [string]$cwd) {
    $resolved = Resolve-SafePath $path $cwd
    return $resolved -and (Test-WithinPath $resolved $cwd)
}

function Test-SeparateWorkspace {
    return -not ((Test-WithinPath $script:Root $script:Cwd) -or (Test-WithinPath $script:Cwd $script:Root))
}

# Compatibility for words(): retain the strict shell form, but permit native
# Windows separators. Doubled/trailing backslashes remain ambiguous.
function Get-CommandWords([string]$command) {
    if ([string]::IsNullOrEmpty($command) -or $command -match '[;|&$`<>()"]' -or
        $command -match '[\x00-\x1f\x7f]') { return $null }
    $words = [System.Collections.Generic.List[object]]::new()
    $position = 0
    while ($position -lt $command.Length) {
        while ($position -lt $command.Length -and $command[$position] -eq ' ') { $position++ }
        if ($position -eq $command.Length) { break }
        $quoted = $command[$position] -eq "'"
        if ($quoted) {
            $position++
            $end = $command.IndexOf("'", $position)
            if ($end -lt 0) { return $null }
            $word = $command.Substring($position, $end - $position)
            $position = $end + 1
        } else {
            $start = $position
            while ($position -lt $command.Length -and $command[$position] -match '[A-Za-z0-9_./:=@%+,\-\\]') { $position++ }
            if ($position -eq $start) { return $null }
            $word = $command.Substring($start, $position - $start)
        }
        $backslashes = $word
        if ($backslashes.StartsWith('\\', [StringComparison]::Ordinal)) { $backslashes = $backslashes.Substring(2) }
        if ($backslashes.Contains('\\') -or $word.EndsWith('\', [StringComparison]::Ordinal)) { return $null }
        $words.Add([pscustomobject]@{ Value = $word; Quoted = $quoted })
        if ($position -lt $command.Length -and $command[$position] -ne ' ') { return $null }
    }
    return ,$words.ToArray()
}

# Host compatibility: PascalCase hooks send one call; CLI camelCase hooks can
# send a batch. Only an entirely allowed batch receives an allow decision.
function Get-HookDecision([object]$payload) {
    if ($payload -isnot [System.Collections.Generic.Dictionary[string, object]]) { return $null }
    $script:Cwd = Resolve-SafePath (Get-JsonString $payload 'cwd') ''
    $script:Root = Resolve-SafePath $env:COPILOT_PLUGIN_ROOT ''
    if (-not $script:Cwd -or -not $script:Root) { return $null }
    if ((Test-WithinPath $script:Root $script:Cwd -Strict) -or
        (Test-WithinPath $script:Cwd $script:Root -Strict)) { return $null }

    if ($payload.ContainsKey('toolCalls')) {
        $calls = $payload['toolCalls']
        if ($calls -isnot [System.Collections.Generic.List[object]] -or $calls.Count -eq 0) { return $null }
        $allAllowed = $true
        foreach ($call in $calls) {
            if ($call -isnot [System.Collections.Generic.Dictionary[string, object]]) {
                $allAllowed = $false
                continue
            }
            $decision = Get-PolicyDecision (Get-JsonString $call 'name') $call['args']
            if ($null -eq $decision) {
                $allAllowed = $false
                continue
            }
            if ($decision.permissionDecision -ceq 'deny') { return $decision }
        }
        if ($allAllowed) { return @{ permissionDecision = 'allow' } }
        return $null
    }
    if ($payload.ContainsKey('tool_name')) {
        return Get-PolicyDecision (Get-JsonString $payload 'tool_name') $payload['tool_input']
    }
    return Get-PolicyDecision (Get-JsonString $payload 'toolName') $payload['toolArgs']
}
