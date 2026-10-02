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
const { readConfig } = require('./lib/config');

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
  return readConfig().gmail?.labels?.wordpress || 'wordpress';
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

// Sucuri events about site content (routine) vs. code/user changes (worth a look).
const SUCURI_CONTENT = /^(post|page|media|comment|widget|menu)\b/i;
const SUCURI_CODE = /^(plugin|theme)\b/i;
const LOCAL_IP = /^(127\.0\.0\.1|::1)$/;

// Every mail gets a category (its group in the report), a verdict
// (discard | review | act) and one line of advice saying why. The criteria per
// category are described in CATEGORY_GUIDE in build-report.js.
function result(category, kind, verdict, summary, advice) {
  return {
    category,
    kind,
    verdict,
    summary: clip(summary, 320),
    advice,
    actionNeeded: verdict === 'act'
  };
}

function classify({ subject, from, text }) {
  const all = `${subject}\n${from}\n${text}`;

  if (/wordfence/i.test(subject) && /problems? found/i.test(subject)) {
    const issues = text
      .split('\n')
      .filter(l => /^\*\s/.test(l.trim()))
      .map(l => oneLine(l.trim().replace(/^\*\s*/, '')));
    const summary = `Wordfence: ${issues.length ? issues.join('; ') : 'problems found'}`;
    const updateOnly =
      issues.length > 0 &&
      issues.every(i => /necesita una actualizaci|needs an update/i.test(i));
    return updateOnly
      ? result(
          'wordfence-updates',
          'security',
          'discard',
          summary,
          'Only pending plugin/theme updates: the updater applies them. Review only if the same item is still listed after a run.'
        )
      : result(
          'wordfence-issues',
          'security',
          'act',
          summary,
          'Wordfence found something beyond updates (malware, modified files, vulnerable or abandoned plugin). Open its scan results.'
        );
  }

  if (/^(sucuri alert|alerta de sucuri)/i.test(subject)) {
    const event = text.match(/Event:\s*(.+)/i)?.[1]?.trim() || '';
    const ip = text.match(/IP Address:\s*(\S+)/i)?.[1] || '';
    const message = oneLine(text.match(/Message:\s*([\s\S]*)$/i)?.[1] || '');
    const summary = `Sucuri: ${event}${message ? ` — ${message}` : ''}`;
    if (SUCURI_CONTENT.test(event)) {
      return result(
        'sucuri-content',
        'admin-notice',
        'discard',
        summary,
        'Routine content change (often a scheduled task). Review only if nobody edited content and the IP is unfamiliar.'
      );
    }
    if (SUCURI_CODE.test(event)) {
      const removal = /deactivat|delet|install/i.test(event);
      if (LOCAL_IP.test(ip)) {
        return result(
          'sucuri-code',
          'admin-notice',
          'review',
          summary,
          'Done by a local server process (127.0.0.1: WP-CLI, cron or Hostinger tooling), not a remote login. Fine if it was you or an expected tool.'
        );
      }
      return result(
        'sucuri-code',
        'security',
        removal ? 'act' : 'review',
        summary,
        `Done from ${ip || 'an unknown IP'}. Confirm it was you; if not, change admin passwords and check the user list.`
      );
    }
    return result(
      'sucuri-security',
      'security',
      'act',
      summary,
      'Sucuri flagged a security event (login, file or setting change). Check the IP and the site.'
    );
  }

  if (/security summary/i.test(subject)) {
    const num = label =>
      Number(
        (
          text.match(new RegExp(`${label}:\\s*([\\d.,]+)`, 'i'))?.[1] ?? ''
        ).replace(/[.,]/g, '')
      );
    const lockouts = num('Lockouts');
    const failed = num('Failed login attempts');
    const level = text.match(/Threat Level:\s*(\w+)/i)?.[1] || '?';
    const summary = `Login security summary: ${lockouts} lockouts, ${failed} failed logins, threat level ${level}`;
    if (failed >= 200 && lockouts === 0) {
      return result(
        'login-summary',
        'security',
        'review',
        summary,
        `${failed} failed logins but no lockouts: likely a distributed brute-force the plugin cannot block. Consider 2FA, a login rate limit or blocking xmlrpc.`
      );
    }
    if (/high/i.test(level) && lockouts > 0) {
      return result(
        'login-summary',
        'security',
        'review',
        summary,
        'High threat level with lockouts: check the most-blocked IPs in the full summary.'
      );
    }
    return result(
      'login-summary',
      'security',
      'discard',
      summary,
      'Normal background noise; the plugin is blocking what it should.'
    );
  }

  if (
    /wordfence/i.test(subject) &&
    /acceso de administraci[oó]n|administrator (login|access)/i.test(subject)
  ) {
    const user = text.match(
      /usuario con nombre de usuario "([^"]+)"|user with username "([^"]+)"/i
    );
    const username = user?.[1] || user?.[2] || '?';
    const ip = text.match(/IP del usuario:\s*(\S+)|User'?s IP:\s*(\S+)/i);
    const location = text.match(
      /Ubicaci[oó]n del usuario:\s*(.+)|User'?s location:\s*(.+)/i
    );
    const summary = `Wordfence: admin login by "${username}" from ${(ip?.[1] || ip?.[2] || 'an unknown IP').trim()}${location ? ` (${oneLine(location[1] || location[2])})` : ''}`;
    return result(
      'wordfence-admin-login',
      'security',
      'review',
      summary,
      'An admin-level user logged in. Confirm it was you or an expected admin; if not, change passwords and check the user list.'
    );
  }

  if (
    /fatal error|technical difficulties|recovery mode|error cr[ií]tico/i.test(
      all
    )
  ) {
    return result(
      'fatal-error',
      'fatal-error',
      'act',
      oneLine(subject),
      'The site hit a PHP fatal error or entered recovery mode. Open the recovery link in the mail and check the culprit plugin/theme.'
    );
  }

  if (
    /(admin|administrat).{0,40}(e-?mail|correo)|(e-?mail|correo).{0,40}(admin|administrat)/i.test(
      subject
    )
  ) {
    return result(
      'admin-notice',
      'admin-notice',
      'act',
      oneLine(subject),
      'Admin email change or confirmation. If you did not request it, someone else has admin access.'
    );
  }

  if (
    /auto-?update|has been updated|actualiz.{0,20}autom|updated to/i.test(
      subject
    )
  ) {
    return result(
      'auto-update',
      'auto-update',
      'discard',
      oneLine(subject),
      'WordPress updated itself successfully; nothing to do.'
    );
  }

  return result(
    'other',
    'other',
    'review',
    oneLine(subject),
    'Unrecognized email format: read it once and, if it recurs, add a rule for it.'
  );
}

// Same code change on several sites within minutes: say so in the advice.
function noteBulkChanges(mails) {
  const groups = new Map();
  for (const m of mails.filter(m => m.category === 'sucuri-code')) {
    const key = m.summary.replace(/^Sucuri: [^—]*— /, '');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m);
  }
  for (const group of groups.values()) {
    const sites = new Set(group.map(m => m.site));
    const times = group.map(m => new Date(m.date).getTime());
    if (sites.size > 1 && Math.max(...times) - Math.min(...times) < 15 * 60e3) {
      for (const m of group) {
        m.advice += ` Same change on ${sites.size} sites within minutes (${[...sites].join(', ')}): a bulk action, almost surely deliberate.`;
      }
    }
  }
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
  noteBulkChanges(out.mails);

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
