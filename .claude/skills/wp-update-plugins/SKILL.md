---
name: wp-update-plugins
description: Check and update WordPress plugins, themes and translations on all Hostinger-hosted sites listed in sites.json, then email a per-site report. Use when the user asks to update WordPress plugins, themes or translations, check for updates, or run the daily wpMon maintenance.
---

# Update WordPress plugins, themes and translations (wpMon)

Run the update workflow (plugins, themes and translation/language packs)
against the sites configured in `sites.json`, then report the results by
email.

## Steps

1. Decide the mode:
   - Default: `npm run wp:update` (checks and applies updates).
   - If the user asked to only check (no changes): `npm run wp:check`.
   - To target one site: `node src/update-plugins.js --site <name>` (add
     `--dry-run` for check-only).
2. Run the command from the repo root. It prints a summary and writes two
   report files to `reports/`: `wp-update-<timestamp>.md` (summary) and
   `.json` (full detail). Exit code 1 means at least one site failed or was
   unreachable — still continue to the reporting step and include the
   failures.
3. Read the newest `reports/wp-update-*.md` file.
4. Compose the email report and create a Gmail draft addressed to the
   maintainer's own Gmail address (the account the Gmail integration is
   authenticated as):
   - Subject: `wpMon update report — <date>`
   - Body: per-site status covering all three categories — each updated
     plugin and theme with old → new version, each updated translation
     (core/plugin/theme + language), updates still available (dry run), and
     any failures or unreachable sites with their error messages.
   - After creating the draft, apply the `wordpress` Gmail label to it:
     `create_draft` returns a draft id and no separate message id, so use
     `list_drafts` (filter by the exact subject just used) to get the draft's
     `threadId`. Call `list_labels` to find the current label ID for the
     label named `wordpress` (create it if it doesn't exist yet), then call
     `label_thread` with that `threadId` and label ID (`label_message` fails
     on draft ids — it needs a real message id, which isn't exposed for
     drafts).
   - Tell the user the draft is ready to review and send (the Gmail
     integration cannot send directly).
5. If Gmail tools are unavailable in the session, skip the draft: print the
   summary in the response and point at the report file path instead.

## Prerequisites (mention if the run fails on credentials)

- Sites are configured in the gitignored `sites.json` (name, sshHost,
  sshPort, sshUser, wpPath, sshPassword or sshKeyPath (+ optional
  sshKeyPassphrase), optional excludePlugins and excludeThemes) — see
  `sites.json.example`.
