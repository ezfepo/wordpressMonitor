'use strict';

const { finding, sh } = require('./common');

const FILES = [
  'wp-content/uploads/sucuri/sucuri-auditqueue.php',
  'wp-content/uploads/sucuri/sucuri-auditlogs.php'
];

// "<epoch>_<id>:"Aviso: user, 1.2.3.4; Media file added; ID: 1; name: x.zip; type:""
function parseLine(raw) {
  const m = raw.trim().match(/^(\d+)_(\d+):"([\s\S]*)"$/);
  if (!m) return null;
  const rest = m[3].replace(/^[^:]*:\s*/, '');
  const parts = rest.split(';').map(s => s.trim());
  const who = parts[0].match(/^(.*?),\s*([0-9a-fA-F:.]+)$/);
  return {
    key: `${m[1]}_${m[2]}`,
    epoch: Number(m[1]),
    user: who ? who[1] : parts[0],
    ip: who ? who[2] : null,
    text: rest
  };
}

const isLocal = ip => !ip || ip === '127.0.0.1' || ip === '::1';

// Returns { severity, message } when the event is worth reporting, else null.
// Plugin changes made by the server itself (127.0.0.1: WP-CLI updates) are
// muted; everything else listed here is an alert.
function classify(ev, knownIps) {
  const found = classifyText(ev, knownIps);
  if (!found) return null;
  const serverPlugin = isLocal(ev.ip) && /plugin change/.test(found);
  return { severity: serverPlugin ? 'info' : 'alert', message: found };
}

function classifyText(ev, knownIps) {
  const t = ev.text;
  if (/plugin (installed|activated|deactivated|deleted)/i.test(t)) {
    return `plugin change by ${ev.user} (${ev.ip || 'local'}): ${t.slice(0, 120)}`;
  }
  if (
    /user account (was )?(added|created|registered)|new user (added|created)|user registered/i.test(
      t
    )
  ) {
    return `user created by ${ev.user} (${ev.ip || 'local'}): ${t.slice(0, 120)}`;
  }
  if (/role.*(chang|updat|set)|(chang|updat).*role/i.test(t)) {
    return `role change by ${ev.user} (${ev.ip || 'local'}): ${t.slice(0, 120)}`;
  }
  if (/password changed/i.test(t)) {
    return `password changed by ${ev.user} (${ev.ip || 'local'})`;
  }
  if (/(file|media file) (added|uploaded)/i.test(t)) {
    const name = t.match(/name:\s*([^;]+)/i)?.[1]?.trim() || '';
    if (/\.(zip|php|phtml|phar|sh)$/i.test(name)) {
      return `file added by ${ev.user} (${ev.ip || 'local'}): ${name}`;
    }
  }
  if (
    /theme (installed|activated|deleted|switched|edit|modif|chang)|switched theme|theme editor/i.test(
      t
    )
  ) {
    return `theme change by ${ev.user} (${ev.ip || 'local'}): ${t.slice(0, 120)}`;
  }
  if (
    /authentication succeeded|logged in|user login/i.test(t) &&
    !/fail/i.test(t) &&
    !isLocal(ev.ip) &&
    !knownIps.has(ev.ip)
  ) {
    return `login from new IP ${ev.ip}: ${ev.user}`;
  }
  return null;
}

const isLogin = ev =>
  /authentication succeeded|logged in|user login/i.test(ev.text) &&
  !/fail/i.test(ev.text);

async function run(ctx) {
  const events = new Map();
  let found = false;
  for (const file of FILES) {
    const res = await sh(ctx, `[ -f ${file} ] && tail -c 1500000 ${file}`, 30);
    if (res.code !== 0 && !res.stdout) continue;
    found = true;
    for (const line of res.stdout.split('\n')) {
      const ev = parseLine(line);
      if (ev) events.set(ev.key, ev);
    }
  }
  if (!found) {
    return {
      findings: [
        finding('info', 'Sucuri audit log not available on this site')
      ],
      snapshot: null,
      unavailable: true
    };
  }

  const all = [...events.values()].sort((a, b) => a.epoch - b.epoch);
  const maxEpoch = all.length ? all[all.length - 1].epoch : 0;
  const baseIps = ctx.baseline?.knownIps || [];
  const knownIps = new Set(baseIps);
  const findings = [];

  if (ctx.baseline) {
    const since = ctx.baseline.lastEpoch || 0;
    const fresh = all.filter(e => e.epoch > since);
    const hits = fresh.map(ev => classify(ev, knownIps)).filter(Boolean);
    const alerts = hits.filter(h => h.severity === 'alert');
    for (const a of alerts.slice(0, 15)) {
      findings.push(finding('alert', a.message));
    }
    if (alerts.length > 15) {
      findings.push(
        finding('alert', `${alerts.length - 15} more Sucuri audit alert(s)`)
      );
    }
    const muted = hits.length - alerts.length;
    if (muted > 0) {
      findings.push(
        finding(
          'info',
          `${muted} plugin change(s) made by the server itself (local)`
        )
      );
    }
    findings.push(
      finding(
        'info',
        `Sucuri audit: ${fresh.length} new event(s) since ${since ? new Date(since * 1000).toISOString().slice(0, 16) : 'start'}`
      )
    );
  }

  const seenIps = all
    .filter(isLogin)
    .map(e => e.ip)
    .filter(ip => !isLocal(ip));
  const snapshot = {
    lastEpoch: Math.max(maxEpoch, ctx.baseline?.lastEpoch || 0),
    knownIps: [...new Set([...baseIps, ...seenIps])].sort()
  };
  const advance = { lastEpoch: snapshot.lastEpoch, knownIps: baseIps };
  if (!ctx.baseline) {
    findings.push(
      finding('info', `learned ${snapshot.knownIps.length} known login IP(s)`)
    );
  }
  return { findings, snapshot, advance };
}

module.exports = {
  id: 'sucuri-audit',
  title: 'Sucuri audit log',
  needsSsh: true,
  run
};
