'use strict';

/**
 * wordpressMonitor — post-incident security checks (read-only on the servers).
 *
 * Usage:
 *   node src/security-check.js [--dry-run] [--site <name>] [--only id[,id]]
 *   node src/security-check.js --accept [--site <name>] [--only id[,id]]
 *
 * Checks (ids): admins, options, integrity, uploads-cron, sucuri-audit,
 * db-scan, public-site, exposed-files, backups, tls, abandoned.
 *
 * Baselines live in state/security-baseline.json. The first run for a
 * site+check learns silently ("baseline created"); --accept stores the current
 * state after you reviewed legitimate changes; --dry-run compares but never
 * writes the baseline. Writes reports/<ts>-security.json; exit code 1 when any
 * finding is an alert.
 */

const fs = require('node:fs');
const path = require('node:path');
const { timestampSlug } = require('./lib/format');
const { runWithConcurrency } = require('./lib/concurrency');
const {
  ROOT,
  loadSites,
  credentialsForSite,
  sshConnect
} = require('./lib/ssh');
const { CHECKS, CHECK_IDS } = require('./lib/security');
const { securityConfig } = require('./lib/security/config');
const baselineStore = require('./lib/security/baseline');

const REPORTS_DIR = path.join(ROOT, 'reports');
// All sites share one Hostinger server/user. The remote checks of one site run
// one after another over one SSH connection; if SSH errors show up, lower this.
const SITE_CONCURRENCY = 5;
const RANK = { ok: 0, info: 1, warn: 2, alert: 3 };

function parseArgs(argv) {
  const args = { dryRun: false, accept: false, site: null, only: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--accept') args.accept = true;
    else if (arg === '--site') args.site = argv[++i];
    else if (arg === '--only')
      args.only = (argv[++i] || '').split(',').filter(Boolean);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (args.site === undefined || args.site === '') {
    throw new Error('--site requires a value');
  }
  if (args.only) {
    const bad = args.only.filter(id => !CHECK_IDS.includes(id));
    if (args.only.length === 0 || bad.length > 0) {
      throw new Error(
        `Unknown check id(s): ${bad.join(', ') || '(none)'}. Valid: ${CHECK_IDS.join(', ')}`
      );
    }
  }
  if (args.accept && args.dryRun) {
    throw new Error('--accept and --dry-run cannot be combined');
  }
  return args;
}

// Rows for one site: [{ site, check, severity, details }], plus the baseline
// updates this site wants to store: [{ check, state }].
async function processSite(site, checks, shared, baseline, options, log) {
  const rows = [];
  const updates = [];
  const config = securityConfig(site);
  const add = (check, severity, details) =>
    rows.push({ site: site.name, check, severity, details });

  let conn = null;
  const needsSsh = checks.some(c => c.needsSsh);
  if (needsSsh) {
    try {
      log(site, 'connecting');
      conn = await sshConnect(site, credentialsForSite(site));
    } catch (err) {
      for (const c of checks.filter(x => x.needsSsh)) {
        add(c.id, 'alert', `check not run: ${err.message}`);
      }
    }
  }

  try {
    for (const check of checks) {
      if (check.needsSsh && !conn) continue;
      log(site, check.id);
      const previous = baselineStore.getState(baseline, site.name, check.id);
      const ctx = {
        site,
        conn,
        config,
        baseline: previous,
        shared: shared[check.id] || {}
      };
      let result;
      try {
        result = await check.run(ctx);
      } catch (err) {
        add(check.id, 'alert', `check failed: ${err.message}`);
        continue;
      }
      const findings = result.findings || [];
      for (const f of findings) add(check.id, f.severity, f.message);
      if (!findings.some(f => RANK[f.severity] >= RANK.warn)) {
        add(check.id, 'ok', 'no issues');
      }
      if (result.snapshot == null) continue;
      if (options.accept) {
        updates.push({ check: check.id, state: result.snapshot });
        add(check.id, 'info', 'baseline accepted');
      } else if (previous == null) {
        if (options.dryRun) {
          add(check.id, 'info', 'no baseline yet (dry run, not saved)');
        } else {
          updates.push({ check: check.id, state: result.snapshot });
          add(check.id, 'info', 'baseline created');
        }
      } else if (!options.dryRun && result.advance) {
        updates.push({ check: check.id, state: result.advance });
      }
    }
  } finally {
    conn?.end();
  }
  return { rows, updates };
}

function printSummary(rows) {
  const sites = [...new Set(rows.map(r => r.site))];
  console.log('');
  console.log('Summary:');
  for (const site of sites) {
    const mine = rows.filter(r => r.site === site);
    const worst = mine.reduce(
      (w, r) => (RANK[r.severity] > RANK[w] ? r.severity : w),
      'ok'
    );
    const count = s => mine.filter(r => r.severity === s).length;
    console.log(
      `  ${site}: ${worst} (${count('alert')} alert, ${count('warn')} warn, ${count('info')} info)`
    );
    for (const r of mine.filter(x => RANK[x.severity] >= RANK.warn)) {
      console.log(`    [${r.severity}] ${r.check}: ${r.details}`);
    }
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
  const checks = options.only
    ? CHECKS.filter(c => options.only.includes(c.id))
    : CHECKS;
  const timestamp = new Date();
  console.log(
    `wordpressMonitor: security checks (${checks.map(c => c.id).join(', ')}) on ${sites.length} site(s)${options.dryRun ? ' [dry run]' : ''}${options.accept ? ' [accept baseline]' : ''}...`
  );

  // Data fetched once per run (Hostinger domain list, WordPress.org lookups).
  const shared = {};
  for (const check of checks.filter(c => c.prepare)) {
    shared[check.id] = {};
    try {
      await check.prepare(sites, shared[check.id]);
    } catch (err) {
      console.log(`  [${check.id}] prepare failed: ${err.message}`);
    }
  }

  const baseline = baselineStore.loadBaseline();
  const results = await runWithConcurrency(
    sites,
    SITE_CONCURRENCY,
    async site => {
      const out = await processSite(
        site,
        checks,
        shared,
        baseline,
        options,
        (s, step) => console.log(`    [${s.name}] ${step}...`)
      );
      console.log(`  [${site.name}] done`);
      return out;
    }
  );

  const rows = results.flatMap(r => r.rows);
  const updates = results.flatMap((r, i) =>
    r.updates.map(u => ({ site: sites[i].name, ...u }))
  );
  if (updates.length > 0) {
    for (const u of updates) {
      baselineStore.setState(baseline, u.site, u.check, u.state);
    }
    baselineStore.saveBaseline(baseline);
    console.log(
      `Baseline updated: ${updates.length} entr(ies) in ${path.relative(ROOT, baselineStore.BASELINE_FILE)}`
    );
  }

  // --accept stores state; it is not a run to report on.
  if (!options.accept) {
    fs.mkdirSync(REPORTS_DIR, { recursive: true });
    const jsonPath = path.join(
      REPORTS_DIR,
      `${timestampSlug(timestamp)}-security.json`
    );
    fs.writeFileSync(
      jsonPath,
      JSON.stringify(
        {
          timestamp: timestamp.toISOString(),
          dryRun: options.dryRun,
          checks: checks.map(c => c.id),
          results: rows
        },
        null,
        2
      )
    );
    console.log(`Detail: ${jsonPath}`);
  }
  printSummary(rows);
  if (options.accept) {
    console.log('');
    console.log(
      'Accepted: any alert/warn above is a difference from the previous baseline that is now the new normal.'
    );
    process.exitCode = 0;
    return;
  }
  process.exitCode = rows.some(r => r.severity === 'alert') ? 1 : 0;
}

main().catch(err => {
  console.error(`security-check error: ${err.message}`);
  process.exitCode = 1;
});
