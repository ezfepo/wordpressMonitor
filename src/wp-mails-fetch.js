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
// Posts that plugins create/update on a schedule, from whatever IP triggered
// WP-Cron (a visitor or bot): the Limit Login Attempts daily digest post.
const SUCURI_ROUTINE_MESSAGE = /\bLlar_digest_day\b/i;
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

// Files Wordfence lists as "recently modified" that are normal on these sites.
const SAFE_MODIFIED =
  /^(llms\.txt|\.htaccess\.bak-.*|wp-content\/(languages\/|cache\/|upgrade\/|uploads\/(wc-logs|sucuri|cache)\/|mu-plugins\/hostinger-))/i;
// Data files plugins keep in uploads (form themes, generated CSS, caches).
const UPLOAD_DATA = /\.(json|css|ser|txt|log|xml|csv|po|mo)$/i;
const CODE_FILE = /\.(php|phtml|phar|js)$/i;
const MEDIA_FILE = /\.(jpe?g|png|gif|webp|avif|svg|ico|mp4|mov|webm|mp3|pdf)$/i;

// How suspicious a modified file is: 'act' (code in uploads, core or root PHP
// files), 'review' (.htaccess, plugins, themes, mu-plugins, non-media uploads)
// or null (expected: logs, translations, caches, backups).
function modifiedLevel(file) {
  if (SAFE_MODIFIED.test(file)) return null;
  if (/^wp-content\/uploads\//i.test(file)) {
    if (CODE_FILE.test(file)) return 'act';
    if (/\/cache\//i.test(file)) return null;
    return MEDIA_FILE.test(file) || UPLOAD_DATA.test(file) ? null : 'review';
  }
  if (/^(wp-admin|wp-includes)\//i.test(file)) return 'act';
  if (/^[^/]+\.php$/i.test(file)) return 'act';
  if (/^\.htaccess$/i.test(file)) return 'review';
  if (/^wp-content\/(plugins|themes|mu-plugins)\//i.test(file)) {
    return 'review';
  }
  return CODE_FILE.test(file) ? 'review' : null;
}

// Weekly "Wordfence activity" digest: blocked attacks, failed logins and
// recently modified files. Mostly noise; the parts worth a look are code files
// changed outside the known-safe paths, WooCommerce fatal-error logs and
// repeated failed logins on a user that exists.
function classifyWordfenceActivity(subject, text) {
  const lines = text.split('\n').map(l => oneLine(l));
  const after = re => {
    const i = lines.findIndex(l => re.test(l));
    return i < 0 ? [] : lines.slice(i + 1);
  };

  const blockedBy = [
    ...text.matchAll(/(?:Bloqueado por|Blocked by) ([^\n]+)/gi)
  ].map(m => oneLine(m[1]));
  const rules = [...new Set(blockedBy)];

  const DATE = /^[A-Z][a-z]+ \d{1,2}, \d{4}/;
  const modified = [];
  let when = '';
  for (const l of after(
    /^(archivos modificados recientemente|recently modified files)/i
  ).slice(0, 400)) {
    if (DATE.test(l)) {
      when = l.replace(/, \d{4}/, '');
    } else if (
      l &&
      /[./]/.test(l) &&
      !/^(esta lista|this list|modificados|archivo|file|modified)\b/i.test(l)
    ) {
      modified.push({ file: l, when });
    }
  }
  const flagged = modified
    .map(m => ({ ...m, level: modifiedLevel(m.file) }))
    .filter(m => m.level);
  const fatalLogs = modified.filter(m =>
    /wc-logs\/fatal-errors-/i.test(m.file)
  );

  const failed = after(
    /^(los 10 principales (inicios de sesi|accesos)|top 10 failed)/i
  );
  let existingAttempts = 0;
  for (let i = 0; i + 2 < failed.length; i++) {
    if (/^\d+$/.test(failed[i + 1]) && /^(s[ií]|yes)$/i.test(failed[i + 2])) {
      existingAttempts += Number(failed[i + 1]);
    }
  }

  const parts = [
    `${blockedBy.length} blocked attack(s)${rules.length ? ` (${rules.join('; ')})` : ''}`,
    `${modified.length} recently modified file(s)${flagged.length ? ` (${flagged.length} sensitive)` : ''}`,
    `${existingAttempts} failed login(s) on existing users`
  ];
  const summary = `Wordfence weekly activity: ${parts.join(', ')}`;

  const why = [];
  const worstAct = flagged.some(m => m.level === 'act');
  if (flagged.length) {
    const list = flagged
      .slice(0, 6)
      .map(m => `${m.file}${m.when ? ` (${m.when})` : ''}`)
      .join(', ');
    why.push(
      `${worstAct ? 'Code files in uploads/core' : 'Sensitive files changed'}: ${list}${flagged.length > 6 ? `, +${flagged.length - 6} more` : ''}. If you, an update, apply-headers.js or the site owner did it, fine; otherwise it may be a compromise (check the file and scan for malware)`
    );
  }
  if (fatalLogs.length) {
    why.push(
      'WooCommerce logged fatal errors (wc-logs/fatal-errors-*.log): check the site and the log for the failing plugin'
    );
  }
  if (existingAttempts >= 10) {
    why.push(
      `${existingAttempts} failed logins on a username that exists: consider 2FA or renaming that user`
    );
  }
  if (why.length) {
    return result(
      'wordfence-activity',
      'security',
      worstAct ? 'act' : 'review',
      summary,
      `${why.join('. ')}.`
    );
  }
  return result(
    'wordfence-activity',
    'security',
    'discard',
    summary,
    'Weekly digest with nothing unusual: blocked attacks are the firewall doing its job, and the modified files are expected (logs, translations, caches, backups).'
  );
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

  if (/^(actividad de wordfence|wordfence activity)/i.test(subject)) {
    return classifyWordfenceActivity(subject, text);
  }

  if (/^(sucuri alert|alerta de sucuri)/i.test(subject)) {
    const event = text.match(/Event:\s*(.+)/i)?.[1]?.trim() || '';
    const ip = text.match(/IP Address:\s*(\S+)/i)?.[1] || '';
    const message = oneLine(text.match(/Message:\s*([\s\S]*)$/i)?.[1] || '');
    const summary = `Sucuri: ${event}${message ? ` — ${message}` : ''}`;
    if (SUCURI_CONTENT.test(event)) {
      if (SUCURI_ROUTINE_MESSAGE.test(message) || LOCAL_IP.test(ip)) {
        return result(
          'sucuri-content',
          'admin-notice',
          'discard',
          summary,
          'Scheduled task or local server process (e.g. the daily Limit Login Attempts digest post), not a remote edit.'
        );
      }
      return result(
        'sucuri-content',
        'admin-notice',
        'review',
        summary,
        `Content changed from ${ip || 'an unknown IP'}, not a known scheduled task. Fine if you or an editor did it; otherwise check the post/page for defacement or injected links.`
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

  if (/trustedsite/i.test(from) && /^your site summary for/i.test(subject)) {
    const visits = text.match(/(\d[\d.,]*)\s+visits?\s+this\s+month/i)?.[1];
    const summary = `TrustedSite summary: ${visits ?? '?'} trustmark visits this month`;
    const problem = text.match(
      /blacklist|malware (detected|found)|certificate (has )?expire|vulnerabilit|site is down/i
    );
    return problem
      ? result(
          'trustedsite-summary',
          'security',
          'review',
          summary,
          `The summary mentions "${problem[0]}": open the TrustedSite dashboard.`
        )
      : result(
          'trustedsite-summary',
          'other',
          'discard',
          summary,
          'Marketing-style traffic recap for the trustmark; nothing to do.'
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
    /acceso de administraci[oó]n|admin(istrator)? (login|access)/i.test(subject)
  ) {
    const user = text.match(
      /usuario con nombre de usuario "([^"]+)"|user with username "([^"]+)"/i
    );
    const username = user?.[1] || user?.[2] || '?';
    const ip = text.match(/IP del usuario:\s*(\S+)|User(?:'s)? IP:\s*(\S+)/i);
    const location = text.match(
      /Ubicaci[oó]n del usuario:\s*(.+)|User(?:'s)? location:\s*(.+)/i
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
    /fatal error|technical (difficulties|issue)|recovery mode|error cr[ií]tico/i.test(
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

if (require.main === module) {
  main().catch(err => {
    console.error(`wp-mails-fetch error: ${err.message}`);
    process.exitCode = 1;
  });
}

module.exports = { classify };
