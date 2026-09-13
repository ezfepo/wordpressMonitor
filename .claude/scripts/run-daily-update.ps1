# wpMon daily update — invoked by Windows Task Scheduler.
#
# Runs the /wp-update-plugins skill through the Claude Code CLI in headless
# mode: it executes npm run wp:update, reads the report, and creates a Gmail
# draft (addressed to the maintainer's own Gmail account) with the results.
# The draft still needs a manual send — the Gmail integration has no send
# tool, only create_draft.
#
# Logs each run to .claude\logs\ (gitignored) for troubleshooting.

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $repoRoot

$logDir = Join-Path $repoRoot '.claude\logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$logFile = Join-Path $logDir "daily-update-$(Get-Date -Format 'yyyy-MM-dd-HHmmss').log"

$output = & claude -p "/wp-update-plugins" `
  --permission-mode bypassPermissions `
  --output-format text `
  2>&1
$exitCode = $LASTEXITCODE

$output | Out-File -FilePath $logFile -Encoding utf8
$output | Write-Output

exit $exitCode
