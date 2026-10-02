---
name: wp-update-plugins
description: Check and update WordPress plugins, themes and translations on all Hostinger-hosted sites listed in sites.json, writing JSON results that build-report.js turns into an HTML report. Use when the user asks to update WordPress plugins, themes or translations, check for updates, or run the daily wordpressMonitor maintenance.
---

# Update WordPress plugins, themes and translations (wordpressMonitor)

Run the update workflow (plugins, themes and translation/language packs)
against the sites configured in `sites.json`. Results are written as JSON
files in `reports/`; the runner (`.claude/scripts/run-daily-update.ps1`)
then builds and opens the HTML report with `src/build-report.js`. **Do not
create Gmail drafts or emails** — the report is the HTML file. PHP
version checking/bumping (via the Hostinger API) and WordPress notification
emails are **not** handled by this skill — the runner calls
`src/php-check.js` and `src/wp-mails-fetch.js` after it, no Claude involved.

Let `<ts>` be the timestamp slug of the `<ts>-wp-update.json` the script
writes (e.g. `2026-09-30-093000`).

**Language:** everything you write — JSON text fields (`summary`, `narrative`, `reason`,
`note`, ...) and the final summary — must be in English.

## Steps

1. Decide the mode:
   - Default: `npm run wp:update` (checks and applies updates).
   - If the user asked to only check (no changes): `npm run wp:check`.
   - To target one site: `node src/update-plugins.js --site <name>` (add
     `--dry-run` for check-only).
2. Run the command from the repo root. It prints a summary and writes two
   report files to `reports/`: `<timestamp>-wp-update.md` (summary) and
   `.json` (full detail). Exit code 1 means at least one site failed or was
   unreachable — still continue to the reporting step and include the
   failures.
3. Read the newest `reports/*-wp-update.md` file.
4. Print a short plain-text summary of what happened (sites, updates). Never
   mention drafts, the HTML report or file paths in it; the runner handles
   all of that.

## Prerequisites (mention if the run fails on credentials)

- Sites are configured in the gitignored `sites.json` (name, sshHost,
  sshPort, sshUser, wpPath, sshPassword or sshKeyPath (+ optional
  sshKeyPassphrase), optional excludePlugins and excludeThemes) — see
  `sites.json.example`.
