'use strict';

const { finding, wpEval, list, siteDomain, hostOf } = require('./common');
const { siteUrl } = require('../ssh');

// Reads posts, postmeta and options with $wpdb (no `wp db query`: proc_open is
// disabled). Only IDs / option names and the pattern type leave the server.
const PHP = `
global $wpdb;
$max = (int) $P['max'];
$allowed = array_map('strtolower', $P['allowedDomains']);
$like = function ($col) {
  $c = [];
  foreach (['<script', 'eval(', 'base64_decode', '<iframe'] as $p) {
    $c[] = "$col LIKE '%" . esc_sql($GLOBALS['wpdb']->esc_like($p)) . "%'";
  }
  $c[] = "($col LIKE '%<a %' AND ($col LIKE '%display:none%' OR $col LIKE '%display: none%' OR $col LIKE '%visibility:hidden%' OR $col LIKE '%visibility: hidden%' OR $col LIKE '%font-size:0%'))";
  return '(' . implode(' OR ', $c) . ')';
};
$hostOk = function ($h) use ($allowed) {
  $h = strtolower($h);
  foreach ($allowed as $a) { if ($h === $a || substr($h, -strlen($a) - 1) === '.' . $a) { return true; } }
  return false;
};
$patterns = function ($c) use ($hostOk) {
  $found = [];
  foreach (['script' => '<script', 'iframe' => '<iframe'] as $name => $needle) {
    if (stripos($c, $needle) === false) { continue; }
    preg_match_all('#<' . $name . '\\b[^>]*\\bsrc\\s*=\\s*["\\']?(?:https?:)?//([^/"\\'\\s>]+)#i', $c, $m);
    $inline = ($name === 'script') ? preg_match_all('#<script\\b(?![^>]*\\bsrc\\s*=)#i', $c) : 0;
    $ok = !empty($m[1]) && !$inline;
    foreach ($m[1] as $h) { if (!$hostOk($h)) { $ok = false; } }
    if (!$ok) { $found[] = '<' . $name; }
  }
  if (stripos($c, 'eval(') !== false) { $found[] = 'eval('; }
  if (stripos($c, 'base64_decode') !== false) { $found[] = 'base64_decode'; }
  if (preg_match('#<a\\b[^>]*(display\\s*:\\s*none|visibility\\s*:\\s*hidden|font-size\\s*:\\s*0)#i', $c)) { $found[] = 'hidden-link'; }
  return $found;
};
$out = ['posts' => [], 'postmeta' => [], 'options' => [], 'truncated' => []];
$collect = function ($rows, $key, $label) use (&$out, $patterns, $max) {
  foreach ($rows as $r) {
    $p = $patterns($r->c);
    if (!$p) { continue; }
    if (count($out[$key]) >= $max) { $out['truncated'][] = $key; return; }
    $out[$key][] = ['id' => $r->id, 'label' => $label($r), 'patterns' => $p, 'sig' => substr(sha1($r->c), 0, 16)];
  }
};
$limit = $max * 12;

$rows = $wpdb->get_results("SELECT ID AS id, post_type AS t, post_content AS c FROM {$wpdb->posts}
  WHERE post_status NOT IN ('auto-draft','trash') AND post_type NOT IN ('revision','nav_menu_item','customize_changeset','oembed_cache')
  AND " . $like('post_content') . " LIMIT $limit");
$collect($rows, 'posts', function ($r) { return $r->t; });

$skip = '';
foreach ($P['ignoreMeta'] as $pre) { $skip .= $wpdb->prepare(' AND meta_key NOT LIKE %s', $wpdb->esc_like($pre) . '%'); }
$rows = $wpdb->get_results("SELECT meta_id AS id, meta_key AS k, meta_value AS c FROM {$wpdb->postmeta}
  WHERE 1=1 $skip AND " . $like('meta_value') . " LIMIT $limit");
$collect($rows, 'postmeta', function ($r) { return $r->k; });

$skip = $wpdb->prepare(' AND option_name NOT LIKE %s AND option_name NOT LIKE %s', '\\_transient\\_%', '\\_site\\_transient\\_%');
foreach ($P['ignoreOptions'] as $pre) { $skip .= $wpdb->prepare(' AND option_name NOT LIKE %s', $wpdb->esc_like($pre) . '%'); }
$rows = $wpdb->get_results("SELECT option_name AS id, option_name AS k, option_value AS c FROM {$wpdb->options}
  WHERE 1=1 $skip AND " . $like('option_value') . " LIMIT $limit");
$collect($rows, 'options', function ($r) { return $r->k; });
return $out;
`;

async function run(ctx) {
  const own = siteDomain(ctx.site) || hostOf(siteUrl(ctx.site));
  const res = await wpEval(
    ctx,
    PHP,
    {
      max: ctx.config.dbScanMaxResults,
      allowedDomains: [own, ...ctx.config.dbScanAllowedDomains].filter(Boolean),
      ignoreMeta: ctx.config.dbScanIgnoreMetaPrefixes,
      ignoreOptions: ctx.config.dbScanIgnoreOptionPrefixes
    },
    180
  );
  const findings = [];
  const known = ctx.baseline?.hits || null;
  const hits = {};
  const label = { posts: 'post', postmeta: 'postmeta', options: 'option' };
  for (const key of ['posts', 'postmeta', 'options']) {
    const fresh = [];
    const same = [];
    for (const h of res[key] || []) {
      const id = `${key}:${h.id}`;
      hits[id] = h.sig;
      const text = `${key === 'options' ? h.id : `ID ${h.id}${key === 'posts' ? ` (${h.label})` : ` [${h.label}]`}`}: ${[...new Set(h.patterns)].join('+')}`;
      // Known and unchanged since the baseline: muted. New or edited: warn.
      (known && known[id] === h.sig ? same : fresh).push(text);
    }
    const cut = res.truncated.includes(key) ? ' (truncated)' : '';
    if (fresh.length > 0) {
      findings.push(
        finding(
          known ? 'warn' : 'info',
          `${fresh.length} ${label[key]} hit(s)${known ? ' new or changed' : ''}${cut}: ${list(fresh, 12)}`
        )
      );
    }
    if (same.length > 0) {
      findings.push(
        finding(
          'info',
          `${same.length} known ${label[key]} hit(s) unchanged${cut}: ${list(same, 6)}`
        )
      );
    }
  }
  return { findings, snapshot: { hits } };
}

module.exports = {
  id: 'db-scan',
  title: 'Database scan',
  needsSsh: true,
  run
};
