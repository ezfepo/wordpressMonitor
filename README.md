# wordpressMonitor

Keeps a fleet of WordPress sites up to date. wordpressMonitor connects to each site over
SSH and uses [WP-CLI](https://wp-cli.org/) to check and update plugins,
themes, and translation/language packs — then writes a per-site Markdown +
JSON report. It can also process DMARC aggregate reports from Gmail, and
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
   `excludeThemes` arrays skip specific slugs during updates.

   `sites.json` is never committed — it's gitignored, since it holds both
   site info and credentials.

3. Optional: configure local settings — copy the example:

   ```sh
   cp config.json.example config.json
   ```

   `config.json` is gitignored and every key is optional (defaults apply if the
   file or a key is missing):

   | Key                      | Default     | Meaning                                                                                                                             |
   | ------------------------ | ----------- | ----------------------------------------------------------------------------------------------------------------------------------- |
   | `retentionDays`          | `3`         | After each run, files older than this are deleted from `.claude/tmp/`, `.claude/logs/` and `reports/`.                              |
   | `gmail.labels.dmarc`     | `dmarc`     | Gmail label holding the DMARC aggregate report emails.                                                                              |
   | `gmail.labels.wordpress` | `wordpress` | Gmail label holding WordPress notification emails.                                                                                  |
   | `dmarc.knownSources`     | none        | Your legitimate senders: `{ "name", "match": [...] }`. Each `match` is a hostname suffix (reverse DNS) or an IP prefix, plain text. |

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
(`wp-update-<timestamp>.md` and `.json`, gitignored) and prints a console
summary. One site or category failing doesn't stop the others; the process
exits with code `1` if any site ended up in a non-OK state.

### Running on demand (menu + HTML report)

`.claude/scripts/run-daily-update.ps1` runs the Claude Code skills headlessly.
Without arguments it shows a menu (or pass `-Mode wp|dmarc|all|dryrun|dmarcdry`):

**Update**

1. **Update WordPress sites** — `/wp-update-plugins`: updates, PHP bump via
   Hostinger and processing of WordPress notification emails (the Gmail
   `wordpress` label, moved to the trash afterwards).
2. **Process DMARC reports** — `/dmarc-check`: parses the reports under the Gmail
   `dmarc` label, adds highlights and moves the processed emails to the trash.
3. **Do everything** — both, in separate sessions.

**Check only** (changes nothing)

4. **Check WordPress sites** — nothing is updated, no PHP bump, no emails trashed
   (`-Mode dryrun`).
5. **Check DMARC reports** — parses and reports but trashes nothing, so it can be
   repeated (`-Mode dmarcdry`).

When it finishes it builds `reports/report-<timestamp>.html` (via
`src/build-report.js`) and opens it, then deletes files older than
`retentionDays`. Logs go to `.claude/logs/` (gitignored). No Gmail drafts are
created. You can also invoke `/wp-update-plugins` or `/dmarc-check` directly in a
Claude Code session. `wordpressMonitor Update.bat.example` is a sample
double-click shortcut for the runner.

**Optional:** if the [Hostinger MCP connector](https://docs.hostinger.com/hostinger-connector/overview)
is connected in the session, the skill also checks each site's PHP version
against Hostinger's own list of available versions — this catches "a newer
PHP version is available" (matching hPanel's own notice), which the
WP-CLI-based PHP check below can't see. Nothing else in this workflow
depends on the connector; this step is skipped silently if it isn't set up.

When a newer version is available **and** no plugin/theme on that site was
flagged by the WP-CLI PHP compatibility check, the skill auto-applies the PHP
update via `hosting_updatePHPVersionV1` (jumping to the highest supported
version) with no confirmation prompt — this runs unattended on every
invocation, including headless/scheduled runs. A successful bump is reported
as routine info in the report, not as something needing action. If a
plugin/theme was flagged (or the update call itself fails), it's skipped and
reported as an alert instead so it can be reviewed manually first.

## How it works

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
