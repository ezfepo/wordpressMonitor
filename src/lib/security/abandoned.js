'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { ROOT } = require('../ssh');
const { runWithConcurrency } = require('../concurrency');
const { finding, list } = require('./common');

const REPORTS = path.join(ROOT, 'reports');
const API = 'https://api.wordpress.org';
const TIMEOUT_MS = 15000;
const YEAR_MS = 365.25 * 86400000;

function latestWpUpdate() {
  if (!fs.existsSync(REPORTS)) return null;
  const files = fs
    .readdirSync(REPORTS)
    .filter(f => /^\d{4}-\d{2}-\d{2}-\d{6}-wp-update\.json$/.test(f))
    .map(f => ({ f, m: fs.statSync(path.join(REPORTS, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  if (files.length === 0) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(REPORTS, files[0].f), 'utf8'));
  } catch {
    return null;
  }
}

// WordPress.org lookup for one slug:
// { state: 'ok'|'closed'|'unknown', lastUpdated: Date|null }
async function lookup(kind, slug) {
  const url =
    kind === 'plugin'
      ? `${API}/plugins/info/1.2/?action=plugin_information&request[slug]=${encodeURIComponent(slug)}`
      : `${API}/themes/info/1.2/?action=theme_information&request[slug]=${encodeURIComponent(slug)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  const json = await res.json().catch(() => null);
  if (!json) throw new Error(`${kind}/${slug}: HTTP ${res.status}`);
  if (json.error === 'closed') return { state: 'closed', lastUpdated: null };
  if (json.error) return { state: 'unknown', lastUpdated: null };
  const raw = json.last_updated;
  const when = raw
    ? new Date(String(raw).replace(/(\d+:\d+[ap]m) GMT/i, '$1 UTC'))
    : null;
  return {
    state: 'ok',
    lastUpdated: when && !Number.isNaN(when.getTime()) ? when : null
  };
}

// Unique slugs across every site are looked up once.
async function prepare(sites, shared) {
  shared.wpUpdate = latestWpUpdate();
  shared.info = new Map();
  if (!shared.wpUpdate) return;
  const jobs = new Map();
  for (const r of shared.wpUpdate.results || []) {
    for (const [kind, section] of [
      ['plugin', r.plugins],
      ['theme', r.themes]
    ]) {
      for (const item of section?.installed || []) {
        jobs.set(`${kind}/${item.name}`, { kind, slug: item.name });
      }
    }
  }
  await runWithConcurrency([...jobs.values()], 8, async ({ kind, slug }) => {
    try {
      shared.info.set(`${kind}/${slug}`, await lookup(kind, slug));
    } catch (err) {
      shared.info.set(`${kind}/${slug}`, {
        state: 'error',
        error: err.message
      });
    }
  });
}

async function run(ctx) {
  const wp = ctx.shared?.wpUpdate;
  const entry = wp?.results?.find(r => r.site === ctx.site.name);
  if (!entry) {
    return {
      findings: [
        finding(
          'info',
          'no wp-update.json entry for this site (run update-plugins first)'
        )
      ],
      snapshot: null,
      unavailable: true
    };
  }
  const findings = [];
  const years = ctx.config.abandonedYears;
  const allowedMu = new Set(
    ctx.config.allowedMuPlugins.map(n => n.replace(/.php$/, ''))
  );
  const buckets = {
    closed: [],
    stale: [],
    inactivePlugins: [],
    inactiveThemes: [],
    unknown: []
  };
  for (const [kind, section] of [
    ['plugin', entry.plugins],
    ['theme', entry.themes]
  ]) {
    for (const item of section?.installed || []) {
      // mu-plugins and drop-ins show up in `wp plugin list` but are not
      // wordpress.org plugins (older wp-update.json files lack `status`).
      if (
        ['must-use', 'dropin'].includes(item.status) ||
        item.name.endsWith('.php') ||
        allowedMu.has(item.name)
      ) {
        continue;
      }
      const info = ctx.shared.info.get(`${kind}/${item.name}`);
      const label = `${kind} ${item.name}`;
      if (item.status === 'inactive') {
        buckets[kind === 'plugin' ? 'inactivePlugins' : 'inactiveThemes'].push(
          item.name
        );
      }
      if (!info || info.state === 'error') continue;
      if (info.state === 'closed') buckets.closed.push(label);
      else if (info.state === 'unknown') buckets.unknown.push(label);
      else if (
        info.lastUpdated &&
        Date.now() - info.lastUpdated > years * YEAR_MS
      ) {
        buckets.stale.push(
          `${label} (${info.lastUpdated.toISOString().slice(0, 10)})`
        );
      }
    }
  }
  if (buckets.closed.length) {
    findings.push(
      finding('alert', `closed on wordpress.org: ${list(buckets.closed)}`)
    );
  }
  if (buckets.stale.length) {
    findings.push(
      finding(
        'warn',
        `not updated in over ${years} years: ${list(buckets.stale)}`
      )
    );
  }
  if (buckets.inactivePlugins.length) {
    findings.push(
      finding(
        'warn',
        `inactive plugins (remove if unused): ${list(buckets.inactivePlugins)}`
      )
    );
  }
  if (buckets.inactiveThemes.length) {
    findings.push(
      finding('info', `inactive themes: ${list(buckets.inactiveThemes)}`)
    );
  }
  if (buckets.unknown.length) {
    findings.push(
      finding(
        'info',
        `unknown (not on wordpress.org): ${list(buckets.unknown)}`
      )
    );
  }
  return { findings, snapshot: null };
}

module.exports = {
  id: 'abandoned',
  title: 'Abandoned plugins and themes',
  needsSsh: false,
  prepare,
  run
};
