'use strict';

const { finding, sh, wpEval, list, setDiff } = require('./common');

const CRON_PHP = `
global $wpdb;
$hooks = [];
$cron = _get_cron_array();
if (is_array($cron)) {
  foreach ($cron as $ts => $events) {
    if (!is_array($events)) { continue; }
    foreach ($events as $hook => $_) { $hooks[$hook] = 1; }
  }
}
$ioc = ['options' => [], 'users' => []];
foreach ($P['ioc'] as $pat) {
  $like = '%' . $wpdb->esc_like($pat) . '%';
  $ioc['options'] = array_merge($ioc['options'], (array) $wpdb->get_col($wpdb->prepare(
    "SELECT option_name FROM {$wpdb->options} WHERE option_name LIKE %s LIMIT 20", $like)));
  $ioc['users'] = array_merge($ioc['users'], (array) $wpdb->get_col($wpdb->prepare(
    "SELECT user_login FROM {$wpdb->users} WHERE user_login LIKE %s LIMIT 20", $like)));
}
return ['hooks' => array_keys($hooks), 'ioc' => $ioc];
`;

// api.telegram.org was the backdoor's control channel; the others are classic
// obfuscation wrappers. One grep pass answers both.
const CODE_PATTERN =
  'api\\.telegram\\.org|eval\\(base64_decode|gzinflate\\(base64_decode|eval\\(gzinflate|eval\\(str_rot13|assert\\(base64_decode';

const matchesIoc = (value, ioc) =>
  ioc.some(p => String(value).toLowerCase().includes(p.toLowerCase()));

const lines = out =>
  out
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean);

async function phpInUploads(ctx, findings) {
  const res = await sh(
    ctx,
    `find wp-content/uploads -type f \\( -iname '*.php' -o -iname '*.phtml' -o -iname '*.phar' -o -iname '*.pht' -o -iname '*.php[0-9]' \\) ! -path '*/uploads/sucuri/*' ! \\( -name index.php -size -100c \\) 2>/dev/null | head -50`,
    90
  );
  const alerts = [];
  const infos = [];
  for (const file of lines(res.stdout)) {
    if (
      /uploads\/mailchimp-for-wp\/debug-log\.php$/.test(file) ||
      ctx.config.allowedUploadsPhp.some(p => file.includes(p))
    ) {
      infos.push(file);
    } else {
      alerts.push(file);
    }
  }
  if (alerts.length > 0) {
    findings.push(finding('alert', `PHP files in uploads: ${list(alerts)}`));
  }
  if (infos.length > 0) {
    findings.push(
      finding('info', `known PHP file(s) in uploads: ${list(infos)}`)
    );
  }
}

async function codeScan(ctx, findings) {
  const res = await sh(
    ctx,
    `grep -rIHoE -m1 '${CODE_PATTERN}' wp-content --include='*.php' 2>/dev/null | head -200`,
    150
  );
  const ignore = ctx.config.codeScanIgnore.map(p => new RegExp(p, 'i'));
  const known = ctx.config.codeScanKnownFalsePositives.map(
    p => new RegExp(p, 'i')
  );
  const telegramOk = new Set(ctx.config.allowedTelegramPlugins);
  const telegram = [];
  const obfuscated = [];
  const knownHits = [];
  for (const line of lines(res.stdout)) {
    const i = line.indexOf(':');
    const file = line.slice(0, i);
    const hit = line.slice(i + 1);
    if (ignore.some(r => r.test(file))) continue;
    if (known.some(r => r.test(file))) {
      knownHits.push(file);
      continue;
    }
    if (/telegram/i.test(hit)) {
      const plugin = file.match(/wp-content\/plugins\/([^/]+)\//)?.[1];
      if (!plugin || !telegramOk.has(plugin)) telegram.push(file);
    } else {
      obfuscated.push(file);
    }
  }
  if (telegram.length > 0) {
    findings.push(
      finding('alert', `api.telegram.org referenced in: ${list(telegram)}`)
    );
  }
  if (obfuscated.length > 0) {
    findings.push(
      finding('alert', `obfuscated-code pattern in: ${list(obfuscated)}`)
    );
  }
  if (knownHits.length > 0) {
    findings.push(
      finding('info', `known false positive pattern in: ${list(knownHits)}`)
    );
  }
}

async function run(ctx) {
  const findings = [];
  const ioc = ctx.config.iocPatterns;

  await phpInUploads(ctx, findings);

  // Cron hooks + IOC in options/users (one wp eval).
  const cron = await wpEval(ctx, CRON_PHP, { ioc });
  const hooks = [...cron.hooks].sort();
  const iocHooks = hooks.filter(h => matchesIoc(h, ioc));
  if (iocHooks.length > 0) {
    findings.push(finding('alert', `IOC cron hook(s): ${list(iocHooks)}`));
  }
  if (cron.ioc.options.length > 0) {
    findings.push(finding('alert', `IOC option(s): ${list(cron.ioc.options)}`));
  }
  if (cron.ioc.users.length > 0) {
    findings.push(
      finding('alert', `IOC user login(s): ${list(cron.ioc.users)}`)
    );
  }
  if (ctx.baseline) {
    const fresh = setDiff(hooks, ctx.baseline.hooks).filter(
      h => !iocHooks.includes(h)
    );
    if (fresh.length > 0) {
      findings.push(finding('warn', `new cron hook(s): ${list(fresh)}`));
    }
  }

  // IOC in mu-plugins, plugins and file names anywhere in wp-content.
  const names = await sh(
    ctx,
    'ls -1A wp-content/mu-plugins 2>/dev/null; echo "@@"; ls -1A wp-content/plugins 2>/dev/null',
    30
  );
  const [mu = '', plugins = ''] = names.stdout.split('@@');
  const iocDirs = [
    ...lines(mu)
      .filter(n => matchesIoc(n, ioc))
      .map(n => `mu-plugins/${n}`),
    ...lines(plugins)
      .filter(n => matchesIoc(n, ioc))
      .map(n => `plugins/${n}`)
  ];
  if (iocDirs.length > 0) {
    findings.push(finding('alert', `IOC mu-plugin/plugin: ${list(iocDirs)}`));
  }
  const nameExpr = ioc
    .map(p => `-iname '*${p.replace(/[^a-zA-Z0-9_.-]/g, '')}*'`)
    .join(' -o ');
  const files = await sh(
    ctx,
    `find wp-content \\( ${nameExpr} \\) 2>/dev/null | head -20`,
    60
  );
  if (lines(files.stdout).length > 0) {
    findings.push(
      finding('alert', `IOC file name(s): ${list(lines(files.stdout))}`)
    );
  }

  await codeScan(ctx, findings);

  return { findings, snapshot: { hooks } };
}

module.exports = {
  id: 'uploads-cron',
  title: 'Uploads, cron and IOC',
  needsSsh: true,
  run
};
