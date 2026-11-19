'use strict';

/**
 * Effective security settings for a site: built-in defaults, overridden by
 * config.json "security" (global) and then by the per-site fields in
 * sites.json. Arrays are merged (union), scalars are replaced.
 */

const { readConfig } = require('../config');

const DEFAULTS = {
  // mu-plugins that are legitimate on every site.
  allowedMuPlugins: [
    'hostinger-auto-updates.php',
    'installatron_hide_status_test.php',
    '_patchstack.php',
    'index.php'
  ],
  // Permanent indicators of compromise (case-insensitive substrings): option
  // names, cron hooks, mu-plugins, plugins, file names and user logins.
  iocPatterns: ['wpsip', 'sendinfo'],
  // PHP files in uploads that are known and harmless (path substrings).
  allowedUploadsPhp: [],
  // Plugins (folder names) allowed to call api.telegram.org.
  allowedTelegramPlugins: [],
  // Path regexes skipped by the obfuscated-code grep (security plugins ship
  // such patterns on purpose).
  codeScanIgnore: ['/wordfence/', '/sucuri', '/patchstack'],
  // Path regexes reported as info (known false positives).
  codeScanKnownFalsePositives: ['wpforms-lite/src/Helpers/Chain\\.php'],
  // db-scan.
  dbScanMaxResults: 25,
  dbScanAllowedDomains: [],
  dbScanIgnoreOptionPrefixes: [
    'wordfence',
    'wf',
    'sucuri',
    'jetpack',
    'wpforms',
    'limit_login',
    'elementor',
    'mailchimp'
  ],
  dbScanIgnoreMetaPrefixes: ['_oembed_', '_elementor'],
  // public-site: words that point to SEO spam.
  spamKeywords: [
    'casino',
    'viagra',
    'cialis',
    'pharma',
    'payday loan',
    'online poker',
    'porn',
    'escort',
    'replica watches',
    'buy cheap'
  ],
  // backups / tls / domain expiry.
  maxBackupAgeDays: 3,
  tlsWarnDays: 14,
  tlsAlertDays: 7,
  domainWarnDays: 30,
  domainAlertDays: 14,
  // abandoned: plugins/themes not updated for this many years.
  abandonedYears: 2,
  // Per site only: administrators expected (default 1) and "this exposure is
  // expected" switches for the exposed-files check.
  expectedAdmins: 1,
  expectXmlrpc: false,
  expectUserEnumeration: false
};

const ARRAY_KEYS = Object.keys(DEFAULTS).filter(k =>
  Array.isArray(DEFAULTS[k])
);

function merge(base, extra) {
  const out = { ...base };
  for (const [k, v] of Object.entries(extra || {})) {
    if (v === undefined || v === null) continue;
    out[k] =
      ARRAY_KEYS.includes(k) && Array.isArray(v)
        ? [...new Set([...(base[k] || []), ...v])]
        : v;
  }
  return out;
}

// Site-level keys live directly in sites.json (e.g. "allowedMuPlugins").
function securityConfig(site) {
  const global = readConfig().security || {};
  const picked = {};
  for (const k of Object.keys(DEFAULTS)) {
    if (site && site[k] !== undefined) picked[k] = site[k];
  }
  return merge(merge(DEFAULTS, global), picked);
}

function globalSecurityConfig() {
  return merge(DEFAULTS, readConfig().security || {});
}

module.exports = { DEFAULTS, securityConfig, globalSecurityConfig };
