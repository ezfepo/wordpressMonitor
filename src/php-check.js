/**
 * PHP version check/bump via the Hostinger API, no Claude: for each site,
 * compares the running PHP version to the highest Hostinger supports and
 * auto-applies the bump when safe -> reports/<ts>-php.json.
 *
 * Usage: node src/php-check.js [--dry-run]
 *
 * Requires config.json's "hostinger.apiToken" (gitignored, see hostinger.js).
 * If it's missing, writes { "unavailable": true } and exits 0 — this step is
 * optional, the rest of the workflow doesn't depend on it.
 *
 * Reuses this run's <ts>-wp-update.json (the newest one) for each site's
 * phpCompatibility.incompatibleItems, so a flagged plugin/theme blocks the
 * auto-bump exactly like the old Claude-driven skill step did.
 *
 * Standing approval: bumping PHP to the highest supported version is
 * auto-applied with no per-run confirmation, including headless/scheduled
 * runs, as long as no plugin/theme was flagged — see CLAUDE.md.
 */

const fs = require('node:fs');
const path = require('node:path');
const hostinger = require('./lib/hostinger');
const { timestampSlug } = require('./lib/format');

const ROOT = path.resolve(__dirname, '..');
const REPORTS = path.join(ROOT, 'reports');

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// name -> domain (folder inside wpPath), sshUser.
function loadSites() {
  const config = readJson(path.join(ROOT, 'sites.json'));
  return (config?.sites || []).map(s => ({
    name: s.name,
    username: s.sshUser,
    domain: (s.wpPath || '').match(/domains\/([^/]+)/)?.[1] || null
  }));
}

// Newest reports/<ts>-wp-update.json, for this run's PHP-compatibility flags.
function loadLatestWpUpdate() {
  if (!fs.existsSync(REPORTS)) return null;
  const candidates = fs
    .readdirSync(REPORTS)
    .filter(f => /^\d{4}-\d{2}-\d{2}-\d{6}-wp-update\.json$/.test(f))
    .map(f => {
      const full = path.join(REPORTS, f);
      return { full, mtime: fs.statSync(full).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
  return candidates.length ? readJson(candidates[0].full) : null;
}

function incompatibilityReason(wpUpdate, siteName) {
  const result = wpUpdate?.results?.find(r => r.site === siteName);
  const items = result?.phpCompatibility?.incompatibleItems || [];
  if (items.length === 0) return null;
  return items
    .map(i => `${i.kind} "${i.name}" requires PHP ${i.requiresPhp}`)
    .join('; ');
}

async function checkSite(site, wpUpdate, dryRun) {
  const base = { site: site.name };
  if (!site.username || !site.domain) {
    return {
      ...base,
      outcome: 'failed',
      error: 'Missing sshUser or wpPath-derived domain in sites.json'
    };
  }

  let details;
  try {
    details = await hostinger.getPhpDetails(site.username, site.domain);
  } catch (err) {
    return { ...base, outcome: 'failed', error: err.message };
  }

  const current = details.php_version;
  const highest = hostinger.highestVersion(details.php_versions?.supported);
  if (!highest || highest === current) {
    return {
      ...base,
      current,
      highest: highest || current,
      outcome: 'up-to-date'
    };
  }

  const reason = incompatibilityReason(wpUpdate, site.name);
  if (reason) {
    return { ...base, current, highest, outcome: 'skipped-compat', reason };
  }

  if (dryRun) {
    return { ...base, current, highest, outcome: 'available-dry-run' };
  }

  try {
    await hostinger.updatePhpVersion(site.username, site.domain, highest);
    return {
      ...base,
      current,
      highest,
      newVersion: highest,
      outcome: 'bumped'
    };
  } catch (err) {
    return { ...base, current, highest, outcome: 'failed', error: err.message };
  }
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  fs.mkdirSync(REPORTS, { recursive: true });
  const outFile = path.join(REPORTS, `${timestampSlug(new Date())}-php.json`);

  if (!hostinger.isConfigured()) {
    fs.writeFileSync(outFile, JSON.stringify({ unavailable: true }, null, 2));
    console.log(
      'Hostinger API not configured (config.json has no hostinger.apiToken): skipped.'
    );
    return;
  }

  const sites = loadSites();
  const wpUpdate = loadLatestWpUpdate();
  const results = [];
  for (const site of sites) {
    results.push(await checkSite(site, wpUpdate, dryRun));
  }

  fs.writeFileSync(outFile, JSON.stringify({ sites: results }, null, 2));

  const bumped = results.filter(r => r.outcome === 'bumped').length;
  const alerts = results.filter(r =>
    ['skipped-compat', 'failed'].includes(r.outcome)
  ).length;
  console.log(
    `PHP check: ${results.length} site(s), ${bumped} bumped, ${alerts} needing attention${dryRun ? ' (dry run)' : ''}.`
  );
  if (results.some(r => r.outcome === 'failed')) process.exitCode = 1;
}

main().catch(err => {
  console.error(`php-check error: ${err.message}`);
  process.exitCode = 1;
});
