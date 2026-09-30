/**
 * Builds a self-contained HTML report from the JSON files a run leaves in
 * reports/: wp-update-*, php-*, wp-mails-* and dmarc-*.
 *
 * Usage:
 *   node src/build-report.js [--since <ISO date>] [--mode <mode>] [--logs a,b]
 *
 * Only files modified at or after --since are included (default: all).
 * Prints the path of the generated reports/report-<ts>.html.
 */

const fs = require('node:fs');
const path = require('node:path');
const { formatTimestamp, timestampSlug } = require('./lib/format');

const REPORTS_DIR = path.resolve(__dirname, '..', 'reports');

function parseArgs(argv) {
  const opts = { since: 0, mode: '', logs: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--since') {
      opts.since = new Date(argv[++i]).getTime() || 0;
    } else if (argv[i] === '--mode') {
      opts.mode = argv[++i];
    } else if (argv[i] === '--logs') {
      opts.logs = argv[++i].split(',').filter(Boolean);
    }
  }
  return opts;
}

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Newest matching JSON file (mtime >= since), parsed, plus its path.
function latest(prefix, since) {
  if (!fs.existsSync(REPORTS_DIR)) return null;
  const candidates = fs
    .readdirSync(REPORTS_DIR)
    .filter(f => f.startsWith(prefix) && f.endsWith('.json'))
    .map(f => {
      const full = path.join(REPORTS_DIR, f);
      return { full, mtime: fs.statSync(full).mtimeMs };
    })
    .filter(f => f.mtime >= since)
    .sort((a, b) => b.mtime - a.mtime);
  if (candidates.length === 0) return null;
  try {
    return {
      path: candidates[0].full,
      data: JSON.parse(fs.readFileSync(candidates[0].full, 'utf8'))
    };
  } catch {
    return null;
  }
}

// ---- Action needed --------------------------------------------------------

function collectActions(wp, php, mails, dmarc) {
  const actions = [];
  if (wp) {
    for (const r of wp.data.results) {
      for (const e of r.errors) {
        actions.push(`${r.site}: ${e}`);
      }
      if (r.coreUpdate) {
        actions.push(
          `${r.site}: WordPress core update available (${r.coreUpdate.version}, ${r.coreUpdate.updateType || 'unknown'}) - update manually.`
        );
      }
      const pc = r.phpCompatibility;
      if (pc) {
        if (pc.outdated) {
          actions.push(
            `${r.site}: PHP ${pc.phpVersion} is below the recommended ${pc.recommendedPhpVersion}.`
          );
        }
        for (const i of pc.incompatibleItems) {
          actions.push(
            `${r.site}: ${i.kind} "${i.name}" requires PHP ${i.requiresPhp} (site runs ${pc.phpVersion}).`
          );
        }
      }
      if (r.status === 'partial' || r.status === 'failed') {
        if (r.errors.length === 0) {
          actions.push(`${r.site}: some updates did not apply.`);
        }
      }
    }
  }
  if (php && php.data.sites) {
    for (const s of php.data.sites) {
      if (s.outcome === 'skipped-compat') {
        actions.push(
          `${s.site}: PHP ${s.current} -> ${s.highest} available but skipped: ${s.reason || 'plugin/theme needs review first'}.`
        );
      } else if (s.outcome === 'failed') {
        actions.push(
          `${s.site}: PHP update ${s.current} -> ${s.highest} failed: ${s.error || 'unknown error'}.`
        );
      }
    }
  }
  if (mails && mails.data.mails) {
    for (const m of mails.data.mails.filter(x => x.actionNeeded)) {
      actions.push(
        `${m.site || 'unknown site'}: WordPress email "${m.subject}" - ${m.summary}`
      );
    }
  }
  if (dmarc) {
    for (const d of dmarc.data.domains || []) {
      if (d.status === 'alert') {
        actions.push(
          `DMARC ${d.domain}: unknown sources sending as this domain.`
        );
      }
    }
    for (const f of dmarc.data.failed || []) {
      actions.push(
        `DMARC: could not parse message ${f.messageId} (${f.error}); left in Gmail.`
      );
    }
  }
  return actions;
}

// ---- Sections -------------------------------------------------------------

function itemList(label, section, dryRun) {
  const rows = [];
  for (const u of section.updated || []) {
    rows.push(
      `<li>${esc(u.name)}: ${esc(u.oldVersion)} &rarr; ${esc(u.newVersion)}</li>`
    );
  }
  for (const f of section.failed || []) {
    rows.push(`<li class="bad">${esc(f.name)}: FAILED (${esc(f.status)})</li>`);
  }
  if (dryRun || (section.updated || []).length === 0) {
    for (const a of section.available || []) {
      if (!(section.updated || []).some(u => u.name === a.name)) {
        rows.push(
          `<li class="muted">${esc(a.name)}: ${esc(a.version)} &rarr; ${esc(a.updateVersion)} available${dryRun ? '' : ' (not applied)'}</li>`
        );
      }
    }
  }
  for (const e of section.excluded || []) {
    rows.push(`<li class="muted">${esc(e)}: excluded</li>`);
  }
  if (rows.length === 0) return `<p class="muted">${label}: up to date.</p>`;
  return `<h4>${label}</h4><ul>${rows.join('')}</ul>`;
}

function translationList(section, dryRun) {
  const fmt = t => `${esc(t.type)}/${esc(t.name)} (${esc(t.language)})`;
  const rows = [];
  for (const t of section.updated || [])
    rows.push(`<li>${fmt(t)} updated</li>`);
  for (const t of section.remaining || []) {
    rows.push(`<li class="bad">${fmt(t)} still pending</li>`);
  }
  if (dryRun) {
    for (const t of section.available || []) {
      rows.push(`<li class="muted">${fmt(t)} available</li>`);
    }
  }
  if (rows.length === 0)
    return '<p class="muted">Translations: up to date.</p>';
  return `<h4>Translations</h4><ul>${rows.join('')}</ul>`;
}

function siteCard(r, phpSite) {
  const out = [];
  out.push(
    `<article class="card"><h3>${esc(r.site)} <span class="pill ${esc(r.status)}">${esc(r.status)}</span></h3>`
  );
  for (const e of r.errors) out.push(`<p class="bad">ERROR: ${esc(e)}</p>`);
  if (r.connected) {
    out.push(
      r.coreUpdate
        ? `<p class="bad">Core update available: ${esc(r.coreUpdate.version)} (${esc(r.coreUpdate.updateType || 'unknown')}) - not applied.</p>`
        : '<p class="muted">WordPress core: up to date.</p>'
    );
    if (phpSite) {
      const text = {
        bumped: `PHP updated ${esc(phpSite.current)} &rarr; ${esc(phpSite.newVersion || phpSite.highest)}.`,
        'up-to-date': `PHP ${esc(phpSite.current)} is the highest supported version.`,
        'available-dry-run': `PHP ${esc(phpSite.current)} &rarr; ${esc(phpSite.highest)} available (not applied, dry run).`,
        'skipped-compat': `PHP ${esc(phpSite.current)} &rarr; ${esc(phpSite.highest)} skipped: ${esc(phpSite.reason || 'compatibility review needed')}.`,
        failed: `PHP update failed: ${esc(phpSite.error || 'unknown error')}.`
      }[phpSite.outcome];
      const bad = ['skipped-compat', 'failed'].includes(phpSite.outcome);
      if (text) out.push(`<p class="${bad ? 'bad' : ''}">${text}</p>`);
    }
    out.push(itemList('Plugins', r.plugins, r.dryRun));
    out.push(itemList('Themes', r.themes, r.dryRun));
    out.push(translationList(r.translations, r.dryRun));
  }
  out.push('</article>');
  return out.join('');
}

function wpSection(wp, php) {
  if (!wp) return '';
  const phpBySite = new Map(
    ((php && php.data.sites) || []).map(s => [s.site, s])
  );
  const mode = wp.data.dryRun ? 'dry run (check only)' : 'update';
  return `<section><h2>WordPress sites</h2><p class="muted">Mode: ${mode}${php && php.data.unavailable ? ' &middot; Hostinger PHP check unavailable' : ''}</p><div class="grid">${wp.data.results
    .map(r => siteCard(r, phpBySite.get(r.site)))
    .join('')}</div></section>`;
}

function mailsSection(mails) {
  if (!mails) return '';
  if (mails.data.unavailable) {
    return '<section><h2>WordPress emails</h2><p class="muted">Gmail unavailable in this session.</p></section>';
  }
  const list = mails.data.mails || [];
  if (list.length === 0) {
    return `<section><h2>WordPress emails</h2><p class="muted">No emails under label "${esc(mails.data.label)}".</p></section>`;
  }
  const trashed = new Set(mails.data.trashed || []);
  return `<section><h2>WordPress emails</h2><table><thead><tr><th>Date</th><th>Site</th><th>Type</th><th>Subject</th><th>Summary</th><th>Trash</th></tr></thead><tbody>${list
    .map(
      m =>
        `<tr class="${m.actionNeeded ? 'row-bad' : ''}"><td>${esc(m.date)}</td><td>${esc(m.site || '-')}</td><td>${esc(m.kind)}</td><td>${esc(m.subject)}</td><td>${esc(m.summary)}</td><td>${trashed.has(m.threadId) ? 'trashed' : 'kept'}</td></tr>`
    )
    .join('')}</tbody></table></section>`;
}

function dmarcSection(dmarc) {
  if (!dmarc) return '';
  const d = dmarc.data;
  if (!d.reports || d.reports.length === 0) {
    return `<section><h2>DMARC</h2><p class="muted">${esc(d.note || 'No new DMARC reports.')}</p></section>`;
  }
  const h = d.highlights || {};
  const cards = [
    ['Reports', h.reports],
    ['Messages', h.messages],
    ['Aligned', h.alignedPct == null ? '-' : `${h.alignedPct}%`],
    ['Rejected/quarantined', h.rejectedOrQuarantined],
    ['Unknown-source msgs', h.unknownSourceMessages]
  ]
    .map(
      ([k, v]) =>
        `<div class="stat"><div class="stat-v">${esc(v)}</div><div class="muted">${esc(k)}</div></div>`
    )
    .join('');
  const narrative = (d.narrative || []).length
    ? `<ul>${d.narrative.map(n => `<li>${esc(n)}</li>`).join('')}</ul>`
    : '';
  const range =
    h.dateBegin && h.dateEnd
      ? `<p class="muted">Covering ${esc(h.dateBegin.slice(0, 10))} to ${esc(h.dateEnd.slice(0, 10))}</p>`
      : '';
  const domains = (d.domains || [])
    .map(
      dom =>
        `<h3>${esc(dom.domain)} <span class="pill ${esc(dom.status)}">${esc(dom.status)}</span> <span class="muted">p=${esc(dom.policy.p)} pct=${esc(dom.policy.pct)}</span></h3><table><thead><tr><th>Source IP</th><th>PTR</th><th>Sender</th><th>Msgs</th><th>DKIM aligned</th><th>SPF aligned</th><th>Class</th></tr></thead><tbody>${dom.sources
          .map(
            s =>
              `<tr class="${s.class === 'unknown' ? 'row-bad' : ''}"><td>${esc(s.ip)}</td><td>${esc(s.ptr || '-')}</td><td>${esc(s.sender || '-')}</td><td>${esc(s.count)}</td><td>${esc(s.dkimAligned)}</td><td>${esc(s.spfAligned)}</td><td>${esc(s.class)}</td></tr>`
          )
          .join('')}</tbody></table>`
    )
    .join('');
  const trashed = (d.trashed || []).length
    ? `<p class="muted">${d.trashed.length} email thread(s) sent to trash.${(d.trashFailed || []).length ? ` ${d.trashFailed.length} could not be trashed.` : ''}</p>`
    : '';
  const failed = (d.failed || []).length
    ? `<p class="bad">${d.failed.length} message(s) could not be parsed and were left in Gmail.</p>`
    : '';
  const warns = (d.reports || []).flatMap(r =>
    (r.warnings || []).map(
      w => `<li class="muted">${esc(r.org)} ${esc(r.domain)}: ${esc(w)}</li>`
    )
  );
  return `<section><h2>DMARC</h2><h3>Highlights</h3>${narrative}<div class="stats">${cards}</div>${range}${domains}${trashed}${failed}${warns.length ? `<ul>${warns.join('')}</ul>` : ''}</section>`;
}

// ---- Page -----------------------------------------------------------------

const CSS = `
:root{--bg:#fff;--fg:#1a1d21;--muted:#667085;--card:#f6f7f9;--line:#e1e4e8;--bad:#b42318;--badbg:#fef3f2;--ok:#067647;--warn:#b54708}
@media (prefers-color-scheme:dark){:root{--bg:#14171a;--fg:#e6e8eb;--muted:#98a2b3;--card:#1d2126;--line:#2e343b;--bad:#f97066;--badbg:#2a1614;--ok:#47cd89;--warn:#fdb022}}
*{box-sizing:border-box}
body{margin:0;padding:16px;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,Segoe UI,sans-serif}
main{max-width:1100px;margin:0 auto}
h1{margin:0 0 4px}h2{margin:32px 0 8px;border-bottom:1px solid var(--line);padding-bottom:4px}h3{margin:16px 0 6px}h4{margin:10px 0 2px}
.muted{color:var(--muted)}.bad{color:var(--bad)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:12px}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:8px 14px}
ul{margin:4px 0;padding-left:20px}
table{width:100%;border-collapse:collapse;font-size:14px;display:block;overflow-x:auto}
th,td{text-align:left;padding:4px 8px;border-bottom:1px solid var(--line);vertical-align:top}
.row-bad{background:var(--badbg)}
.pill{font-size:12px;padding:1px 8px;border-radius:99px;border:1px solid var(--line);font-weight:600}
.pill.ok{color:var(--ok)}.pill.partial,.pill.attention,.pill.attention-needed{color:var(--warn)}.pill.failed,.pill.unreachable,.pill.alert{color:var(--bad)}
.action{background:var(--badbg);border:1px solid var(--bad);border-radius:8px;padding:8px 16px}
.stats{display:flex;flex-wrap:wrap;gap:12px;margin:8px 0}
.stat{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:8px 14px;min-width:110px}
.stat-v{font-size:22px;font-weight:700}
footer{margin-top:32px;font-size:13px}
`;

function buildHtml({ wp, php, mails, dmarc }, opts, now) {
  const actions = collectActions(wp, php, mails, dmarc);
  const action = actions.length
    ? `<section class="action"><h2>Action needed</h2><ul>${actions.map(a => `<li>${esc(a)}</li>`).join('')}</ul></section>`
    : '';
  const status = actions.length ? 'ACTION NEEDED' : 'All clear';
  const files = [wp, php, mails, dmarc]
    .filter(Boolean)
    .map(f => esc(f.path))
    .concat(opts.logs.map(esc));
  const empty =
    !wp && !mails && !dmarc
      ? '<p class="muted">No results were produced in this run.</p>'
      : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>wordpressMonitor report</title><style>${CSS}</style></head>
<body><main>
<h1>wordpressMonitor report</h1>
<p class="muted">${esc(formatTimestamp(now))} &middot; mode: ${esc(opts.mode || 'n/a')} &middot; <strong>${status}</strong></p>
${action}${empty}${wpSection(wp, php)}${mailsSection(mails)}${dmarcSection(dmarc)}
<footer class="muted"><p>Files:</p><ul>${files.map(f => `<li>${f}</li>`).join('')}</ul></footer>
</main></body></html>
`;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const data = {
    wp: latest('wp-update-', opts.since),
    php: latest('php-', opts.since),
    mails: latest('wp-mails-', opts.since),
    dmarc: latest('dmarc-', opts.since)
  };
  const now = new Date();
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const out = path.join(REPORTS_DIR, `report-${timestampSlug(now)}.html`);
  fs.writeFileSync(out, buildHtml(data, opts, now));
  console.log(out);
}

main();
