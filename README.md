# wordpressMonitor

Keeps a fleet of WordPress sites up to date. wordpressMonitor connects to each site over
SSH and uses [WP-CLI](https://wp-cli.org/) to check and update plugins,
themes, and translation/language packs — then writes a per-site Markdown +
JSON report. It can also process DMARC aggregate reports from Gmail (via the Gmail API, no Claude needed), and
merges everything into one HTML report.

Built for Hostinger-style shared/VPS hosting where each site is reachable
over SSH and has WP-CLI available.

## Requirements

- Node.js `>=24.14`
- SSH access to each WordPress site, with WP-CLI installed on the remote host
- Either a password or a private key per site

## Setup

1. Install dependencies:

   ```sh
   npm install
   ```

2. Configure your sites — copy the example and fill in your own:

   ```sh
   cp sites.json.example sites.json
   ```

   Each entry needs `name`, `sshHost`, `sshPort`, `sshUser`, and `wpPath`
   (the path to the WordPress install on the remote host, relative to the
   SSH user's home directory), plus either `sshPassword` or `sshKeyPath`
   (+ optional `sshKeyPassphrase`) for SSH auth. Optional `excludePlugins` /
   `excludeThemes` arrays skip specific slugs during updates. Optional
   `siteUrl` (e.g. `https://example.com`) is the URL the post-update health
   check fetches; without it, the check derives `https://<domain>` from the
   domain folder in `wpPath`.

   `sites.json` is never committed — it's gitignored, since it holds both
   site info and credentials.

3. Configure local settings and credentials — copy the example:

   ```sh
   cp config.json.example config.json
   ```

   `config.json` is gitignored. It's the **one file for everything local**:
   non-secret settings (retention, Gmail labels, DMARC known senders) and
   credentials (Gmail OAuth tokens, Hostinger API token) live side by side in
   it, so there's a single file to back up or move to a new machine. Every key
   is optional (defaults apply if the file or a key is missing):

   | Key                      | Default     | Meaning                                                                                                                                                              |
   | ------------------------ | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | `retentionDays`          | `3`         | After each run, files older than this are deleted from `.claude/tmp/`, `.claude/logs/` and `reports/`.                                                               |
   | `gmail.labels.dmarc`     | `dmarc`     | Gmail label holding the DMARC aggregate report emails.                                                                                                               |
   | `gmail.labels.wordpress` | `wordpress` | Gmail label holding WordPress notification emails.                                                                                                                   |
   | `gmail.auth`             | none        | `{ clientId, clientSecret, refreshToken }` — OAuth credentials for the Gmail API. Written by `npm run gmail:auth` (see below); you don't normally edit this by hand. |
   | `hostinger.apiToken`     | none        | Hostinger API token (see below). Without it, PHP version checking/bumping is skipped.                                                                                |
   | `dmarc.knownSources`     | none        | Your legitimate senders: `{ "name", "match": [...] }`. Each `match` is a hostname suffix (reverse DNS) or an IP prefix, plain text.                                  |

   A DMARC source that matches and passes alignment is `ok`; one that matches but
   fails is `known-unaligned` (domain status `attention`); one that doesn't match
   any entry is `unknown` (domain status `alert`, possible spoofing).

## Usage

```sh
npm run wp:update      # check and apply updates on every configured site
npm run wp:check       # dry run — report available updates only, no changes
npm run wp:check-ssh   # validate SSH connectivity/auth per site, no WP-CLI
```

Target a single site instead of the whole fleet:

```sh
node src/update-plugins.js --site <name> [--dry-run]
node src/check-ssh.js --site <name>
```

Each `wp:update` / `wp:check` run writes a timestamped report to `reports/`
(`<timestamp>-wp-update.md` and `.json`, gitignored) and prints a console
summary. One site or category failing doesn't stop the others; the process
exits with code `1` if any site ended up in a non-OK state.

### Running on demand (menu + HTML report)

`.claude/scripts/run-daily-update.ps1` runs the WordPress skill headlessly (Claude Code) and the DMARC step as a plain Node script.
Without arguments it shows a menu (or pass `-Mode wp|dmarc|all|dryrun|dmarcdry`):

**Update**

1. **Update WordPress sites** — `/wp-update-plugins`: updates plugins, themes
   and translations, then `node src/php-check.js` checks/bumps PHP via the
   Hostinger API, then `node src/wp-mails-fetch.js` processes the WordPress
   notification emails (Gmail `wordpress` label, classified by rules, moved to
   the trash afterwards). None of these three steps need Claude except the
   update itself.
2. **Process DMARC reports** — `node src/dmarc-fetch.js`: parses the reports under the Gmail
   `dmarc` label, adds highlights and moves the processed emails to the trash.
3. **Do everything** — both.

**Check only** (changes nothing)

4. **Check WordPress sites** — nothing is updated, no PHP bump, no emails trashed
   (`-Mode dryrun`).
5. **Check DMARC reports** — parses and reports but trashes nothing, so it can be
   repeated (`-Mode dmarcdry`).

When it finishes it builds `reports/<timestamp>-report.html` (via
`src/build-report.js`) and opens it, then deletes files older than
`retentionDays`. Logs go to `.claude/logs/` (gitignored). No Gmail drafts are
created. You can also invoke `/wp-update-plugins` or `/dmarc-check` (the interactive DMARC variant) directly in a
Claude Code session. `wordpressMonitor Update.bat.example` is a sample
double-click shortcut for the runner.

**Optional:** `src/php-check.js` needs `hostinger.apiToken` set in `config.json`
(generate one at [hPanel → API](https://hpanel.hostinger.com/profile/api)). If
it's missing, the step writes `{ "unavailable": true }` and is skipped —
nothing else in this workflow depends on it.

For each site, it compares the running PHP version to the highest version
Hostinger supports. When a newer version is available **and** no plugin/theme
on that site was flagged by the WP-CLI PHP compatibility check (below), it
auto-applies the bump via the Hostinger API (jumping to the highest supported
version) with no confirmation prompt — this runs unattended on every
invocation, including headless/scheduled runs. A successful bump is reported
as routine info in the report, not as something needing action. If a
plugin/theme was flagged (or the update call itself fails), it's skipped and
reported as an alert instead so it can be reviewed manually first.

## How it works

`src/lib/config.js` reads and writes `config.json`, the one gitignored file
holding both local settings and credentials (Gmail OAuth tokens, Hostinger API
token). Every script that needs a setting or a credential goes through it.

`src/update-plugins.js` connects to each site over SSH ([`ssh2`](https://github.com/mscdex/ssh2))
and runs WP-CLI to detect and apply updates in three categories:

- **Plugins** — `wp plugin list` / `wp plugin update`
- **Themes** — `wp theme list` / `wp theme update`
- **Translations** — `wp language core|plugin|theme list` / `update`, with a
  re-check afterwards so any translation that didn't apply is reported as
  still remaining

It also checks (but never applies) two things that need manual review:

- **WordPress core updates** — `wp core check-update`. Core is never updated
  automatically since a major/minor upgrade can break a site.
- **PHP compatibility** — the site's current PHP version (via `wp eval`)
  compared against WordPress's recommended minimum, plus any installed
  plugin/theme whose `Requires PHP` header exceeds it. This flags outdated or
  unsupported PHP, not "a newer version exists" — a site already on a
  supported version reports OK even if a newer PHP release is available.

Either check finding something marks the site `attention-needed` in the
report, and the HTML report leads with an "Action needed" section summarizing
what to review.

After a real (non-dry-run) run that actually applied a plugin, theme or
translation update on a site, it fetches that site's homepage once (`siteUrl`
in `sites.json`, or `https://<domain>` derived from the domain folder in
`wpPath` when not set) and flags the site `attention-needed` if the response
is 4xx/5xx, the connection fails, or the body contains WordPress's
critical-error marker text. Skipped on dry runs and on sites with zero
updates applied.

`src/php-check.js` reads `src/lib/hostinger.js` (plain `fetch`, no
dependencies) to call the Hostinger API directly — no Claude, no MCP
connector. It reuses the newest `<ts>-wp-update.json`'s `phpCompatibility`
data instead of re-checking compatibility itself.

`src/dmarc-fetch.js` reads the DMARC label through the Gmail API (`src/lib/gmail.js`), runs the parser, writes a rule-based narrative and trashes the parsed threads (not with `--dry-run`). It needs a one-time setup: create a Google Cloud project with the Gmail API enabled and an OAuth client of type **Desktop app** (publish the consent screen "In production", otherwise the refresh token expires after 7 days), then run `npm run gmail:auth`, which saves the resulting OAuth credentials to `gmail.auth` in `config.json`.

`src/parse-dmarc.js` decodes DMARC aggregate report emails (base64url RAW
message → zip/gzip → XML), classifies each source IP against
`dmarc.knownSources` and computes highlights, with no dependencies.
`src/build-report.js` renders the run's JSON results into the HTML report.

`src/check-ssh.js` is a smaller, independent diagnostic: it checks raw TCP
reachability to `host:port` and then attempts an SSH handshake/auth using
the same credential resolution as the updater, so connection problems can be
told apart from update problems.

## Formatting

```sh
npm run prettier
```

Runs Prettier across the repo (config in `.prettierrc`).

## License

[MIT](LICENSE)
