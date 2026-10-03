/**
 * Writes each site's security headers into its .htaccess, between
 * "# BEGIN/END wordpressMonitor security headers" markers (other content is
 * left alone), then checks the live site.
 *
 * Usage: node src/apply-headers.js [--site <name>] [--dry-run]
 *
 * The policy is built from sites.json (see sites.json.example):
 *   cspFrameSrc        extra origins allowed in frame-src (embeds, reCAPTCHA, ...)
 *   cspScriptSrcExtra  extra script-src tokens (e.g. "'unsafe-eval'" for a
 *                      plugin that cannot run without it - treat as temporary)
 *
 * Content-Security-Policy is NOT sent for /wp-admin/ and /wp-login.php: the
 * block editor needs blob: frames/workers, 'unsafe-eval' and Jetpack /
 * WordPress.com frames, so a policy strict enough to matter breaks it. The
 * other headers (HSTS, nosniff, ...) are sent everywhere.
 *
 * Safety: the old .htaccess is copied to .htaccess.bak-<timestamp> first and
 * put back automatically if the homepage errors or loses its CSP afterwards.
 * --dry-run changes nothing: it prints the policy and whether it matches the
 * one the site sends today.
 */

const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('ssh2');
const hostinger = require('./lib/hostinger');

const ROOT = path.resolve(__dirname, '..');
const BEGIN = '# BEGIN wordpressMonitor security headers';
const END = '# END wordpressMonitor security headers';
const ADMIN_PATHS = '^/(wp-admin/|wp-login\\.php)';

function buildPolicy(site) {
  const script = [
    "'self'",
    "'unsafe-inline'",
    ...(site.cspScriptSrcExtra || []),
    'https:'
  ];
  const directives = [
    "default-src 'self'",
    `script-src ${script.join(' ')}`,
    "style-src 'self' 'unsafe-inline' https:",
    "img-src 'self' data: https:",
    "font-src 'self' data: https:",
    "connect-src 'self' https:",
    "form-action 'self'",
    "worker-src 'self' blob:",
    'upgrade-insecure-requests',
    "frame-ancestors 'self'",
    "object-src 'none'",
    "base-uri 'self'"
  ];
  if ((site.cspFrameSrc || []).length > 0) {
    directives.push(`frame-src 'self' ${site.cspFrameSrc.join(' ')}`);
  }
  return directives.join('; ');
}

function buildBlock(site) {
  return [
    BEGIN,
    '<IfModule mod_headers.c>',
    '  Header always set Strict-Transport-Security "max-age=31536000"',
    '  Header always set X-Content-Type-Options "nosniff"',
    '  Header always set X-Frame-Options "SAMEORIGIN"',
    '  Header always set Referrer-Policy "strict-origin-when-cross-origin"',
    '  Header always set Permissions-Policy "camera=(), microphone=(), geolocation=()"',
    `  Header always set Content-Security-Policy "${buildPolicy(site)}"`,
    // Hostinger's LiteSpeed ignores SetEnvIf/RewriteRule env=!VAR conditions
    // (tested), but honors <If> + unset.
    `  <If "%{REQUEST_URI} =~ m#${ADMIN_PATHS}#">`,
    '    Header always unset Content-Security-Policy',
    '  </If>',
    '</IfModule>',
    END,
    ''
  ].join('\n');
}

function parseArgs(argv) {
  const args = { site: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') args.dryRun = true;
    else if (argv[i] === '--site') args.site = argv[++i];
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return args;
}

const q = v => `'${String(v).replace(/'/g, `'\\''`)}'`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function connect(site) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    conn
      .on('ready', () => resolve(conn))
      .on('error', reject)
      .connect({
        host: site.sshHost,
        port: site.sshPort || 22,
        username: site.sshUser,
        readyTimeout: 20000,
        ...(site.sshKeyPath
          ? {
              privateKey: fs.readFileSync(site.sshKeyPath, 'utf8'),
              passphrase: site.sshKeyPassphrase
            }
          : { password: site.sshPassword })
      });
  });
}

function exec(conn, cmd) {
  return new Promise((resolve, reject) => {
    conn.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      let out = '';
      stream
        .on('close', code => resolve({ code, out }))
        .on('data', d => (out += d))
        .stderr.on('data', d => (out += d));
    });
  });
}

async function probe(url) {
  const res = await fetch(`${url}?wpm=${Date.now()}`, { redirect: 'follow' });
  await res.text();
  return {
    status: res.status,
    csp: res.headers.get('content-security-policy'),
    hsts: res.headers.get('strict-transport-security')
  };
}

async function dryRun(site, domain) {
  const policy = buildPolicy(site);
  const live = await probe(`https://${domain}/`);
  console.log(`  policy: ${policy}`);
  console.log(
    `  matches what the homepage sends today: ${live.csp === policy ? 'yes' : 'NO'}`
  );
  return { site: site.name, ok: true };
}

async function apply(site, domain) {
  const file = `${site.wpPath}/.htaccess`;
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
  const conn = await connect(site);
  try {
    const cur = await exec(conn, `cat ${q(file)}`);
    if (cur.code !== 0)
      throw new Error(`cannot read .htaccess: ${cur.out.trim()}`);
    const block = buildBlock(site);
    let updated;
    if (cur.out.includes(BEGIN)) {
      updated = cur.out.replace(
        new RegExp(`${BEGIN}[\\s\\S]*?${END}\\n?`),
        block
      );
    } else if (cur.out.includes('# BEGIN WordPress')) {
      updated = cur.out.replace(
        '# BEGIN WordPress',
        `${block}\n# BEGIN WordPress`
      );
    } else {
      updated = `${block}\n${cur.out}`;
    }

    const backup = `${file}.bak-${stamp}`;
    const bk = await exec(conn, `cp -p ${q(file)} ${q(backup)}`);
    if (bk.code !== 0) throw new Error(`backup failed: ${bk.out.trim()}`);
    console.log(`  backup: ${backup}`);

    const b64 = Buffer.from(updated).toString('base64');
    const w = await exec(conn, `printf %s ${q(b64)} | base64 -d > ${q(file)}`);
    if (w.code !== 0) throw new Error(`write failed: ${w.out.trim()}`);

    if (hostinger.isConfigured()) {
      try {
        await hostinger.clearCache(site.sshUser, domain);
      } catch (err) {
        console.log(`  cache clear failed (continuing): ${err.message}`);
      }
    }
    await sleep(3000);

    const home = await probe(`https://${domain}/`);
    const login = await probe(`https://${domain}/wp-login.php`);
    // A file under /wp-admin/ (the folder itself redirects to the login).
    const adminAsset = await probe(
      `https://${domain}/wp-admin/css/login.min.css`
    );
    console.log(
      `  homepage: HTTP ${home.status}, CSP ${home.csp ? 'sent' : 'MISSING'}, HSTS ${home.hsts ? 'sent' : 'MISSING'}`
    );
    console.log(
      `  wp-login.php: HTTP ${login.status}, CSP ${login.csp ? 'STILL SENT' : 'not sent (as intended)'}, HSTS ${login.hsts ? 'sent' : 'MISSING'}`
    );
    console.log(
      `  /wp-admin/ file: HTTP ${adminAsset.status}, CSP ${adminAsset.csp ? 'STILL SENT' : 'not sent (as intended)'}`
    );

    if (home.status >= 400 || !home.csp) {
      await exec(conn, `cp -p ${q(backup)} ${q(file)}`);
      console.log(
        '  homepage broke or lost its CSP: previous .htaccess restored'
      );
      return { site: site.name, ok: false, reason: 'restored' };
    }
    if (login.csp || adminAsset.csp) {
      console.log('  the admin exclusion is not being honored by this server');
      return { site: site.name, ok: false, reason: 'admin still gets CSP' };
    }
    return { site: site.name, ok: true };
  } finally {
    conn.end();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const all = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'sites.json'), 'utf8')
  ).sites;
  const sites = args.site ? all.filter(s => s.name === args.site) : all;
  if (sites.length === 0)
    throw new Error(`No site named "${args.site}" in sites.json`);

  const results = [];
  for (const site of sites) {
    const domain = (site.wpPath || '').match(/domains\/([^/]+)/)?.[1];
    console.log(`\n=== ${site.name} (${domain})`);
    try {
      results.push(
        await (args.dryRun ? dryRun(site, domain) : apply(site, domain))
      );
    } catch (err) {
      console.log(`  ERROR: ${err.message}`);
      results.push({ site: site.name, ok: false, reason: err.message });
    }
  }
  console.log('\nSummary:');
  for (const r of results) {
    console.log(`  ${r.site}: ${r.ok ? 'OK' : `NOT OK (${r.reason})`}`);
  }
  process.exitCode = results.every(r => r.ok) ? 0 : 1;
}

main().catch(err => {
  console.error(`apply-headers error: ${err.message}`);
  process.exitCode = 1;
});
