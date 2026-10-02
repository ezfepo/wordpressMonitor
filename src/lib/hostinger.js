/**
 * Minimal Hostinger API client (plain fetch, no dependencies).
 *
 * Credentials live in config.json's "hostinger.apiToken" (gitignored).
 * Generate a token in hPanel -> API (https://hpanel.hostinger.com/profile/api).
 * Docs: https://docs.hostinger.com/api-reference/overview
 */

const { readConfig } = require('./config');

const BASE = 'https://developers.hostinger.com';

function loadApiToken() {
  return readConfig().hostinger?.apiToken || null;
}

function isConfigured() {
  return Boolean(loadApiToken());
}

async function api(method, endpoint, { query, body } = {}) {
  const apiToken = loadApiToken();
  if (!apiToken) {
    throw new Error(
      'config.json has no hostinger.apiToken. Generate one at https://hpanel.hostinger.com/profile/api'
    );
  }
  const url = new URL(`${BASE}${endpoint}`);
  for (const [k, v] of Object.entries(query || {})) {
    if (v !== undefined) url.searchParams.set(k, v);
  }
  const res = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${apiToken}`,
      ...(body ? { 'content-type': 'application/json' } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      `Hostinger ${method} ${endpoint}: ${res.status} ${json.message || ''}`.trim()
    );
  }
  return json;
}

// { php_version, php_versions: { supported: {"8.3": "PHP 8.3", ...}, unsupported: {...} }, ... }
function getPhpDetails(username, domain) {
  return api(
    'GET',
    `/api/hosting/v1/accounts/${username}/websites/${domain}/php/details`
  );
}

function updatePhpVersion(username, domain, version) {
  return api(
    'PATCH',
    `/api/hosting/v1/accounts/${username}/websites/${domain}/php/version`,
    { body: { version } }
  );
}

function clearCache(username, domain) {
  return api(
    'DELETE',
    `/api/hosting/v1/accounts/${username}/websites/${domain}/cache/clear`
  );
}

// Highest key of a version map, sorted numerically (8.5 > 8.4 > ... > 7.3).
function highestVersion(versionMap) {
  const versions = Object.keys(versionMap || {});
  if (versions.length === 0) return null;
  return versions.sort((a, b) => {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const diff = (pa[i] || 0) - (pb[i] || 0);
      if (diff !== 0) return diff;
    }
    return 0;
  })[versions.length - 1];
}

module.exports = {
  isConfigured,
  getPhpDetails,
  updatePhpVersion,
  clearCache,
  highestVersion
};
