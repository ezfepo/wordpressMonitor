'use strict';

/**
 * Helpers shared by the security checks. Everything here is read-only on the
 * server: remote commands only list, grep, cat or SELECT.
 *
 * A check module exports { id, title, needsSsh, prepare?(sites, shared),
 * run(ctx) }. run() returns
 *   { findings: [{ severity, message }], snapshot, advance? }
 * where `snapshot` is the observed state (stored by --accept and on the first
 * run) and `advance` is what a normal real run stores on an existing baseline
 * (only the Sucuri cursor needs it; everything else is left untouched).
 */

const { execCommand, shellQuote, wpCommand } = require('../ssh');

const MARKER = '@@WPMSEC@@';

const finding = (severity, message) => ({ severity, message });

// Registrable-ish host without leading "www.".
function bare(host) {
  return String(host || '')
    .toLowerCase()
    .replace(/^www\./, '');
}

// Domain folder inside wpPath (domains/<domain>/public_html).
function siteDomain(site) {
  return site.wpPath?.match(/domains\/([^/]+)/)?.[1] || null;
}

// true when `host` is `base` or a subdomain of it (www. ignored).
function sameSite(host, base) {
  const h = bare(host);
  const b = bare(base);
  return Boolean(h && b && (h === b || h.endsWith(`.${b}`)));
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

// Runs a shell snippet inside the site's WordPress folder under the remote
// `timeout`, so a heavy find/grep dies on the server too.
async function sh(ctx, script, seconds = 60) {
  const wrapped = `cd ${shellQuote(ctx.site.wpPath)} && timeout ${seconds} sh -c ${shellQuote(script)}`;
  return execCommand(ctx.conn, wrapped, {
    timeoutMs: (seconds + 15) * 1000
  });
}

// Runs a PHP body inside `wp eval` (one WordPress boot) and returns the value
// it `return`s, JSON-decoded. Params reach PHP as $P (base64 JSON, so no
// quoting or `$` interpolation problems). Uses $wpdb, never `wp db query`
// (proc_open is disabled on the host).
async function wpEval(ctx, body, params = {}, seconds = 120) {
  const b64 = Buffer.from(JSON.stringify(params)).toString('base64');
  const php = `
$P = json_decode(base64_decode('${b64}'), true);
$R = (function () use ($P) {
${body}
})();
echo '${MARKER}' . json_encode($R, JSON_PARTIAL_OUTPUT_ON_ERROR | JSON_INVALID_UTF8_SUBSTITUTE) . '${MARKER}';
`;
  const cmd = `timeout ${seconds} ${wpCommand(ctx.site, `eval ${shellQuote(php)}`)}`;
  const res = await execCommand(ctx.conn, cmd, {
    timeoutMs: (seconds + 15) * 1000
  });
  const start = res.stdout.indexOf(MARKER);
  const end = res.stdout.lastIndexOf(MARKER);
  if (res.code !== 0 || start === -1 || end <= start) {
    const why = (res.stderr || res.stdout).trim().slice(0, 300);
    throw new Error(`wp eval failed (exit ${res.code}): ${why}`);
  }
  return JSON.parse(res.stdout.slice(start + MARKER.length, end));
}

// Truncated, comma-separated list for one finding message.
function list(items, max = 8) {
  const shown = items.slice(0, max).join(', ');
  return items.length > max ? `${shown} (+${items.length - max} more)` : shown;
}

function setDiff(current, baseline) {
  const base = new Set(baseline || []);
  return current.filter(x => !base.has(x));
}

module.exports = {
  finding,
  bare,
  siteDomain,
  sameSite,
  hostOf,
  sh,
  wpEval,
  list,
  setDiff
};
