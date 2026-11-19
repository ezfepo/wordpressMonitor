# wordpressMonitor — on-demand runner (menu).
#
# Usage:  run-daily-update.ps1 [-Mode all|wp|security|secdry|secbaseline|dmarc|dryrun|dmarcdry] [-Check <id>]
# Without -Mode it shows a menu; pressing Enter runs option 1 (everything).
#
# Every mode runs plain Node scripts; Claude Code is not needed:
#   all         -> option 1, in this order: src/update-plugins.js, src/php-check.js,
#                  src/vuln-check.js, src/wp-mails-fetch.js, src/security-check.js
#                  (all checks), src/dmarc-fetch.js, then the HTML report
#   wp          -> update-plugins + php-check (PHP bump and cache clear via the
#                  Hostinger API) + vuln-check (WPVulnerability.net, read-only) +
#                  wp-mails-fetch (WordPress emails)
#   security    -> src/security-check.js (read-only checks; -Check <id> runs just one)
#   secdry      -> security-check.js --dry-run (compares, never writes the baseline)
#   secbaseline -> security-check.js --accept (stores the current state as the
#                  new security baseline; no report)
#   dmarc       -> src/dmarc-fetch.js (DMARC reports from the Gmail API)
#   dryrun      -> same as wp, with --dry-run on the update, PHP and email steps
#                  (nothing is changed or trashed)
#   dmarcdry    -> src/dmarc-fetch.js --dry-run (parses reports, trashes nothing)
# Afterwards src/build-report.js merges the run's JSON results into
# reports/<ts>-report.html, which is opened automatically. Files older than
# retentionDays (config.json) are then deleted from .claude/tmp,
# .claude/logs and reports.
#
# Logs each run to .claude\logs\ (gitignored) for troubleshooting.

param(
  [ValidateSet('all', 'wp', 'security', 'secdry', 'secbaseline', 'dmarc', 'dryrun', 'dmarcdry')]
  [string]$Mode,
  [ValidateSet('admins', 'options', 'integrity', 'uploads-cron', 'sucuri-audit', 'db-scan', 'public-site', 'exposed-files', 'backups', 'tls', 'abandoned')]
  [string]$Check
)

$ErrorActionPreference = 'Stop'

$securityChecks = @(
  'admins', 'options', 'integrity', 'uploads-cron', 'sucuri-audit', 'db-scan',
  'public-site', 'exposed-files', 'backups', 'tls', 'abandoned'
)

# Plain copy of -Check: the parameter itself is ValidateSet-bound and cannot
# be assigned $null by the menu.
$selectedCheck = $Check

# node's stdout is UTF-8; without this, non-ASCII characters (em dashes,
# etc.) get mis-decoded into mojibake (e.g. "—" shows as "ГÇö"). Setting
# $OutputEncoding controls how PowerShell decodes piped external-process
# output, which is what matters here. [Console]::OutputEncoding is for
# writing to an attached console and can hang/throw when none is attached
# (e.g. run from Task Scheduler or a background runner), so it's skipped
# unless a console is actually present.
$OutputEncoding = [System.Text.Encoding]::UTF8
if ([Environment]::UserInteractive -and -not [Console]::IsOutputRedirected) {
  try {
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  } catch {
    # Best-effort only; piped/redirected output still decodes correctly via
    # $OutputEncoding above.
  }
}

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $repoRoot

function Select-SecurityCheck {
  Write-Host ''
  Write-Host 'Which security check?'
  for ($i = 0; $i -lt $securityChecks.Count; $i++) {
    Write-Host ("  {0,2}. {1}" -f ($i + 1), $securityChecks[$i])
  }
  $pick = (Read-Host 'Choose (number or name, Enter to cancel)').Trim().ToLower()
  if ($pick -match '^\d+$' -and [int]$pick -ge 1 -and [int]$pick -le $securityChecks.Count) {
    return $securityChecks[[int]$pick - 1]
  }
  if ($securityChecks -contains $pick) { return $pick }
  return $null
}

if (-not $Mode) {
  Write-Output 'wordpressMonitor - what do you want to do?'
  Write-Output ''
  Write-Output '   1. Run everything              (update sites, PHP, vulnerabilities, WP emails,'
  Write-Output '                                   security checks, DMARC)   [default: Enter]'
  Write-Output ''
  Write-Output '  Individual steps'
  Write-Output '   2. Update WordPress sites      (plugins, themes, translations, PHP, vulnerabilities, WP emails)'
  Write-Output '   3. Security checks             (all checks, read-only)'
  Write-Output '   4. One security check          (pick from a list)'
  Write-Output '   5. Process DMARC reports       (processed emails go to the trash)'
  Write-Output ''
  Write-Output '  Check only (changes nothing)'
  Write-Output '   6. Check WordPress sites       (see what is pending)'
  Write-Output '   7. Check security              (compares with the baseline, does not save it)'
  Write-Output '   8. Check DMARC reports         (emails stay in Gmail, can be repeated)'
  Write-Output ''
  Write-Output '  Baseline'
  Write-Output '   9. Accept current state as security baseline  (after reviewing legitimate changes)'
  Write-Output ''
  Write-Output '   Q. Quit'
  $choice = Read-Host 'Choose [1]'
  $choice = $choice.Trim().ToLower()
  if ($choice -eq '') { $choice = '1' }
  switch ($choice) {
    '1' { $Mode = 'all' }
    '2' { $Mode = 'wp' }
    '3' { $Mode = 'security' }
    '4' {
      $Mode = 'security'
      $selectedCheck = Select-SecurityCheck
      if (-not $selectedCheck) { Write-Output 'Nothing to do.'; exit 0 }
    }
    '5' { $Mode = 'dmarc' }
    '6' { $Mode = 'dryrun' }
    '7' { $Mode = 'secdry' }
    '8' { $Mode = 'dmarcdry' }
    '9' { $Mode = 'secbaseline' }
    default { Write-Output 'Nothing to do.'; exit 0 }
  }
}

$retentionDays = 3
$configFile = Join-Path $repoRoot 'config.json'
if (Test-Path $configFile) {
  try {
    $config = Get-Content $configFile -Raw | ConvertFrom-Json
    if ($config.retentionDays -is [int] -or $config.retentionDays -is [long]) {
      $retentionDays = [int]$config.retentionDays
    }
  } catch {
    Write-Output "Could not read config.json, using defaults: $($_.Exception.Message)"
  }
}

$logDir = Join-Path $repoRoot '.claude\logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$runStart = Get-Date
$runStamp = $runStart.ToString('yyyy-MM-dd-HHmmss')

function Invoke-NodeScript {
  param([string[]]$NodeArgs, [string]$LogName, [string]$Title)

  $logFile = Join-Path $logDir "$runStamp-$LogName.log"
  $script:LogFiles += $logFile
  Write-Output "==> Started: $Title"
  & node @NodeArgs 2>&1 |
    ForEach-Object {
      Write-Output "$_"
      Add-Content -Path $logFile -Value "$_" -Encoding utf8
    }
  $script:SkillExit = $LASTEXITCODE
}

# Runs one step and folds its exit code into the run's exit code.
function Invoke-Step {
  param([string[]]$NodeArgs, [string]$LogName, [string]$Title)
  Invoke-NodeScript -NodeArgs $NodeArgs -LogName $LogName -Title $Title
  $script:exitCode = [Math]::Max($script:exitCode, $script:SkillExit)
}

# security-check.js arguments: optional --only <id>, plus any extra flags.
function Get-SecurityArgs {
  param([string[]]$Extra = @())
  $a = @('src/security-check.js') + $Extra
  if ($selectedCheck) { $a += @('--only', $selectedCheck) }
  return $a
}

function Remove-OldFiles {
  $cutoff = (Get-Date).AddDays(-$retentionDays)
  foreach ($dir in @('.claude\tmp', '.claude\logs', 'reports')) {
    $full = Join-Path $repoRoot $dir
    if (-not (Test-Path $full)) { continue }
    Get-ChildItem -Path $full -File -Recurse -Force |
      Where-Object { $_.LastWriteTime -lt $cutoff } |
      Remove-Item -Force -ErrorAction SilentlyContinue
  }
  # Drop empty subfolders left in tmp.
  $tmp = Join-Path $repoRoot '.claude\tmp'
  if (Test-Path $tmp) {
    Get-ChildItem -Path $tmp -Directory -Recurse |
      Sort-Object { $_.FullName.Length } -Descending |
      Where-Object { -not (Get-ChildItem -Path $_.FullName -Force) } |
      Remove-Item -Force -ErrorAction SilentlyContinue
  }
}

$LogFiles = @()
$exitCode = 0
$buildReport = $true
try {
  if ($Mode -in 'wp', 'all') {
    Invoke-Step -NodeArgs @('src/update-plugins.js') -LogName 'wp-update' -Title 'Update WordPress sites'
    Invoke-Step -NodeArgs @('src/php-check.js') -LogName 'php-check' -Title 'Check PHP versions'
    Invoke-Step -NodeArgs @('src/vuln-check.js') -LogName 'vuln-check' -Title 'Check known vulnerabilities'
    Invoke-Step -NodeArgs @('src/wp-mails-fetch.js') -LogName 'wp-mails' -Title 'Process WordPress emails'
  }
  if ($Mode -eq 'dryrun') {
    Invoke-Step -NodeArgs @('src/update-plugins.js', '--dry-run') -LogName 'wp-check' -Title 'Check WordPress sites'
    Invoke-Step -NodeArgs @('src/php-check.js', '--dry-run') -LogName 'php-check' -Title 'Check PHP versions'
    Invoke-Step -NodeArgs @('src/vuln-check.js') -LogName 'vuln-check' -Title 'Check known vulnerabilities'
    Invoke-Step -NodeArgs @('src/wp-mails-fetch.js', '--dry-run') -LogName 'wp-mails' -Title 'Check WordPress emails'
  }
  if ($Mode -in 'security', 'all') {
    Invoke-Step -NodeArgs (Get-SecurityArgs) -LogName 'security-check' -Title 'Run security checks'
  }
  if ($Mode -eq 'secdry') {
    Invoke-Step -NodeArgs (Get-SecurityArgs -Extra @('--dry-run')) -LogName 'security-check' -Title 'Check security (dry run)'
  }
  if ($Mode -eq 'secbaseline') {
    $buildReport = $false
    Invoke-Step -NodeArgs (Get-SecurityArgs -Extra @('--accept')) -LogName 'security-baseline' -Title 'Accept current state as security baseline'
  }
  if ($Mode -in 'dmarc', 'all') {
    Invoke-Step -NodeArgs @('src/dmarc-fetch.js') -LogName 'dmarc-check' -Title 'Process DMARC reports'
  }
  if ($Mode -eq 'dmarcdry') {
    Invoke-Step -NodeArgs @('src/dmarc-fetch.js', '--dry-run') -LogName 'dmarc-check' -Title 'Check DMARC reports'
  }

  if ($buildReport) {
    $since = $runStart.ToUniversalTime().ToString('o')
    $reportPath = & node src/build-report.js --since $since --mode $Mode --logs ($LogFiles -join ',')
    if ($LASTEXITCODE -eq 0 -and $reportPath -and (Test-Path $reportPath)) {
      Write-Output "==> Report: $reportPath"
      Start-Process $reportPath
    } else {
      Write-Output '==> Could not build the HTML report.'
      $exitCode = [Math]::Max($exitCode, 1)
    }
  }
} finally {
  Remove-OldFiles
}

exit $exitCode
