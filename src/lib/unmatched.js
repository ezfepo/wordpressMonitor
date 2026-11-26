/**
 * Local registry of WordPress emails that no rule in src/wp-mails-fetch.js
 * matched (category "other"). Gmail threads are trashed after being read, so
 * without this the only trace of such a mail is one report; the registry
 * accumulates them across runs so the daily report can show which unmatched
 * senders/subjects recur and are worth a new rule.
 *
 * File: state/unmatched-mails.json (gitignored, never purged; WPM_STATE_DIR
 * overrides the folder, tests only).
 * Shape: { version, entries: [{ id, run, date, from, subject, site, pattern }] }
 * `run` is the timestamp slug of the <ts>-wp-mails.json that first saw the
 * mail; `id` makes recording idempotent (a dry run and the real run that
 * follows see the same mail, and re-running the backfill adds nothing).
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..', '..');
const STATE_DIR = process.env.WPM_STATE_DIR || path.join(ROOT, 'state');
const FILE = path.join(STATE_DIR, 'unmatched-mails.json');

function load() {
  try {
    const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (Array.isArray(data.entries)) return data;
  } catch {
    // missing or unreadable: start empty
  }
  return { version: 1, entries: [] };
}

function save(registry) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(registry, null, 2));
  fs.renameSync(tmp, FILE);
}

function entryId(mail) {
  return crypto
    .createHash('sha1')
    .update(`${mail.threadId}|${mail.date}|${mail.subject}`)
    .digest('hex')
    .slice(0, 16);
}

// Groups look-alike mails: same sender address, subject with IPs, domains and
// numbers masked ("x.com - login blocked from 1.2.3.4" == "y.com - ... 5.6.7.8").
function patternOf(mail) {
  const sender = (mail.from || '').match(/<([^>]+)>/)?.[1] || mail.from || '';
  const subject = (mail.subject || '')
    .replace(/\b\d{1,3}(\.\d{1,3}){3}\b/g, '<ip>')
    .replace(/\b[0-9a-f]{1,4}(:[0-9a-f]{0,4}){2,7}\b/gi, '<ip>')
    .replace(/\b[\w-]+(\.[\w-]+)*\.[a-z]{2,}\b/gi, '<domain>')
    .replace(/\d+/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim();
  return `${sender.toLowerCase()} | ${subject}`;
}

function isUnmatched(mail) {
  return (mail.category || mail.kind) === 'other';
}

// Adds the unmatched mails of one run; returns how many were new.
function record(mails, run, registry = load(), persist = true) {
  const known = new Set(registry.entries.map(e => e.id));
  let added = 0;
  for (const m of mails.filter(isUnmatched)) {
    const id = entryId(m);
    if (known.has(id)) continue;
    known.add(id);
    registry.entries.push({
      id,
      run,
      date: m.date,
      from: m.from,
      subject: m.subject,
      site: m.site || null,
      pattern: patternOf(m)
    });
    added++;
  }
  if (added && persist) save(registry);
  return added;
}

// One row per pattern, most frequent first.
function summarize(registry = load()) {
  const groups = new Map();
  for (const e of registry.entries) {
    if (!groups.has(e.pattern)) groups.set(e.pattern, []);
    groups.get(e.pattern).push(e);
  }
  return [...groups.entries()]
    .map(([pattern, items]) => {
      const dates = items.map(i => i.date).sort();
      return {
        pattern,
        count: items.length,
        sites: [...new Set(items.map(i => i.site || '-'))].sort(),
        firstSeen: dates[0],
        lastSeen: dates[dates.length - 1],
        from: items[0].from,
        sample: items[items.length - 1].subject,
        runs: new Set(items.map(i => i.run)).size,
        items
      };
    })
    .sort((a, b) => b.count - a.count || b.lastSeen.localeCompare(a.lastSeen));
}

module.exports = {
  FILE,
  load,
  save,
  record,
  summarize,
  entryId,
  patternOf,
  isUnmatched
};
