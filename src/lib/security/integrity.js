'use strict';

const { execCommand, wpCommand } = require('../ssh');
const { finding, sh, list, setDiff } = require('./common');

const DROP_INS = [
  'advanced-cache.php',
  'object-cache.php',
  'db.php',
  'db-error.php',
  'install.php',
  'maintenance.php',
  'php-error.php',
  'fatal-error-handler.php',
  'sunrise.php',
  'blog-deleted.php',
  'blog-inactive.php',
  'blog-suspended.php'
];

// Config files that must not carry code-execution directives. The Wordfence
// firewall legitimately sets auto_prepend_file to wordfence-waf.php.
const CONFIG_FILES =
  '.htaccess .user.ini php.ini wp-config.php wp-content/.htaccess wp-content/uploads/.htaccess';
const SUSPICIOUS =
  'auto_prepend_file|auto_append_file|eval\\(|base64_decode|gzinflate|str_rot13';

const BENIGN_CORE = file =>
  file === 'wp-config-sample.php' || /(^|\/)error_log$/.test(file);

async function wpRaw(ctx, args, seconds) {
  const res = await execCommand(
    ctx.conn,
    `timeout ${seconds} ${wpCommand(ctx.site, args)}`,
    {
      timeoutMs: (seconds + 15) * 1000
    }
  );
  return { ...res, all: `${res.stdout}\n${res.stderr}` };
}

async function coreChecksums(ctx, findings) {
  const res = await wpRaw(ctx, 'core verify-checksums', 120);
  if (res.code === 0) {
    findings.push(finding('ok', 'core checksums verified'));
    return;
  }
  const bad = [];
  const benign = [];
  for (const line of res.all.split(/\r?\n/)) {
    const m = line.match(
      /^(?:Warning|Error): File (doesn't exist|doesn't verify against checksum|should not exist): (.+)$/
    );
    if (m) {
      (BENIGN_CORE(m[2].trim()) ? benign : bad).push(
        `${m[2].trim()} (${m[1].replace("doesn't ", 'not ')})`
      );
      continue;
    }
    if (
      /^Error:/.test(line) &&
      !/doesn't verify against checksums/.test(line)
    ) {
      bad.push(line.slice(0, 160));
    }
  }
  if (bad.length > 0) {
    findings.push(finding('alert', `core checksums differ: ${list(bad)}`));
  } else if (benign.length > 0) {
    findings.push(
      finding(
        'info',
        `core checksums: only benign differences: ${list(benign)}`
      )
    );
  } else {
    findings.push(
      finding(
        'warn',
        `core verify-checksums exited ${res.code}: ${res.all.trim().slice(0, 200)}`
      )
    );
  }
}

async function pluginChecksums(ctx, findings) {
  const res = await wpRaw(
    ctx,
    'plugin verify-checksums --all --format=json',
    240
  );
  let rows = [];
  const start = res.stdout.indexOf('[');
  const end = res.stdout.lastIndexOf(']');
  if (start !== -1 && end > start) {
    try {
      rows = JSON.parse(res.stdout.slice(start, end + 1));
    } catch {
      // fall through: reported below via exit code
    }
  }
  const byPlugin = new Map();
  for (const r of rows) {
    if (!byPlugin.has(r.plugin_name)) byPlugin.set(r.plugin_name, []);
    byPlugin.get(r.plugin_name).push(r);
  }
  for (const [plugin, items] of byPlugin) {
    const changed = items.filter(i =>
      /does not match|was added/i.test(i.message || '')
    );
    const missing = items.filter(i => /missing/i.test(i.message || ''));
    if (changed.length > 0) {
      findings.push(
        finding(
          'alert',
          `plugin ${plugin}: ${changed.length} file(s) modified or added: ${list(
            changed.map(i => i.file),
            4
          )}`
        )
      );
    }
    if (missing.length > 0) {
      findings.push(
        finding(
          'warn',
          `plugin ${plugin}: ${missing.length} file(s) missing: ${list(
            missing.map(i => i.file),
            4
          )}`
        )
      );
    }
  }
  const unverifiable = [
    ...new Set(
      [
        ...res.stderr.matchAll(/checksums for version S+ of plugin ([^s,]+)/g)
      ].map(m => m[1])
    )
  ];
  if (unverifiable.length > 0) {
    findings.push(
      finding(
        'info',
        `plugin checksums not verifiable (not on wordpress.org): ${list(unverifiable, 12)}`
      )
    );
  }
  if (rows.length === 0 && unverifiable.length === 0 && res.code === 0) {
    findings.push(finding('ok', 'plugin checksums verified'));
  } else if (rows.length === 0 && unverifiable.length === 0) {
    findings.push(
      finding(
        'warn',
        `plugin verify-checksums exited ${res.code}: ${res.all.trim().slice(0, 200)}`
      )
    );
  }
}

async function run(ctx) {
  const findings = [];
  const base = ctx.baseline;

  for (const step of [coreChecksums, pluginChecksums]) {
    try {
      await step(ctx, findings);
    } catch (err) {
      findings.push(finding('warn', `${step.name} failed: ${err.message}`));
    }
  }

  // mu-plugins and drop-ins.
  const ls = await sh(
    ctx,
    'ls -1A wp-content/mu-plugins 2>/dev/null; echo "@@"; ls -1A wp-content 2>/dev/null',
    30
  );
  const [muRaw = '', contentRaw = ''] = ls.stdout.split('@@');
  const muPlugins = muRaw
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean)
    .sort();
  const dropIns = contentRaw
    .split('\n')
    .map(s => s.trim())
    .filter(f => DROP_INS.includes(f))
    .sort();

  const allowed = new Set(ctx.config.allowedMuPlugins);
  for (const name of muPlugins.filter(n => !allowed.has(n))) {
    const isNew = base && !(base.muPlugins || []).includes(name);
    findings.push(
      finding(
        isNew ? 'alert' : 'warn',
        isNew
          ? `new mu-plugin not on the allowlist: ${name}`
          : `mu-plugin not on the allowlist: ${name} (add it to allowedMuPlugins if legitimate)`
      )
    );
  }
  if (base) {
    const newDropIns = setDiff(dropIns, base.dropIns);
    if (newDropIns.length > 0) {
      findings.push(
        finding('alert', `new wp-content drop-in(s): ${list(newDropIns)}`)
      );
    }
  }
  findings.push(
    finding(
      'info',
      `mu-plugins: ${muPlugins.join(', ') || 'none'}; drop-ins: ${dropIns.join(', ') || 'none'}`
    )
  );

  // Suspicious directives (file:line + keyword only, never the line content).
  const grep = await sh(
    ctx,
    `grep -inE '${SUSPICIOUS}' ${CONFIG_FILES} 2>/dev/null`,
    30
  );
  const suspicious = [];
  for (const line of grep.stdout.split('\n').filter(Boolean)) {
    if (/wordfence-waf\.php/i.test(line)) continue;
    const m = line.match(/^([^:]+):(\d+):(.*)$/);
    if (!m) continue;
    const kw = m[3].match(new RegExp(SUSPICIOUS, 'i'))?.[0];
    suspicious.push(`${m[1]}:${m[2]} (${kw})`);
  }
  if (suspicious.length > 0) {
    findings.push(
      finding('alert', `suspicious directive(s): ${list(suspicious)}`)
    );
  }

  return { findings, snapshot: { muPlugins, dropIns } };
}

module.exports = {
  id: 'integrity',
  title: 'File integrity',
  needsSsh: true,
  run
};
