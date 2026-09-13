'use strict';

/**
 * wordpressMonitor — WordPress updater for Hostinger-hosted sites.
 *
 * Reads sites.json, connects to each site over SSH and uses WP-CLI to
 * detect and (unless --dry-run) apply updates for:
 *   - plugins       (wp plugin list / update)
 *   - themes        (wp theme list / update)
 *   - translations  (wp language core|plugin|theme list / update)
 * Writes a JSON + Markdown report to reports/ and prints a console summary.
 *
 * Usage:
 *   node src/update-plugins.js [--dry-run] [--site <name>]
 *
 * Credentials live in sites.json itself (see sites.json.example): per site,
 * either sshPassword or sshKeyPath (+ optional sshKeyPassphrase).
 * sites.json is gitignored, so this never leaves the machine it's configured
 * on.
 */

const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('ssh2');

const ROOT = path.resolve(__dirname, '..');
const SITES_FILE = path.join(ROOT, 'sites.json');
const REPORTS_DIR = path.join(ROOT, 'reports');
const SSH_READY_TIMEOUT_MS = 20000;
const COMMAND_TIMEOUT_MS = 300000;

function parseArgs(argv) {
  const args = { dryRun: false, site: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      args.dryRun = true;
    } else if (arg === '--site') {
      args.site = argv[++i];
      if (!args.site) {
        throw new Error('--site requires a value');
      }
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function loadSites() {
  if (!fs.existsSync(SITES_FILE)) {
    throw new Error(`Missing sites.json at ${SITES_FILE}`);
  }
  const config = JSON.parse(fs.readFileSync(SITES_FILE, 'utf8'));
  if (!Array.isArray(config.sites) || config.sites.length === 0) {
    throw new Error('sites.json must contain a non-empty "sites" array');
  }
  for (const site of config.sites) {
    for (const field of ['name', 'sshHost', 'sshUser', 'wpPath']) {
      if (!site[field]) {
        throw new Error(
          `sites.json entry ${JSON.stringify(site.name || site)} is missing "${field}"`
        );
      }
    }
  }
  return config.sites;
}

function credentialsForSite(site) {
  const { sshPassword, sshKeyPath, sshKeyPassphrase } = site;
  if (sshKeyPath) {
    if (!fs.existsSync(sshKeyPath)) {
      throw new Error(
        `SSH key for site "${site.name}" not found at ${sshKeyPath} (sshKeyPath in sites.json)`
      );
    }
    return {
      privateKey: fs.readFileSync(sshKeyPath, 'utf8'),
      passphrase: sshKeyPassphrase
    };
  }
  if (sshPassword) {
    return { password: sshPassword };
  }
  throw new Error(
    `No credentials for site "${site.name}": set sshPassword or sshKeyPath in sites.json`
  );
}

function sshConnect(site, credentials) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    conn
      .on('ready', () => resolve(conn))
      .on('error', err =>
        reject(new Error(`SSH connection failed: ${err.message}`))
      )
      .connect({
        host: site.sshHost,
        port: site.sshPort || 22,
        username: site.sshUser,
        readyTimeout: SSH_READY_TIMEOUT_MS,
        ...credentials
      });
  });
}

function execCommand(conn, command) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          `Command timed out after ${COMMAND_TIMEOUT_MS / 1000}s: ${command}`
        )
      );
    }, COMMAND_TIMEOUT_MS);
    conn.exec(command, (err, stream) => {
      if (err) {
        clearTimeout(timer);
        return reject(err);
      }
      let stdout = '';
      let stderr = '';
      stream
        .on('close', code => {
          clearTimeout(timer);
          resolve({ code: code ?? 0, stdout, stderr });
        })
        .on('data', data => {
          stdout += data.toString();
        })
        .stderr.on('data', data => {
          stderr += data.toString();
        });
    });
  });
}

// WP-CLI can print PHP notices/warnings around the JSON payload; extract the
// outermost JSON array before parsing.
function parseWpJson(stdout, context) {
  const start = stdout.indexOf('[');
  const end = stdout.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) {
    throw new Error(
      `Could not parse WP-CLI JSON output (${context}): ${stdout.slice(0, 500)}`
    );
  }
  return JSON.parse(stdout.slice(start, end + 1));
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function wpCommand(site, args) {
  return `wp ${args} --path=${shellQuote(site.wpPath)} --skip-plugins --skip-themes`;
}

function truncateOutput(result) {
  return (result.stderr || result.stdout).trim().slice(0, 500);
}

// kind: 'plugin' | 'theme'
async function listItemsWithUpdates(conn, site, kind) {
  const cmd = wpCommand(site, `${kind} list --update=available --format=json`);
  const result = await execCommand(conn, cmd);
  if (result.code !== 0) {
    throw new Error(
      `wp ${kind} list failed (exit ${result.code}): ${truncateOutput(result)}`
    );
  }
  return parseWpJson(result.stdout, `${kind} list`);
}

async function updateItems(conn, site, kind, names) {
  const quoted = names.map(shellQuote).join(' ');
  const cmd = wpCommand(site, `${kind} update ${quoted} --format=json`);
  const result = await execCommand(conn, cmd);
  // wp plugin/theme update exits non-zero if any single item fails; the JSON
  // still lists per-item status, so parse it either way.
  try {
    return parseWpJson(result.stdout, `${kind} update`);
  } catch (err) {
    throw new Error(
      `wp ${kind} update failed (exit ${result.code}): ${truncateOutput(result)}`
    );
  }
}

// Detect available translation (language pack) updates for core, plugins and
// themes. Returns [{ type, name, language }].
async function listTranslationUpdates(conn, site) {
  const sources = [
    {
      type: 'core',
      cmd: 'language core list --update=available --format=json',
      nameOf: () => 'core'
    },
    {
      type: 'plugin',
      cmd: 'language plugin list --all --update=available --format=json',
      nameOf: row => row.plugin
    },
    {
      type: 'theme',
      cmd: 'language theme list --all --update=available --format=json',
      nameOf: row => row.theme
    }
  ];
  const found = [];
  for (const source of sources) {
    const result = await execCommand(conn, wpCommand(site, source.cmd));
    if (result.code !== 0) {
      throw new Error(
        `wp ${source.cmd.split(' --')[0]} failed (exit ${result.code}): ${truncateOutput(result)}`
      );
    }
    for (const row of parseWpJson(result.stdout, `language ${source.type}`)) {
      found.push({
        type: source.type,
        name: source.nameOf(row),
        language: row.language
      });
    }
  }
  return found;
}

async function updateTranslations(conn, site) {
  const commands = [
    'language core update',
    'language plugin update --all',
    'language theme update --all'
  ];
  for (const args of commands) {
    const result = await execCommand(conn, wpCommand(site, args));
    if (result.code !== 0) {
      throw new Error(
        `wp ${args} failed (exit ${result.code}): ${truncateOutput(result)}`
      );
    }
  }
}

function emptySection() {
  return { available: [], updated: [], failed: [], excluded: [] };
}

async function processItemSection(conn, site, kind, excludeList, options) {
  const section = emptySection();
  const available = await listItemsWithUpdates(conn, site, kind);
  section.available = available.map(item => ({
    name: item.name,
    version: item.version,
    updateVersion: item.update_version || null
  }));

  const names = available.map(item => item.name);
  const toUpdate = names.filter(name => !excludeList.includes(name));
  section.excluded = names.filter(name => excludeList.includes(name));

  if (options.dryRun || toUpdate.length === 0) {
    return section;
  }

  const updates = await updateItems(conn, site, kind, toUpdate);
  for (const update of updates) {
    const entry = {
      name: update.name,
      oldVersion: update.old_version,
      newVersion: update.new_version,
      status: update.status
    };
    if (update.status === 'Updated') {
      section.updated.push(entry);
    } else {
      section.failed.push(entry);
    }
  }
  return section;
}

async function processTranslationSection(conn, site, options) {
  const section = { available: [], updated: [], remaining: [] };
  section.available = await listTranslationUpdates(conn, site);

  if (options.dryRun || section.available.length === 0) {
    return section;
  }

  await updateTranslations(conn, site);
  // Whatever is still listed as available after updating did not apply.
  section.remaining = await listTranslationUpdates(conn, site);
  const remainingKeys = new Set(
    section.remaining.map(t => `${t.type}/${t.name}/${t.language}`)
  );
  section.updated = section.available.filter(
    t => !remainingKeys.has(`${t.type}/${t.name}/${t.language}`)
  );
  return section;
}

function computeStatus(result) {
  const anyUpdated =
    result.plugins.updated.length > 0 ||
    result.themes.updated.length > 0 ||
    result.translations.updated.length > 0;
  if (result.errors.length > 0) {
    return anyUpdated ? 'partial' : 'failed';
  }
  if (
    result.plugins.failed.length > 0 ||
    result.themes.failed.length > 0 ||
    result.translations.remaining.length > 0
  ) {
    return 'partial';
  }
  return 'ok';
}

async function processSite(site, options) {
  const result = {
    site: site.name,
    host: site.sshHost,
    status: 'ok',
    dryRun: options.dryRun,
    connected: false,
    plugins: emptySection(),
    themes: emptySection(),
    translations: { available: [], updated: [], remaining: [] },
    errors: []
  };

  let credentials;
  try {
    credentials = credentialsForSite(site);
  } catch (err) {
    result.status = 'failed';
    result.errors.push(err.message);
    return result;
  }

  let conn;
  try {
    conn = await sshConnect(site, credentials);
  } catch (err) {
    result.status = 'unreachable';
    result.errors.push(err.message);
    return result;
  }
  result.connected = true;

  // One category failing must not skip the others.
  try {
    try {
      result.plugins = await processItemSection(
        conn,
        site,
        'plugin',
        site.excludePlugins || [],
        options
      );
    } catch (err) {
      result.errors.push(`plugins: ${err.message}`);
    }
    try {
      result.themes = await processItemSection(
        conn,
        site,
        'theme',
        site.excludeThemes || [],
        options
      );
    } catch (err) {
      result.errors.push(`themes: ${err.message}`);
    }
    try {
      result.translations = await processTranslationSection(
        conn,
        site,
        options
      );
    } catch (err) {
      result.errors.push(`translations: ${err.message}`);
    }
  } finally {
    conn.end();
  }
  result.status = computeStatus(result);
  return result;
}

function markdownItemSection(lines, label, section, options) {
  const hasContent =
    section.available.length > 0 ||
    section.updated.length > 0 ||
    section.failed.length > 0 ||
    section.excluded.length > 0;
  if (!hasContent) {
    lines.push(`- ${label}: up to date.`);
    return;
  }
  if (options.dryRun) {
    lines.push(`- ${label}: ${section.available.length} update(s) available:`);
    for (const item of section.available) {
      lines.push(
        `  - ${item.name}: ${item.version} → ${item.updateVersion || '?'}`
      );
    }
  }
  for (const item of section.updated) {
    lines.push(
      `- ${label}: updated ${item.name}: ${item.oldVersion} → ${item.newVersion}`
    );
  }
  for (const item of section.failed) {
    lines.push(
      `- ${label}: FAILED to update ${item.name} (${item.oldVersion} → ${item.newVersion || '?'}): ${item.status}`
    );
  }
  for (const name of section.excluded) {
    lines.push(`- ${label}: skipped ${name} (excluded in sites.json)`);
  }
}

function describeTranslation(t) {
  return t.type === 'core'
    ? `core (${t.language})`
    : `${t.type} ${t.name} (${t.language})`;
}

function markdownTranslationSection(lines, section, options) {
  if (section.available.length === 0) {
    lines.push('- Translations: up to date.');
    return;
  }
  if (options.dryRun) {
    lines.push(
      `- Translations: ${section.available.length} update(s) available:`
    );
    for (const t of section.available) {
      lines.push(`  - ${describeTranslation(t)}`);
    }
    return;
  }
  for (const t of section.updated) {
    lines.push(`- Translations: updated ${describeTranslation(t)}`);
  }
  for (const t of section.remaining) {
    lines.push(
      `- Translations: still pending after update: ${describeTranslation(t)}`
    );
  }
}

const REPORT_TIME_ZONE = 'America/Argentina/Buenos_Aires';

function formatArgentinaTimestamp(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: REPORT_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  })
    .formatToParts(date)
    .reduce((acc, part) => {
      acc[part.type] = part.value;
      return acc;
    }, {});
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second} ART`;
}

function timestampSlug(date) {
  return formatArgentinaTimestamp(date)
    .replace(' ART', '')
    .replace(' ', '-')
    .replace(/:/g, '');
}

function buildMarkdownReport(results, options, timestamp) {
  const lines = [];
  lines.push(`# wordpressMonitor update report — ${formatArgentinaTimestamp(timestamp)}`);
  lines.push('');
  lines.push(`Mode: ${options.dryRun ? 'dry run (check only)' : 'update'}`);
  lines.push('');
  for (const r of results) {
    lines.push(`## ${r.site} (${r.host}) — ${r.status}`);
    lines.push('');
    for (const err of r.errors) {
      lines.push(`- ERROR: ${err}`);
    }
    if (r.connected) {
      markdownItemSection(lines, 'Plugins', r.plugins, options);
      markdownItemSection(lines, 'Themes', r.themes, options);
      markdownTranslationSection(lines, r.translations, options);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function printSummary(results) {
  console.log('');
  console.log('Summary:');
  for (const r of results) {
    const counts = r.dryRun
      ? `${r.plugins.available.length} plugin, ${r.themes.available.length} theme, ${r.translations.available.length} translation update(s) available`
      : `${r.plugins.updated.length} plugin(s), ${r.themes.updated.length} theme(s), ${r.translations.updated.length} translation(s) updated` +
        (r.plugins.failed.length + r.themes.failed.length > 0
          ? `, ${r.plugins.failed.length + r.themes.failed.length} failed`
          : '');
    console.log(`  ${r.site}: ${r.status} — ${counts}`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  let sites = loadSites();
  if (options.site) {
    sites = sites.filter(s => s.name === options.site);
    if (sites.length === 0) {
      throw new Error(`No site named "${options.site}" in sites.json`);
    }
  }

  const timestamp = new Date();
  console.log(
    `wordpressMonitor: ${options.dryRun ? 'checking' : 'updating'} plugins, themes and translations on ${sites.length} site(s)...`
  );

  const results = [];
  for (const site of sites) {
    console.log(`- ${site.name} (${site.sshHost})...`);
    const result = await processSite(site, options);
    results.push(result);
    console.log(`  ${result.status}`);
  }

  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const slug = timestampSlug(timestamp);
  const jsonPath = path.join(REPORTS_DIR, `wp-update-${slug}.json`);
  const mdPath = path.join(REPORTS_DIR, `wp-update-${slug}.md`);
  fs.writeFileSync(
    jsonPath,
    JSON.stringify(
      { timestamp: timestamp.toISOString(), dryRun: options.dryRun, results },
      null,
      2
    )
  );
  fs.writeFileSync(mdPath, buildMarkdownReport(results, options, timestamp));

  printSummary(results);
  console.log('');
  console.log(`Report: ${mdPath}`);
  console.log(`Detail: ${jsonPath}`);

  const anyFailure = results.some(r => r.status !== 'ok');
  process.exitCode = anyFailure ? 1 : 0;
}

main().catch(err => {
  console.error(`wordpressMonitor error: ${err.message}`);
  process.exitCode = 1;
});
