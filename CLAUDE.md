# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project status

wordpressMonitor maintains WordPress sites hosted on Hostinger. It updates WP plugins, themes and
translations (language packs) across all configured sites over SSH + WP-CLI. Node.js `>=24.14` is required (see
`package.json`).

## Commands

- `npm install` — install dependencies.
- `npm run wp:update` — check and update plugins, themes and translations on every site in
  `sites.json`; writes a Markdown + JSON report to `reports/` (gitignored).
- `npm run wp:check` — same, but dry run (report available updates only, change nothing).
- `node src/update-plugins.js --site <name> [--dry-run]` — run against a single site.
- `npm run prettier` — format the entire repo in place with Prettier (`prettier --write .`).

There is no build, lint, or test tooling configured yet. If you add one, update this file with
the corresponding commands (e.g. how to run a single test).

## Plugin updater architecture

- `src/update-plugins.js` — connects to each site over SSH (`ssh2`) and runs WP-CLI to
  detect and apply updates in three categories: plugins (`wp plugin list/update`), themes
  (`wp theme list/update`) and translations (`wp language core|plugin|theme list/update`,
  with a re-check afterwards so unapplied translations are reported as remaining). It also
  checks (but never applies) WordPress core updates via `wp core check-update`, and PHP
  compatibility (current PHP version vs. WordPress's recommended minimum, plus any
  plugin/theme's `requires_php` exceeding it) via `wp cli info` + `wp plugin/theme list`.
  If either check finds something, the site status becomes `attention-needed` and the
  report/email flags it as an alert requiring manual action (core update, or a PHP version
  bump in Hostinger hPanel). One site or category failing never aborts the others; exit
  code 1 signals at least one non-ok site.
- `sites.json` (gitignored, template in `sites.json.example`) — site inventory and
  credentials in one file: name, sshHost, sshPort, sshUser, wpPath, excludePlugins,
  excludeThemes, plus either `sshPassword` or `sshKeyPath` (+ optional
  `sshKeyPassphrase`) per site. Never committed.
- `.claude/skills/wp-update-plugins/` — on-demand entry point (`/wp-update-plugins`): runs
  the script, writes `<ts>-php.json` (PHP outcome) and `<ts>-wp-mails.json` (WordPress
  notification emails read from the Gmail label in `config.json`, then trashed
  unless check-only). It creates no Gmail drafts. It also has an **optional** step
  (skipped silently if not set up — nothing else in the workflow depends on it): if the
  Hostinger MCP connector is connected in the session, it checks each site's PHP version
  against Hostinger's own available versions (`hosting_getPHPDetailsV1`, keyed by
  `sshUser` as `username` and the domain folder from `wpPath`). This catches "a newer PHP
  version is available" (matching hPanel's own notice), which the WP-CLI-based check in
  `update-plugins.js` can't see, since that one only flags PHP below a fixed floor.
  **When a newer version exists and no plugin/theme on that site was flagged by the
  WP-CLI PHP compatibility check, the skill auto-applies it** via
  `hosting_updatePHPVersionV1`, jumping straight to the highest supported version, with
  no per-run confirmation — this is a standing, explicit user approval covering every
  future run including headless/scheduled ones. A successful auto-applied bump is
  reported as routine info in the email (like an auto-applied plugin/theme update), not
  as an action-needed alert. If a plugin/theme was flagged, the update is skipped and
  reported as an alert instead — that (plus a failed `hosting_updatePHPVersionV1` call)
  is the only case where this step triggers the email's `[ACTION NEEDED]` prefix. This is
  the one part of the workflow that changes live hosting config unattended; everything
  else (plugins, themes, translations, core updates) stays either auto-applied-but-
  reversible (WP-CLI update) or alert-only (core, and the WP-CLI PHP floor check).

## Running on demand

There is no scheduled automation. `.claude/scripts/run-daily-update.ps1` (triggered from a
desktop `.bat`, see `wordpressMonitor Update.bat.example`) shows a menu, or takes
`-Mode wp|dmarc|all|dryrun|dmarcdry`. Menu: **Update** — 1 Update WordPress sites
(`/wp-update-plugins`), 2 Process DMARC reports (`node src/dmarc-fetch.js`, no Claude), 3 Do everything (both;
the WordPress part is its own `claude -p` session); **Check only** (changes nothing) — 4 Check WordPress sites
(`dryrun`, `/wp-update-plugins check-only`: nothing updated, no PHP bump, no emails
trashed), 5 Check DMARC reports (`dmarcdry`, `dmarc-fetch.js --dry-run`: parses and reports
but trashes nothing, so it can be repeated). When done,
`src/build-report.js` merges the run's JSON into `reports/<ts>-report.html`, which is opened
automatically. This replaced the old Gmail-draft report. `npm run report` rebuilds it by hand.

- `config.json` (gitignored, template in `config.json.example`; every key is optional and
  falls back to the default shown): `retentionDays` (default 3),
  `gmail.labels.dmarc` / `gmail.labels.wordpress` (default `dmarc` / `wordpress`) — the
  Gmail labels the skills read from — and `dmarc.knownSources` (your legitimate senders;
  default none, so every source shows as `unknown`). The skills, the runner and
  `parse-dmarc.js` all read this file.
- **Cleanup**: after every run the script deletes files older than `retentionDays` from
  `.claude/tmp/`, `.claude/logs/` and `reports/`, so the HTML report is the only record
  while it exists.
- **DMARC** (`src/dmarc-fetch.js`, no Claude): the runner's `dmarc`/`dmarcdry` modes run `node src/dmarc-fetch.js [--dry-run]`, which talks to the Gmail API directly (`src/lib/gmail.js`, plain fetch, scope `gmail.modify`), parses with `parse-dmarc.js`, builds a rule-based `narrative` and trashes parsed threads (not with `--dry-run`). Credentials: `gmail-auth.json` (gitignored: clientId, clientSecret, refreshToken), created once with `npm run gmail:auth` (Google Cloud project, Gmail API enabled, OAuth client type Desktop app; publish the consent screen "In production" or the refresh token expires after 7 days). The manual skill below remains for interactive use. **DMARC skill** (`.claude/skills/dmarc-check/`): reads threads under the dmarc label, saves each
  raw message to `.claude/tmp/dmarc/`, `src/parse-dmarc.js` extracts and parses the
  zip/gzip XML (ZIP CRC is not verified on purpose — some senders ship bad CRCs), classifies
  source IPs via reverse DNS against `config.json` (`dmarc.knownSources`) (`ok` / `known-unaligned` /
  `unknown`), computes highlights and a per-domain status, and the skill adds an English
  `narrative`. Successfully parsed threads are moved to Gmail trash (recoverable 30 days);
  unparseable ones stay. Update `config.json` (`dmarc.knownSources`) when mail moves fully to Titan.
- `src/lib/format.js` holds the shared timestamp helpers (report time zone = the machine time zone, override with the `TZ` environment variable).

### Where the run output lives

- `reports/<timestamp>-report.html` — the human report (action needed, sites, WordPress
  emails, DMARC highlights).
- `reports/<ts>-wp-update.md|json`, `<ts>-php.json`, `<ts>-wp-mails.json`, `<ts>-dmarc.json` — the inputs
  the HTML is built from.
- `.claude/logs/<timestamp>-<wp-update|wp-check|dmarc-check>.log` (+ `.jsonl` raw stream).
- All gitignored.

## Formatting

Prettier config is in `.prettierrc`: single quotes, semicolons, 2-space indentation, no trailing
commas, CRLF line endings, 80-char print width (20 for JSON files). VS Code is set up to format
on save using Prettier for JS/JSON/Markdown/shell/XML files (`.vscode/settings.json`), and
ESLint is enabled with flat config expected (no `eslint.config.js` exists yet).

## Plans and temp files

- **Plans** go in `.claude/plans/` (repo root). Never write plans to the user-global `~/.claude/plans/` or to `docs/` subfolders. Create the folder if it doesn't exist.
  Track progress with `- [ ]` / `- [x]` checklists inside the plan. When every step is checked, move the plan to `.claude/plans/archive/` (after recording any lasting decision in this file).
- **Scratch / temp files** go in `.claude/tmp/` (repo root). Never use the OS temp dir or a `tmp/` folder at project or subfolder level.
