---
name: wp-update-plugins
description: Check and update WordPress plugins, themes and translations on all Hostinger-hosted sites listed in sites.json, bump PHP via Hostinger, and process WordPress notification emails from Gmail, writing JSON results that build-report.js turns into an HTML report. Use when the user asks to update WordPress plugins, themes or translations, check for updates, or run the daily wordpressMonitor maintenance.
---

# Update WordPress plugins, themes and translations (wordpressMonitor)

Run the update workflow (plugins, themes and translation/language packs)
against the sites configured in `sites.json`. Results are written as JSON
files in `reports/`; the runner (`.claude/scripts/run-daily-update.ps1`)
then builds and opens the HTML report with `src/build-report.js`. **Do not
create Gmail drafts or emails** — the report is the HTML file.

Let `<ts>` be the timestamp slug of the `<ts>-wp-update.json` the script
writes (e.g. `2026-09-30-093000`); the extra JSON files below reuse it.

If the skill argument is `check-only`, the run is a dry run: use
`npm run wp:check`, never call `hosting_updatePHPVersionV1`, and do not
trash any email.

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
4. **Optional step** — only runs if the Hostinger MCP connector's tools
   (`mcp__claude_ai_Hostinger_Connector__*`) are available in this session.
   If they aren't, skip straight to step 5; the report still has the
   WP-CLI-based PHP compatibility check as a fallback, so nothing is lost.
   For each site:
   - `username` is the site's `sshUser` from `sites.json`; `domain` is the
     folder name inside `wpPath` (e.g. `wpPath` of
     `domains/akun.com.ar/public_html` → domain `akun.com.ar`).
   - Call `hosting_getPHPDetailsV1` with that `username`/`domain`. Take the
     highest version key in `php_versions.supported` (sort numerically —
     `8.5` > `8.4` > `8.3` > ... > `7.3`, not lexically).
   - If it's strictly higher than the site's current `php_version`, check
     this same site's entry in the report from step 2/3 first: if its "PHP
     compatibility" section flagged any plugin/theme (a `Requires PHP`
     issue), **do not auto-apply** — report it exactly like before: an
     alert with current → highest version and a note that a plugin/theme
     needs review first. Otherwise (no plugin/theme flagged an issue),
     auto-apply: call `hosting_updatePHPVersionV1` with that
     `username`/`domain`/highest-supported-`version`. This changes the
     site's live hosting config. The user has explicitly and durably
     approved this — unattended, on every run including headless/scheduled
     ones, with no per-run confirmation — so proceed without asking again.
   - Record the outcome per site for the email step below: PHP bumped (old
     → new version), skipped due to a flagged plugin/theme compatibility
     issue, already on the highest supported version, or the
     `hosting_updatePHPVersionV1` call itself failed (include the error).
5. Write `reports/<ts>-php.json` with the per-site PHP outcome from step 4:

   ```json
   {
     "sites": [
       {
         "site": "...",
         "current": "8.3",
         "highest": "8.5",
         "outcome": "bumped|skipped-compat|up-to-date|failed|available-dry-run",
         "newVersion": "8.5",
         "reason": "...",
         "error": "..."
       }
     ]
   }
   ```

   - `bumped`: auto-applied (routine, not an alert). `skipped-compat`: a
     newer version exists but a plugin/theme was flagged (`reason` says
     which). `failed`: `hosting_updatePHPVersionV1` errored (`error`).
     `available-dry-run`: newer version exists but this is a check-only run.
   - If the Hostinger connector isn't available, write
     `{ "unavailable": true }`.

6. Process WordPress notification emails from Gmail. Skip and write
   `reports/<ts>-wp-mails.json` as `{ "unavailable": true }` if the Gmail
   tools aren't available.
   - Read `config.json` -> `gmail.labels.wordpress` (default
     `wordpress`). `search_threads` with `label:"<label>"`, then `get_thread`
     for each hit.
   - Write `reports/<ts>-wp-mails.json`:

     ```json
     {
       "label": "wordpress",
       "mails": [
         {
           "threadId": "...",
           "date": "...",
           "from": "...",
           "subject": "...",
           "site": "...",
           "kind": "auto-update|fatal-error|security|admin-notice|other",
           "summary": "one line",
           "actionNeeded": false
         }
       ],
       "trashed": ["threadId"],
       "trashFailed": ["threadId"]
     }
     ```

     Deduce `site` from the sender/domain against `sites.json` names/paths
     (`null` if unknown). `actionNeeded` is `true` for fatal errors /
     recovery mode, security notices and admin-email-change notices.

   - Normal run: after the JSON is written, `trash_thread` every thread that
     was read successfully and list it in `trashed` (failures in
     `trashFailed`; update the JSON). Check-only run: don't trash anything;
     leave `trashed` empty.
   - No threads under the label: write `"mails": []`.
7. Print a short plain-text summary of what happened (sites, updates, PHP
   bumps, emails processed). Never mention drafts, the HTML report or file paths
   in it; the runner handles all of that.

## Prerequisites (mention if the run fails on credentials)

- Sites are configured in the gitignored `sites.json` (name, sshHost,
  sshPort, sshUser, wpPath, sshPassword or sshKeyPath (+ optional
  sshKeyPassphrase), optional excludePlugins and excludeThemes) — see
  `sites.json.example`.
- The Hostinger MCP connector (step 4's PHP-version check) is **optional**,
  not required for this workflow to work. Everything else — plugin/theme/
  translation updates, the core-update check, and the WP-CLI PHP
  compatibility check — runs the same with or without it.
