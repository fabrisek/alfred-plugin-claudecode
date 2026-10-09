# Accept "Fable as advisor" on Claude seats that refuse it (Team standard).
#
# Prerequisite, done once by the organization's owner on claude.ai: enable
# extra usage (usage credits) for the Team organization. Without it the seat
# cannot accept, whatever is typed below. Fable as advisor then bills to
# those credits.
#
# For each seat (default: every seat whose id or label contains "standard",
# or the seat ids given as arguments) this opens an interactive `claude`
# session on that seat's config dir, in this console. In it, type:
#     /model fable      then accept the usage-credits prompt
#     /exit
# Then the script checks the seat's .claude.json for the consent and asks the
# CLI (no model call) whether it now applies the advisor.
#
#   powershell -ExecutionPolicy Bypass -File scripts\advisor-consent.ps1 [seatId ...]
#
# Nothing to restart afterwards: every new Claude session Alfred starts on the
# seat asks again and picks the advisor up.
param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Seats)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$pool = Get-Content -Raw -Encoding UTF8 (Join-Path $root 'state\accounts.json') | ConvertFrom-Json
$claude = (Get-Command claude -ErrorAction SilentlyContinue).Source
if (-not $claude) { throw 'The claude CLI is not on PATH.' }

$targets = @($pool.accounts | Where-Object {
    if ($Seats -and $Seats.Count -gt 0) { $Seats -contains $_.id }
    else { $_.enabled -and $_.configDir -and ($_.id -match 'standard' -or $_.label -match 'standard') }
  })
if ($targets.Count -eq 0) { throw 'No matching seat (pass seat ids, e.g. claude-standard1).' }

function Read-Consent($dir) {
  $file = Join-Path $dir '.claude.json'
  if (-not (Test-Path $file)) { return $null }
  $j = Get-Content -Raw -Encoding UTF8 $file | ConvertFrom-Json
  $o = $j.oauthAccount
  $keys = @()
  if ($o.organizationUuid) { $keys += $o.organizationUuid }
  if ($o.accountUuid) { $keys += "acct:$($o.accountUuid)" }
  $consent = $false
  if ($j.fableOverageConsentV2) {
    foreach ($k in $keys) { if ($j.fableOverageConsentV2.$k -eq $true) { $consent = $true } }
  }
  [pscustomobject]@{
    Email      = $o.emailAddress
    Consent    = $consent
    ExtraUsage = $j.cachedExtraUsageDisabledReason
  }
}

$saved = @{}
foreach ($k in [Environment]::GetEnvironmentVariables().Keys) {
  if ($k -like 'ANTHROPIC_*' -or ($k -like 'CLAUDE_CODE_*' -and $k -ne 'CLAUDE_CODE_GIT_BASH_PATH') -or $k -eq 'CLAUDE_CONFIG_DIR') {
    $saved[$k] = [Environment]::GetEnvironmentVariable($k)
  }
}

$summary = @()
try {
  foreach ($k in $saved.Keys) { Remove-Item "Env:$k" -ErrorAction SilentlyContinue }
  foreach ($a in $targets) {
    $before = Read-Consent $a.configDir
    Write-Host ''
    Write-Host "=== $($a.id) ($($before.Email))" -ForegroundColor Cyan
    if ($before.Consent) { Write-Host 'Consent already recorded on this seat.' -ForegroundColor Green }
    else {
      Write-Host 'A Claude session opens on this seat. Type:' -ForegroundColor Yellow
      Write-Host '    /model fable     (accept the usage-credits prompt)'
      Write-Host '    /exit'
      Read-Host 'Press Enter to open it' | Out-Null
      $env:CLAUDE_CONFIG_DIR = $a.configDir
      & $claude
      Remove-Item Env:CLAUDE_CONFIG_DIR -ErrorAction SilentlyContinue
    }
    $after = Read-Consent $a.configDir
    # Definitive answer from the CLI itself: the advisor it would send (no model call).
    $probe = & node (Join-Path $root 'tests\advisor-probe.mjs') $a.id 2>&1 | Select-String 'applied:' | Select-Object -First 1
    $active = "$probe" -match '"advisor":"claude-fable'
    $summary += [pscustomobject]@{
      Seat       = $a.id
      Consent    = $after.Consent
      ExtraUsage = if ($null -eq $after.ExtraUsage) { 'enabled' } else { $after.ExtraUsage }
      Advisor    = if ($active) { 'accepted' } else { 'refused' }
    }
  }
}
finally {
  foreach ($k in $saved.Keys) { [Environment]::SetEnvironmentVariable($k, $saved[$k], 'Process') }
}

Write-Host ''
$summary | Format-Table -AutoSize
foreach ($s in $summary | Where-Object { $_.Advisor -eq 'refused' }) {
  if (-not $s.Consent) { Write-Host "$($s.Seat): no consent recorded. Run the script again for it and accept the prompt after /model fable." -ForegroundColor Yellow }
  elseif ($s.ExtraUsage -ne 'enabled') { Write-Host "$($s.Seat): consent recorded, but extra usage is '$($s.ExtraUsage)' for the organization: the owner must enable it on claude.ai." -ForegroundColor Yellow }
  else { Write-Host "$($s.Seat): consent and extra usage look fine but the CLI still refuses; open claude on it once more (the cached account state may be stale)." -ForegroundColor Yellow }
}
