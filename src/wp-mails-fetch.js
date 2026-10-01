/**
 * WordPress notification emails without Claude: Gmail API -> rules ->
 * reports/<ts>-wp-mails.json.
 *
 * Usage: node src/wp-mails-fetch.js [--dry-run]
 *
 * Reads the threads under the wordpress label (config.json ->
 * gmail.labels.wordpress), classifies each one by rules on subject/sender/body
 * (Sucuri, Wordfence, Limit Login Attempts, WordPress core notices) and trashes
 * the threads read successfully (recoverable 30 days). --dry-run trashes
 * nothing, so it can be repeated.
 */

const fs = require('node:fs');
const path = require('node:path');
const gmail = require('./lib/gmail');
const { decodeHeader, parseMessage } = require('./lib/mime');
const { timestampSlug } = require('./lib/format');

const ROOT = path.resolve(__dirname, '..');
const REPORTS = path.join(ROOT, 'reports');

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));
  } catch {
    return null;
  }
}

function loadLabel() {
  return readJson('config.json')?.gmail?.labels?.wordpress || 'wordpress';
}

// [{ name, domain }] from sites.json (domain = folder inside wpPath).
function loadSites() {
  return (readJson('sites.json')?.sites || []).map(s => ({
    name: s.name,
    domain: (s.wpPath || '').match(/domains\/([^/]+)/)?.[1] || null
  }));
}

function findSite(sites, haystack) {
  const text = haystack.toLowerCase();
  const hit = sites.find(
    s =>
      (s.domain && text.includes(s.domain.toLowerCase())) ||
      text.includes(s.name.toLowerCase())
  );
  return hit ? hit.name : null;
}

const ENTITIES = {
  quot: '"',
  gt: '>',
  lt: '<',
  amp: '&',
  nbsp: ' ',
  apos: "'"
};
const decodeEntities = s =>
  s.replace(/&(#\d+|\w+);/g, (m, e) =>
    e[0] === '#' ? String.fromCodePoint(Number(e.slice(1))) : (ENTITIES[e] ?? m)
  );
const oneLine = s => decodeEntities(s).replace(/\s+/g, ' ').trim();
const clip = (s, n = 160) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// Sucuri events that are routine site activity, not a security concern.
const SUCURI_ROUTINE =
  /^(post|page|plugin|theme|media|comment|user profile|widget|menu)\b.*\b(update|updated|created|activated|deactivated|installed|deleted|uploaded|edited|trashed|published)\b|^(post|page) (update|created|deleted)/i;

function classify({ subject, from, text }) {
  const all = `${subject}\n${from}\n${text}`;

  if (/wordfence/i.test(subject) && /problems? found/i.test(subject)) {
    const issues = text
      .split('\n')
      .filter(l => /^\*\s/.test(l.trim()))
      .map(l => oneLine(l.trim().replace(/^\*\s*/, '')));
    // Plugin/theme update notices are handled by the updater run itself.
    const updateOnly =
      issues.length > 0 &&
      issues.every(i => /necesita una actualizaci|needs an update/i.test(i));
    return {
      kind: 'security',
      summary: clip(
        `Wordfence: ${issues.length ? issues.join('; ') : 'problems found'}`,
        320
      ),
      actionNeeded: !updateOnly
    };
  }

  if (/^(sucuri alert|alerta de sucuri)/i.test(subject)) {
    const event = text.match(/Event:\s*(.+)/i)?.[1]?.trim() || '';
    const message = oneLine(text.match(/Message:\s*([\s\S]*)$/i)?.[1] || '');
    const routine = SUCURI_ROUTINE.test(event);
    return {
      kind: routine ? 'admin-notice' : 'security',
      summary: clip(`Sucuri: ${event}${message ? ` — ${message}` : ''}`),
      actionNeeded: !routine
    };
  }

  if (/security summary/i.test(subject)) {
    const num = label =>
      text.match(new RegExp(`${label}:\\s*([\\d.,]+)`, 'i'))?.[1] ?? '?';
    const level = text.match(/Threat Level:\s*(\w+)/i)?.[1] || '?';
    return {
      kind: 'security',
      summary: `Login security summary: ${num('Lockouts')} lockouts, ${num('Failed login attempts')} failed logins, threat level ${level}`,
      actionNeeded: false
    };
  }

  if (
    /fatal error|technical difficulties|recovery mode|error cr[ií]tico/i.test(
      all
    )
  ) {
    return {
      kind: 'fatal-error',
      summary: clip(oneLine(subject)),
      actionNeeded: true
    };
  }

  if (
    /(admin|administrat).{0,40}(e-?mail|correo)|(e-?mail|correo).{0,40}(admin|administrat)/i.test(
      subject
    )
  ) {
    return {
      kind: 'admin-notice',
      summary: clip(oneLine(subject)),
      actionNeeded: true
    };
  }

  if (
    /auto-?update|has been updated|actualiz.{0,20}autom|updated to/i.test(
      subject
    )
  ) {
    return {
      kind: 'auto-update',
      summary: clip(oneLine(subject)),
      actionNeeded: false
    };
  }

  return {
    kind: 'other',
    summary: clip(oneLine(subject)),
    actionNeeded: false
  };
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const label = loadLabel();
  const sites = loadSites();
  const outFile = path.join(
    REPORTS,
    `${timestampSlug(new Date())}-wp-mails.json`
  );
  fs.mkdirSync(REPORTS, { recursive: true });

  const out = { label, mails: [], trashed: [], trashFailed: [] };
  if (dryRun) out.dryRun = true;

  const labelId = await gmail.findLabelId(label);
  if (!labelId) throw new Error(`Gmail label "${label}" not found`);
  const readOk = [];
  for (const threadId of await gmail.listThreadIds(labelId)) {
    try {
      for (const messageId of await gmail.getThreadMessageIds(threadId)) {
        const raw = Buffer.from(
          await gmail.getRawMessage(messageId),
          'base64url'
        );
        const { headers, text } = parseMessage(raw);
        const subject = decodeHeader(headers.subject);
        const from = decodeHeader(headers.from);
        const date = headers.date ? new Date(headers.date) : null;
        out.mails.push({
          threadId,
          date: date && !isNaN(date) ? date.toISOString() : headers.date || '',
          from,
          subject,
          site: findSite(sites, `${from}\n${subject}\n${text}`),
          ...classify({ subject, from, text })
        });
      }
      readOk.push(threadId);
    } catch (err) {
      console.warn(`thread ${threadId}: ${err.message}`);
    }
  }
  out.mails.sort((a, b) => b.date.localeCompare(a.date));

  if (!dryRun) {
    for (const id of readOk) {
      try {
        await gmail.trashThread(id);
        out.trashed.push(id);
      } catch (err) {
        console.warn(`trash ${id}: ${err.message}`);
        out.trashFailed.push(id);
      }
    }
  }

  fs.writeFileSync(outFile, JSON.stringify(out, null, 2));
  const action = out.mails.filter(m => m.actionNeeded).length;
  console.log(
    `${out.mails.length} WordPress email(s), ${action} needing action, ${out.trashed.length} trashed${dryRun ? ' (dry run)' : ''}.`
  );
  if (out.trashFailed.length) process.exitCode = 1;
}

main().catch(err => {
  console.error(`wp-mails-fetch error: ${err.message}`);
  process.exitCode = 1;
});
