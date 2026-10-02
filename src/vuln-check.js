/**
 * Known-vulnerability check via the WPVulnerability.net API, no Claude: for
 * every plugin/theme installed on every site (including ones excluded from
 * auto-update in sites.json), flags any with a known unpatched vulnerability
 * affecting the installed version -> reports/<ts>-vuln.json.
 *
 * Usage: node src/vuln-check.js
 *
 * API: https://docs.wpvulnerability.com/ — public, no API key, one GET per
 * slug (https://www.wpvulnerability.net/plugin/{slug}/ or /theme/{slug}/),
 * cached permanently server-side. Reuses the newest <ts>-wp-update.json's
 * plugins.installed / themes.installed (written by update-plugins.js) instead
 * of re-listing over SSH; unique slugs across all sites are queried once.
 *
 * Excluded plugins/themes (sites.json excludePlugins/excludeThemes) are
 * checked the same as everything else — those are exactly the ones most
 * likely to go stale, since they're skipped by auto-update.
 */

const fs = require('node:fs');
const path = require('node:path');
const { timestampSlug } = require('./lib/format');
const { satisfiesOperator } = require('./lib/version');

const ROOT = path.resolve(__dirname, '..');
const REPORTS = path.join(ROOT, 'reports');
const API_BASE = 'https://www.wpvulnerability.net';
const REQUEST_TIMEOUT_MS = 15000;

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// Newest reports/<ts>-wp-update.json.
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

// { plugin: Map<slug, [{site, version}]>, theme: Map<slug, [{site, version}]> }
function collectInstalled(wpUpdate) {
  const installed = { plugin: new Map(), theme: new Map() };
  for (const result of wpUpdate?.results || []) {
    for (const [kind, section] of [
      ['plugin', result.plugins],
      ['theme', result.themes]
    ]) {
      for (const item of section?.installed || []) {
        if (!installed[kind].has(item.name)) {
          installed[kind].set(item.name, []);
        }
        installed[kind]
          .get(item.name)
          .push({ site: result.site, version: item.version });
      }
    }
  }
  return installed;
}

// Thrown for a slug the API rejects outright (not a WordPress.org slug, e.g.
// a premium/custom plugin or an internal mu-plugin-style name starting with
// "_") — expected and skipped quietly, not a lookup failure.
class InvalidSlugError extends Error {}

async function fetchVulnerabilities(kind, slug) {
  const res = await fetch(`${API_BASE}/${kind}/${encodeURIComponent(slug)}/`, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  if (res.status === 404) {
    throw new InvalidSlugError(`${kind}/${slug}: not a WordPress.org slug`);
  }
  if (!res.ok) {
    throw new Error(`${kind}/${slug}: HTTP ${res.status}`);
  }
  const json = await res.json();
  if (json.error) {
    throw new Error(`${kind}/${slug}: ${json.message || 'API error'}`);
  }
  return json.data?.vulnerability || [];
}

// A vulnerability applies when the installed version satisfies both bounds
// (missing bound = unbounded on that side). WPVulnerability's operators
// follow PHP version_compare() semantics (lt/le/eq/ne/gt/ge).
function versionAffected(version, operator) {
  const { min_version, min_operator, max_version, max_operator } =
    operator || {};
  if (min_version && !satisfiesOperator(version, min_operator, min_version)) {
    return false;
  }
  if (max_version && !satisfiesOperator(version, max_operator, max_version)) {
    return false;
  }
  return true;
}

async function checkSlug(kind, slug, installs) {
  let vulnerabilities;
  try {
    vulnerabilities = await fetchVulnerabilities(kind, slug);
  } catch (err) {
    if (err instanceof InvalidSlugError) {
      return { kind, slug, error: null, skipped: true, flagged: [] };
    }
    return { kind, slug, error: err.message, flagged: [] };
  }
  if (!vulnerabilities || vulnerabilities.length === 0) {
    return { kind, slug, error: null, flagged: [] };
  }

  const flagged = [];
  for (const install of installs) {
    const matches = vulnerabilities.filter(v =>
      versionAffected(install.version, v.operator)
    );
    for (const v of matches) {
      flagged.push({
        site: install.site,
        kind,
        slug,
        installedVersion: install.version,
        name: v.name,
        unfixed: v.operator?.unfixed === '1' || v.operator?.unfixed === 1,
        fixedIn:
          v.operator?.max_operator === 'lt' ? v.operator.max_version : null,
        sources: (v.source || []).map(s => s.id)
      });
    }
  }
  return { kind, slug, error: null, flagged };
}

async function main() {
  fs.mkdirSync(REPORTS, { recursive: true });
  const outFile = path.join(REPORTS, `${timestampSlug(new Date())}-vuln.json`);

  const wpUpdate = loadLatestWpUpdate();
  if (!wpUpdate) {
    fs.writeFileSync(
      outFile,
      JSON.stringify(
        { unavailable: true, reason: 'no wp-update.json found' },
        null,
        2
      )
    );
    console.log('No wp-update.json found: vulnerability check skipped.');
    return;
  }

  const installed = collectInstalled(wpUpdate);
  const results = [];
  for (const kind of ['plugin', 'theme']) {
    for (const [slug, installs] of installed[kind]) {
      results.push(await checkSlug(kind, slug, installs));
    }
  }

  const flagged = results.flatMap(r => r.flagged);
  const skipped = results.filter(r => r.skipped).length;
  const errors = results
    .filter(r => r.error)
    .map(r => `${r.kind}/${r.slug}: ${r.error}`);

  fs.writeFileSync(
    outFile,
    JSON.stringify(
      { checked: results.length, flagged, skipped, errors },
      null,
      2
    )
  );

  console.log(
    `Vuln check: ${results.length} slug(s) checked, ${flagged.length} vulnerable install(s) found, ${skipped} not on WordPress.org${errors.length ? `, ${errors.length} lookup error(s)` : ''}.`
  );
  if (errors.length) process.exitCode = 1;
}

main().catch(err => {
  console.error(`vuln-check error: ${err.message}`);
  process.exitCode = 1;
});
