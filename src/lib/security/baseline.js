'use strict';

/**
 * Baseline store: state/security-baseline.json (gitignored, NOT in reports/
 * or .claude/tmp because those are purged).
 *
 *   { "version": 1, "sites": { "<site>": { "<check>": { "updatedAt", "state" } } } }
 *
 * Written atomically (temp file + rename) and only once per run.
 */

const fs = require('node:fs');
const path = require('node:path');
const { ROOT } = require('../ssh');

// WPM_STATE_DIR only exists so tests can use a throwaway baseline.
const STATE_DIR = process.env.WPM_STATE_DIR || path.join(ROOT, 'state');
const BASELINE_FILE = path.join(STATE_DIR, 'security-baseline.json');

function loadBaseline() {
  try {
    const data = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8'));
    if (data && typeof data === 'object' && data.sites) return data;
  } catch {
    // missing or unreadable: start empty
  }
  return { version: 1, sites: {} };
}

function getState(baseline, site, check) {
  return baseline.sites?.[site]?.[check]?.state ?? null;
}

function setState(baseline, site, check, state) {
  baseline.sites[site] ??= {};
  baseline.sites[site][check] = {
    updatedAt: new Date().toISOString(),
    state
  };
}

function saveBaseline(baseline) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const tmp = `${BASELINE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(baseline, null, 2));
  fs.renameSync(tmp, BASELINE_FILE);
}

module.exports = {
  BASELINE_FILE,
  loadBaseline,
  getState,
  setState,
  saveBaseline
};
