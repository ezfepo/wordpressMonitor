---
name: wp-update-plugins
description: Check and update WordPress plugins, themes and translations on all Hostinger-hosted sites listed in sites.json, then email a per-site report. Use when the user asks to update WordPress plugins, themes or translations, check for updates, or run the daily wordpressMonitor maintenance.
---

# Update WordPress plugins, themes and translations (wordpressMonitor)

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
5. Compose the email report and create a Gmail draft addressed to the
   maintainer's own Gmail address (the account the Gmail integration is
   authenticated as):
   - An auto-applied PHP bump (no compatibility issue, update succeeded) is
     **not** an action-needed item — it's routine, already-handled
     maintenance, same as an auto-applied plugin/theme/translation update.
     Only these count toward "action needed": a WordPress core update
     available; a WP-CLI PHP compatibility alert (from `update-plugins.js`);
     a PHP upgrade that was skipped because a plugin/theme was flagged; a
     `hosting_updatePHPVersionV1` call that failed; or any site failure/
     unreachable status.
   - Subject: `wordpressMonitor update report — <date>`. Prefix it
     `[ACTION NEEDED] wordpressMonitor update report — <date>` only if at
     least one of the action-needed items above applies to some site. If
     every site is clean (including any auto-applied PHP bumps), leave the
     subject as-is with no prefix.
   - Body: if there's anything action-needed, lead with an "Action needed"
     section listing, per affected site: any WordPress core update
     available (current → new version, update type); any PHP compatibility
     alert (current PHP version vs. WordPress's recommended minimum, plus
     any plugin/theme whose "Requires PHP" exceeds the site's PHP version);
     a skipped PHP upgrade with the reason (e.g. "PHP 8.3 → 8.5 available
     but skipped: theme X requires review first"); or a failed PHP update
     call with its error. If nothing needs action, skip this section
     entirely — don't create an empty or trivial "action needed" heading.
     Then per-site status covering the three auto-updated categories — each
     updated plugin and theme with old → new version, each updated
     translation (core/plugin/theme + language), updates still available
     (dry run), any failures or unreachable sites with their error
     messages — plus, as routine info (not as an alert), any PHP version
     that was auto-applied this run, e.g. "PHP updated 8.3 → 8.5."
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
6. If Gmail tools are unavailable in the session, skip the draft: print the
   summary in the response and point at the report file path instead.

## Prerequisites (mention if the run fails on credentials)

- Sites are configured in the gitignored `sites.json` (name, sshHost,
  sshPort, sshUser, wpPath, sshPassword or sshKeyPath (+ optional
  sshKeyPassphrase), optional excludePlugins and excludeThemes) — see
  `sites.json.example`.
- The Hostinger MCP connector (step 4's PHP-version check) is **optional**,
  not required for this workflow to work. Everything else — plugin/theme/
  translation updates, the core-update check, and the WP-CLI PHP
  compatibility check — runs the same with or without it.
