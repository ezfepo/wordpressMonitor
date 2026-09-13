# wpMon

Keeps a fleet of WordPress sites up to date. wpMon connects to each site over
SSH and uses [WP-CLI](https://wp-cli.org/) to check and update plugins,
themes, and translation/language packs — then writes a per-site Markdown +
JSON report.

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

### Running via `/wp-update-plugins` (Claude Code)

`.claude/skills/wp-update-plugins/` runs the update, reads the report, and
drafts an email summary via the Gmail MCP integration (tagged with a
`wordpress` Gmail label). Invoke it as `/wp-update-plugins` in a Claude Code
session, or headlessly via `.claude/scripts/run-daily-update.ps1`, which logs
each run to `.claude/logs/` (gitignored). `wpMon Update.bat.example` is a
sample double-click shortcut for triggering that script on demand.

## How it works

`src/update-plugins.js` connects to each site over SSH ([`ssh2`](https://github.com/mscdex/ssh2))
and runs WP-CLI to detect and apply updates in three categories:

- **Plugins** — `wp plugin list` / `wp plugin update`
- **Themes** — `wp theme list` / `wp theme update`
- **Translations** — `wp language core|plugin|theme list` / `update`, with a
  re-check afterwards so any translation that didn't apply is reported as
  still remaining

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
