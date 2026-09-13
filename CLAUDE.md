# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project status

wpMon maintains WordPress sites hosted on Hostinger. It updates WP plugins, themes and
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
  with a re-check afterwards so unapplied translations are reported as remaining). One
  site or category failing never aborts the others; exit code 1 signals at least one
  non-ok site.
- `sites.json` (gitignored, template in `sites.json.example`) — site inventory and
  credentials in one file: name, sshHost, sshPort, sshUser, wpPath, excludePlugins,
  excludeThemes, plus either `sshPassword` or `sshKeyPath` (+ optional
  `sshKeyPassphrase`) per site. Never committed.
- `.claude/skills/wp-update-plugins/` — on-demand entry point (`/wp-update-plugins`): runs
  the script, reads the newest report, drafts the report email via Gmail, and tags the
  draft with the existing `wordpress` Gmail label.

## Running the update manually

There is no active scheduled automation — updates are run on demand via
`.claude/scripts/run-daily-update.ps1`, which calls `claude -p "/wp-update-plugins"`
headlessly so a real Claude Code session performs the update and creates/tags the Gmail
report draft (same as running `/wp-update-plugins` manually in a session). This is
triggered from a desktop shortcut (a `.bat` file, outside this repo) that runs the script.

### Where the run output lives

- `.claude/logs/daily-update-<timestamp>.log` (gitignored) — one file per run, the full
  Claude Code CLI output: sites processed, plugins/themes/translations updated, and
  confirmation that the Gmail draft was created and labeled.
- `reports/wp-update-<timestamp>.md` / `.json` (gitignored) — the structured per-site
  report the update script itself writes, regardless of how it was triggered (manually or
  via the skill).

## Formatting

Prettier config is in `.prettierrc`: single quotes, semicolons, 2-space indentation, no trailing
commas, CRLF line endings, 80-char print width (20 for JSON files). VS Code is set up to format
on save using Prettier for JS/JSON/Markdown/shell/XML files (`.vscode/settings.json`), and
ESLint is enabled with flat config expected (no `eslint.config.js` exists yet).

## Plans and temp files

- **Plans** go in `.claude/plans/` (repo root). Never write plans to the user-global `~/.claude/plans/` or to `docs/` subfolders. Create the folder if it doesn't exist.
- **Scratch / temp files** go in `.claude/tmp/` (repo root). Never use the OS temp dir or a `tmp/` folder at project or subfolder level.
