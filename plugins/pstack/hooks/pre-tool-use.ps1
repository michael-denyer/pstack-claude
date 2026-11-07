$ErrorActionPreference = 'Stop'

# The script-contracts.awk registry and pre-tool-use.awk rules. Windows path,
# command and payload compatibility is isolated in pre-tool-use-compat.ps1.
$script:Contracts = [System.Collections.Generic.Dictionary[string, string]]::new([StringComparer]::Ordinal)
$script:Contracts['skills/show-me-your-work/scripts/log.sh'] = 'log'
$script:Contracts['skills/reflect/scripts/find-transcript.mjs'] = 'transcript'
$script:Contracts['skills/setup-pstack/scripts/check-sheet.sh'] = 'optional-path'
$script:Contracts['skills/poteto-mode/scripts/check-playbooks.mjs'] = 'optional-path'
$script:Contracts['skills/poteto-mode/scripts/check-plan.mjs'] = 'one-path'
$script:Contracts['skills/poteto-mode/scripts/worktree-audit.mjs'] = 'paths'
$script:Contracts['skills/poteto-mode/scripts/resume.mjs'] = 'resume'

function Test-ResumeContract([object[]]$words, [int]$first) {
    if ($first -ge $words.Count) { return $false }
    $operation = $words[$first].Value
    if ($operation -cnotin @('begin', 'read', 'publish')) { return $false }
    $seen = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    for ($i = $first + 1; $i -lt $words.Count; $i++) {
        $argument = $words[$i].Value
        $equals = $argument.IndexOf('=')
        $key = if ($equals -ge 0) { $argument.Substring(0, $equals) } else { $argument }
        if ($key -cnotin @('--project', '--note', '--artifact')) { return $false }
        if ($operation -cne 'publish' -and $key -cne '--project') { return $false }
        if ($key -cne '--artifact' -and -not $seen.Add($key)) { return $false }
        if ($equals -ge 0) {
            $value = $argument.Substring($equals + 1)
        } else {
            if (++$i -ge $words.Count -or $words[$i].Value.StartsWith('--', [StringComparison]::Ordinal)) { return $false }
            $value = $words[$i].Value
        }
        if (-not (Test-SafeWorkspacePath $value $script:Cwd)) { return $false }
        if ($key -ceq '--note') { [void]$seen.Add('--note') }
        if ($key -ceq '--artifact') { [void]$seen.Add('--artifact') }
    }
    return $operation -cne 'publish' -or $seen.Contains('--note')
}

function Test-ScriptContract([string]$scriptPath, [string]$runner, [object[]]$words, [int]$first) {
    $relative = Get-PluginRelativePath $scriptPath
    if (-not $script:Contracts.ContainsKey($relative)) { return $false }
    $kind = $script:Contracts[$relative]
    if ($runner) {
        if ($kind -ceq 'log') {
            if ($runner -cne 'bash') { return $false }
        } elseif ($relative.EndsWith('.sh', [StringComparison]::Ordinal)) {
            if ($runner -cnotin @('sh', 'bash')) { return $false }
        } elseif ($runner -cne 'node') { return $false }
    }
    $count = $words.Count - $first
    if ($kind -ceq 'log') { return $count -eq 6 -and (Test-SafeWorkspacePath $words[$first].Value $script:Cwd) }
    if ($kind -ceq 'transcript') {
        return ($count -eq 2 -or $count -eq 3) -and
            (Test-SafeWorkspacePath $words[$first].Value $script:Cwd) -and
            $words[$first + 1].Value -ne '' -and
            ($count -eq 2 -or (Test-SafeWorkspacePath $words[$first + 2].Value $script:Cwd))
    }
    if ($kind -ceq 'resume') { return Test-ResumeContract $words $first }
    if ($kind -ceq 'one-path' -and $count -ne 1) { return $false }
    if ($kind -ceq 'optional-path' -and $count -gt 1) { return $false }
    for ($i = $first; $i -lt $words.Count; $i++) {
        if (-not (Test-SafeWorkspacePath $words[$i].Value $script:Cwd)) { return $false }
    }
    return $true
}

function Get-ViewDecision([object]$toolInput) {
    $path = Get-JsonString $toolInput 'path'
    if (Get-PluginRelativePath $path) { return @{ permissionDecision = 'allow' } }
    return $null
}

function Get-TaskDecision([object]$toolInput) {
    $agentType = Get-JsonString $toolInput 'agent_type'
    $model = Get-JsonString $toolInput 'model'
    if (-not $agentType.StartsWith('pstack:', [StringComparison]::Ordinal) -or -not $model) { return $null }
    $sheetLines = ReadSheet $script:SheetPath
    if ($null -eq $sheetLines) { return $null }
    $sheet = Get-SheetState $sheetLines
    if ($sheet.Problems -ne '' -or $sheet.Models.ContainsKey($model)) { return $null }
    if ($sheet.ModelList -eq '') {
        $reason = "pstack model check: every role in the user's saved pstack model choices ($script:SheetPath) is inherit-parent or auto, so call ``task`` for $agentType without ``model``."
    } else {
        $reason = "pstack model check: ``$model`` is not one of the user's saved pstack model choices ($script:SheetPath). Set ``model`` to the model saved for this role: one of $($sheet.ModelList)."
        if ($sheet.Aliases) { $reason += ' A role saved as inherit-parent or auto omits ``model``.' }
        $reason += ' To change the choices, the user reruns setup-pstack.'
    }
    return @{ permissionDecision = 'deny'; permissionDecisionReason = $reason }
}

function Get-ScriptDecision([object]$toolInput) {
    $command = Get-JsonString $toolInput 'command'
    $words = Get-CommandWords $command
    if ($null -eq $words -or $words.Count -eq 0) { return $null }
    if (-not (Test-SeparateWorkspace)) { return $null }
    $first = 0
    $runner = ''
    if (-not $words[0].Quoted -and $words[0].Value -cin @('node', 'sh', 'bash')) {
        $runner = $words[0].Value
        $first = 1
    }
    if ($first -lt $words.Count -and (Test-ScriptContract $words[$first].Value $runner $words ($first + 1))) {
        return @{ permissionDecision = 'allow' }
    }
    return $null
}

function Get-PolicyDecision([string]$tool, [object]$toolInput) {
    if ($toolInput -isnot [System.Collections.Generic.Dictionary[string, object]]) { return $null }
    if ($tool -ceq 'Read' -or $tool -ceq 'view') { return Get-ViewDecision $toolInput }
    if ($tool -ceq 'Agent' -or $tool -ceq 'Task' -or $tool -ceq 'task') { return Get-TaskDecision $toolInput }
    if ($tool -ceq 'Bash' -or $tool -ceq 'bash') { return Get-ScriptDecision $toolInput }
    return $null
}

# The pre-tool-use.sh entry point: set inputs, load adapters, emit a decision.
# Copilot treats a nonzero exit as a denial, so report errors only on stderr.
try {
    . (Join-Path $PSScriptRoot 'pre-tool-use-compat.ps1')
    . (Join-Path $PSScriptRoot 'sheet.ps1')
    $sheetRoot = if ($env:COPILOT_HOME) { $env:COPILOT_HOME } elseif ($env:HOME) { Join-Path $env:HOME '.copilot' } else { Join-Path $env:USERPROFILE '.copilot' }
    $script:SheetPath = Join-Path $sheetRoot 'pstack-models.md'
    $decision = Get-HookDecision (Read-HookInput)
    if ($null -ne $decision) { Write-HookJson $decision }
} catch {
    [Console]::Error.WriteLine("pre-tool-use.ps1: $($_.Exception.Message)")
}
exit 0
