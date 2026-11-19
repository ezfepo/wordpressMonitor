'use strict';

const { siteUrl } = require('../ssh');
const { finding, hostOf, bare } = require('./common');

const TIMEOUT_MS = 15000;
const UA = 'Mozilla/5.0 (compatible; wordpressMonitor security check)';

// GET without following redirects; reads at most ~4 KB of the body.
async function probe(url, init = {}) {
  const res = await fetch(url, {
    redirect: 'manual',
    headers: { 'user-agent': UA, range: 'bytes=0-4095', ...init.headers },
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  let body = Buffer.alloc(0);
  if (res.body) {
    const reader = res.body.getReader();
    const chunks = [];
    let size = 0;
    while (size < 4096) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
      size += value.length;
    }
    await reader.cancel().catch(() => {});
    body = Buffer.concat(chunks).subarray(0, 4096);
  }
  return {
    status: res.status,
    type: (res.headers.get('content-type') || '').toLowerCase(),
    location: res.headers.get('location') || '',
    body
  };
}

const text = r => r.body.toString('utf8');
const isHtml = r => r.type.includes('text/html');
const ok200 = r => r.status === 200 || r.status === 206;

// Each probe validates content, not just the status: a soft-404 answers 200
// with an HTML error page.
function probes(domain) {
  const logLike =
    /\[\d{2}-\w{3}-\d{4} [\d:]+ [^\]]*\] PHP |PHP (Warning|Notice|Fatal error|Deprecated)/;
  const zip = r =>
    ok200(r) && !isHtml(r) && r.body.subarray(0, 2).toString() === 'PK';
  const gzip = r =>
    ok200(r) && !isHtml(r) && r.body[0] === 0x1f && r.body[1] === 0x8b;
  const sql = r =>
    ok200(r) &&
    !isHtml(r) &&
    /CREATE TABLE|INSERT INTO|-- MySQL dump|-- MariaDB dump/i.test(text(r));
  const config = r =>
    ok200(r) && !isHtml(r) && /DB_PASSWORD|DB_NAME|<\?php/.test(text(r));
  const list = [
    [
      '/wp-content/debug.log',
      'warn',
      r => ok200(r) && !isHtml(r) && logLike.test(text(r))
    ],
    [
      '/wp-admin/error_log',
      'warn',
      r => ok200(r) && !isHtml(r) && logLike.test(text(r))
    ],
    [
      '/error_log',
      'warn',
      r => ok200(r) && !isHtml(r) && logLike.test(text(r))
    ],
    [
      '/.git/HEAD',
      'alert',
      r => ok200(r) && !isHtml(r) && /^ref: refs\//.test(text(r))
    ],
    [
      '/.env',
      'alert',
      r => ok200(r) && !isHtml(r) && /^[A-Z][A-Z0-9_]*=/m.test(text(r))
    ],
    ['/wp-config.php.bak', 'alert', config],
    ['/wp-config.php~', 'alert', config],
    ['/wp-config.php.old', 'alert', config],
    ['/wp-config.php.save', 'alert', config],
    ['/backup.sql', 'alert', sql],
    ['/database.sql', 'alert', sql],
    ['/db.sql', 'alert', sql],
    ['/dump.sql', 'alert', sql],
    [`/${domain}.sql`, 'alert', sql],
    ['/backup.zip', 'alert', zip],
    ['/site.zip', 'alert', zip],
    ['/www.zip', 'alert', zip],
    ['/wordpress.zip', 'alert', zip],
    ['/public_html.zip', 'alert', zip],
    [`/${domain}.zip`, 'alert', zip],
    ['/backup.tar.gz', 'alert', gzip],
    ['/backup.gz', 'alert', gzip]
  ];
  return list;
}

async function run(ctx) {
  const url = siteUrl(ctx.site)?.replace(/\/$/, '');
  if (!url) throw new Error('no siteUrl or domain folder to derive it from');
  const domain = bare(hostOf(url));
  const findings = [];

  const exposed = { alert: [], warn: [] };
  for (const [path, severity, isExposed] of probes(domain)) {
    try {
      if (isExposed(await probe(`${url}${path}`))) exposed[severity].push(path);
    } catch {
      // unreachable path: nothing exposed
    }
  }
  for (const severity of ['alert', 'warn']) {
    if (exposed[severity].length > 0) {
      findings.push(
        finding(severity, `publicly readable: ${exposed[severity].join(', ')}`)
      );
    }
  }

  // xmlrpc.php: a GET answers 405 / "accepts POST requests only" when enabled.
  try {
    const x = await probe(`${url}/xmlrpc.php`);
    const open =
      x.status === 405 ||
      /XML-RPC server accepts POST requests only/i.test(text(x));
    if (open) {
      findings.push(
        finding(
          ctx.config.expectXmlrpc ? 'info' : 'warn',
          ctx.config.expectXmlrpc
            ? 'xmlrpc.php is open (expected)'
            : 'xmlrpc.php is open (set expectXmlrpc: true in sites.json if needed)'
        )
      );
    }
  } catch {
    // ignore
  }

  // User enumeration: REST users list and /?author=1 redirect.
  const enumerated = [];
  try {
    const r = await probe(`${url}/wp-json/wp/v2/users`);
    if (ok200(r) && /^\s*\[\s*\{[\s\S]*"slug"/.test(text(r))) {
      enumerated.push('/wp-json/wp/v2/users');
    }
  } catch {
    // ignore
  }
  try {
    const r = await probe(`${url}/?author=1`);
    if (r.status >= 300 && r.status < 400 && /\/author\//i.test(r.location)) {
      enumerated.push('/?author=1');
    }
  } catch {
    // ignore
  }
  if (enumerated.length > 0) {
    findings.push(
      finding(
        ctx.config.expectUserEnumeration ? 'info' : 'warn',
        ctx.config.expectUserEnumeration
          ? `user enumeration possible via ${enumerated.join(', ')} (expected)`
          : `user enumeration possible via ${enumerated.join(', ')} (set expectUserEnumeration: true in sites.json if needed)`
      )
    );
  }
  return { findings, snapshot: null };
}

module.exports = {
  id: 'exposed-files',
  title: 'Exposed files',
  needsSsh: false,
  run
};
