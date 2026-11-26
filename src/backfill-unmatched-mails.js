/**
 * One-off: builds state/unmatched-mails.json from the wp-mails reports already
 * in reports/ (every mail with category "other"). Safe to re-run: mails are
 * deduplicated, so a second run adds nothing.
 *
 * Usage: node src/backfill-unmatched-mails.js [--dry-run]
 */

const fs = require('node:fs');
const path = require('node:path');
const unmatched = require('./lib/unmatched');

const REPORTS = path.resolve(__dirname, '..', 'reports');

function main() {
  const dryRun = process.argv.includes('--dry-run');
  const files = fs
    .readdirSync(REPORTS)
    .filter(f => /^\d{4}-\d{2}-\d{2}-\d{6}-wp-mails\.json$/.test(f))
    .sort();
  const registry = unmatched.load();
  const before = registry.entries.length;
  let scanned = 0;
  for (const f of files) {
    let data;
    try {
      data = JSON.parse(fs.readFileSync(path.join(REPORTS, f), 'utf8'));
    } catch (err) {
      console.warn(`${f}: ${err.message}`);
      continue;
    }
    const mails = data.mails || [];
    scanned += mails.length;
    const run = f.replace(/-wp-mails\.json$/, '');
    unmatched.record(mails, run, registry, !dryRun);
  }
  const added = registry.entries.length - before;
  console.log(
    `${files.length} report(s), ${scanned} mail(s) scanned, ${added} unmatched mail(s) ${dryRun ? 'would be ' : ''}added (${registry.entries.length} total).`
  );
}

main();
