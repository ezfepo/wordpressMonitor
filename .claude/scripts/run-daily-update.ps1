# wordpressMonitor — on-demand runner (menu).
#
# Usage:  run-daily-update.ps1 [-Mode wp|dmarc|all|dryrun]
# Without -Mode it shows a menu (Update: 1 WordPress, 2 DMARC, 3 both;
# Check only: 4 WordPress, 5 DMARC).
#
# Every mode runs plain Node scripts; Claude Code is not needed:
#   wp     -> node src/update-plugins.js (updates) + src/php-check.js (PHP bump
#             and cache clear via Hostinger API) + src/vuln-check.js (known
#             vulnerabilities via WPVulnerability.net, read-only) +
#             src/wp-mails-fetch.js (WordPress emails)
#   dmarc  -> node src/dmarc-fetch.js (DMARC reports from Gmail API)
#   all    -> both
#   dryrun -> same as wp, with --dry-run on the update, PHP and email steps
#             (nothing is changed or trashed)
#   dmarcdry -> node src/dmarc-fetch.js --dry-run (parses reports, trashes nothing)
# Afterwards src/build-report.js merges the run's JSON results into
# reports/<ts>-report.html, which is opened automatically. Files older than
# retentionDays (config.json) are then deleted from .claude/tmp,
# .claude/logs and reports.
#
# Logs each run to .claude\logs\ (gitignored) for troubleshooting.

param(
  [ValidateSet('wp', 'dmarc', 'all', 'dryrun', 'dmarcdry')]
  [string]$Mode
)

$ErrorActionPreference = 'Stop'

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

if (-not $Mode) {
  Write-Output 'wordpressMonitor - what do you want to do?'
  Write-Output ''
  Write-Output '  Update'
  Write-Output '   1. Update WordPress sites      (plugins, themes, translations, PHP)'
  Write-Output '   2. Process DMARC reports       (processed emails go to the trash)'
  Write-Output '   3. Do everything               (1 + 2)'
  Write-Output ''
  Write-Output '  Check only (changes nothing)'
  Write-Output '   4. Check WordPress sites       (see what is pending)'
  Write-Output '   5. Check DMARC reports         (emails stay in Gmail, can be repeated)'
  Write-Output ''
  Write-Output '   Q. Quit'
  $choice = Read-Host 'Choose'
  switch ($choice.Trim().ToLower()) {
    '1' { $Mode = 'wp' }
    '2' { $Mode = 'dmarc' }
    '3' { $Mode = 'all' }
    '4' { $Mode = 'dryrun' }
    '5' { $Mode = 'dmarcdry' }
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
try {
  if ($Mode -in 'wp', 'all') {
    Invoke-NodeScript -NodeArgs @('src/update-plugins.js') -LogName 'wp-update' -Title 'Update WordPress sites'
    $exitCode = [Math]::Max($exitCode, $script:SkillExit)
    Invoke-NodeScript -NodeArgs @('src/php-check.js') -LogName 'php-check' -Title 'Check PHP versions'
    $exitCode = [Math]::Max($exitCode, $script:SkillExit)
    Invoke-NodeScript -NodeArgs @('src/vuln-check.js') -LogName 'vuln-check' -Title 'Check known vulnerabilities'
    $exitCode = [Math]::Max($exitCode, $script:SkillExit)
    Invoke-NodeScript -NodeArgs @('src/wp-mails-fetch.js') -LogName 'wp-mails' -Title 'Process WordPress emails'
    $exitCode = [Math]::Max($exitCode, $script:SkillExit)
  }
  if ($Mode -eq 'dryrun') {
    Invoke-NodeScript -NodeArgs @('src/update-plugins.js', '--dry-run') -LogName 'wp-check' -Title 'Check WordPress sites'
    $exitCode = [Math]::Max($exitCode, $script:SkillExit)
    Invoke-NodeScript -NodeArgs @('src/php-check.js', '--dry-run') -LogName 'php-check' -Title 'Check PHP versions'
    $exitCode = [Math]::Max($exitCode, $script:SkillExit)
    Invoke-NodeScript -NodeArgs @('src/vuln-check.js') -LogName 'vuln-check' -Title 'Check known vulnerabilities'
    $exitCode = [Math]::Max($exitCode, $script:SkillExit)
    Invoke-NodeScript -NodeArgs @('src/wp-mails-fetch.js', '--dry-run') -LogName 'wp-mails' -Title 'Check WordPress emails'
    $exitCode = [Math]::Max($exitCode, $script:SkillExit)
  }
  if ($Mode -in 'dmarc', 'all') {
    Invoke-NodeScript -NodeArgs @('src/dmarc-fetch.js') -LogName 'dmarc-check' -Title 'Process DMARC reports'
    $exitCode = [Math]::Max($exitCode, $script:SkillExit)
  }
  if ($Mode -eq 'dmarcdry') {
    Invoke-NodeScript -NodeArgs @('src/dmarc-fetch.js', '--dry-run') -LogName 'dmarc-check' -Title 'Check DMARC reports'
    $exitCode = [Math]::Max($exitCode, $script:SkillExit)
  }

  $since = $runStart.ToUniversalTime().ToString('o')
  $reportPath = & node src/build-report.js --since $since --mode $Mode --logs ($LogFiles -join ',')
  if ($LASTEXITCODE -eq 0 -and $reportPath -and (Test-Path $reportPath)) {
    Write-Output "==> Report: $reportPath"
    Start-Process $reportPath
  } else {
    Write-Output '==> Could not build the HTML report.'
    $exitCode = [Math]::Max($exitCode, 1)
  }
} finally {
  Remove-OldFiles
}

exit $exitCode
