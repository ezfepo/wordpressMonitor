# wordpressMonitor daily update — invoked by Windows Task Scheduler.
#
# Runs the /wp-update-plugins skill through the Claude Code CLI in headless
# mode: it executes npm run wp:update, reads the report, and creates a Gmail
# draft (addressed to the maintainer's own Gmail account) with the results.
# The draft still needs a manual send — the Gmail integration has no send
# tool, only create_draft.
#
# Uses --output-format stream-json so progress (tool calls, assistant text)
# prints live line by line as Claude works, instead of one block after the
# whole run finishes (headless -p with plain "text" output emits nothing
# until the turn is fully done). Each line is parsed into a short summary;
# the raw JSON stream is kept in the log for troubleshooting.
#
# Logs each run to .claude\logs\ (gitignored) for troubleshooting.

$ErrorActionPreference = 'Stop'

# claude's stdout is UTF-8; without this, non-ASCII characters (em dashes,
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

$logDir = Join-Path $repoRoot '.claude\logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$logFile = Join-Path $logDir "daily-update-$(Get-Date -Format 'yyyy-MM-dd-HHmmss').log"

# Friendly labels for the tools this workflow actually uses, so progress
# reads like a task list instead of raw tool/API names.
$ToolLabels = @{
  Bash                               = 'Running the update script'
  Read                               = 'Reading the report'
  ToolSearch                         = 'Loading Gmail tools'
  mcp__claude_ai_Gmail__create_draft = 'Creating the email draft'
  mcp__claude_ai_Gmail__list_drafts  = 'Looking up the draft'
  mcp__claude_ai_Gmail__list_labels  = 'Looking up the "wordpress" label'
  mcp__claude_ai_Gmail__label_thread = 'Tagging the draft'
  mcp__claude_ai_Gmail__label_message = 'Tagging the draft'
}

function Get-ToolLabel {
  param([string]$Name)
  if ($ToolLabels.ContainsKey($Name)) { return $ToolLabels[$Name] }
  return $Name
}

function Write-StreamEvent {
  param([string]$Line)

  if ([string]::IsNullOrWhiteSpace($Line)) { return }

  try {
    $streamEvent = $Line | ConvertFrom-Json -ErrorAction Stop
  } catch {
    Write-Output $Line
    return
  }

  switch ($streamEvent.type) {
    'system' {
      if ($streamEvent.subtype -eq 'init') {
        Write-Output '==> Starting wordpressMonitor update...'
      }
    }
    'assistant' {
      foreach ($block in $streamEvent.message.content) {
        if ($block.type -eq 'text' -and $block.text) {
          Write-Output $block.text
        } elseif ($block.type -eq 'tool_use') {
          Write-Output "  - $(Get-ToolLabel $block.name)..."
        }
      }
    }
    'result' {
      if ($streamEvent.subtype -eq 'success') {
        Write-Output '==> Done.'
      } else {
        Write-Output "==> Finished with an error: $($streamEvent.subtype)"
      }
    }
    'tool_progress' {
      if ($streamEvent.heartbeat) {
        Write-Output "    (still working, $($streamEvent.elapsed_time_seconds)s so far)"
      }
    }
    default {
      # 'user' (tool results), 'rate_limit_event' and anything else are raw
      # API bookkeeping, not useful to show live — they're still captured in
      # the .jsonl log for troubleshooting.
    }
  }
}

$rawLog = "$logFile.jsonl"

& claude -p "/wp-update-plugins" `
  --permission-mode bypassPermissions `
  --output-format stream-json `
  --verbose `
  2>&1 |
  ForEach-Object {
    Add-Content -Path $rawLog -Value $_ -Encoding utf8
    $friendly = Write-StreamEvent -Line $_
    foreach ($line in $friendly) {
      Write-Output $line
      Add-Content -Path $logFile -Value $line -Encoding utf8
    }
  }
$exitCode = $LASTEXITCODE

exit $exitCode
