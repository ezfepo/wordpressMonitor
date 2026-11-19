'use strict';

const { siteUrl, CRITICAL_ERROR_MARKER } = require('../ssh');
const { finding, hostOf, sameSite, list, setDiff } = require('./common');

const TIMEOUT_MS = 20000;
const BROWSER_UA = 'Mozilla/5.0 (compatible; wordpressMonitor security check)';
const GOOGLEBOT_UA =
  'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

// GET following redirects by hand (max 5) so a hop to a foreign domain is
// seen. Returns { status, body, finalUrl, foreignHop }.
async function fetchPage(url, userAgent, base) {
  let current = url;
  let foreignHop = null;
  for (let i = 0; i < 6; i++) {
    const res = await fetch(current, {
      redirect: 'manual',
      headers: { 'user-agent': userAgent },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      await res.body?.cancel();
      current = new URL(res.headers.get('location'), current).toString();
      const host = hostOf(current);
      if (host && !sameSite(host, base)) {
        foreignHop = host;
        return { status: res.status, body: '', finalUrl: current, foreignHop };
      }
      continue;
    }
    const body = (await res.text()).slice(0, 2_000_000);
    return { status: res.status, body, finalUrl: current, foreignHop };
  }
  throw new Error('too many redirects');
}

// External hosts referenced by <script src>, <iframe src> and <link href>.
function externalDomains(html, base) {
  const hosts = new Set();
  const add = value => {
    if (!value || !/^(https?:)?\/\//i.test(value)) return;
    const host = hostOf(value.startsWith('//') ? `https:${value}` : value);
    if (host && !sameSite(host, base)) hosts.add(host.toLowerCase());
  };
  for (const m of html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']?([^"'\s>]+)/gi))
    add(m[1]);
  for (const m of html.matchAll(/<iframe\b[^>]*\bsrc\s*=\s*["']?([^"'\s>]+)/gi))
    add(m[1]);
  for (const m of html.matchAll(/<link\b[^>]*\bhref\s*=\s*["']?([^"'\s>]+)/gi))
    add(m[1]);
  return [...hosts].sort();
}

function visibleText(html) {
  return html
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .toLowerCase();
}

// Client-side redirects (meta refresh / location assignment) to other domains.
function clientRedirects(html, base) {
  const targets = [];
  for (const m of html.matchAll(
    /<meta[^>]+http-equiv=["']?refresh["']?[^>]*content=["'][^"']*url=([^"'>\s]+)/gi
  )) {
    targets.push(m[1]);
  }
  for (const m of html.matchAll(
    /location(?:\.href|\.replace\()?\s*=?\s*\(?["'](https?:\/\/[^"']+)["']/gi
  )) {
    targets.push(m[1]);
  }
  return targets.map(t => hostOf(t)).filter(h => h && !sameSite(h, base));
}

function spamHits(html, keywords) {
  const text = visibleText(html);
  return keywords.filter(k => {
    const re = new RegExp(
      `\\b${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
      'i'
    );
    return re.test(text);
  });
}

async function run(ctx) {
  const url = siteUrl(ctx.site);
  if (!url) throw new Error('no siteUrl or domain folder to derive it from');
  const base = hostOf(url);
  const findings = [];
  const domains = new Set();

  for (const [label, ua] of [
    ['visitor', BROWSER_UA],
    ['Googlebot', GOOGLEBOT_UA]
  ]) {
    const page = await fetchPage(`${url.replace(/\/$/, '')}/`, ua, base);
    if (page.foreignHop) {
      findings.push(
        finding(
          'alert',
          `homepage redirects ${label} to foreign domain ${page.foreignHop}`
        )
      );
      continue;
    }
    if (page.status >= 500) {
      findings.push(
        finding('alert', `homepage returns HTTP ${page.status} for ${label}`)
      );
    } else if (page.status >= 400) {
      // A WAF often refuses a fake Googlebot (reverse-DNS verification).
      findings.push(
        finding(
          label === 'Googlebot' ? 'info' : 'warn',
          `homepage returns HTTP ${page.status} for ${label}`
        )
      );
    }
    if (page.body.includes(CRITICAL_ERROR_MARKER)) {
      findings.push(
        finding('alert', 'homepage shows the WordPress critical-error page')
      );
    }
    for (const h of externalDomains(page.body, base)) domains.add(h);
    const redirects = clientRedirects(page.body, base);
    if (redirects.length > 0) {
      findings.push(
        finding(
          'alert',
          `client-side redirect to foreign domain for ${label}: ${list([...new Set(redirects)])}`
        )
      );
    }
    const spam = spamHits(page.body, ctx.config.spamKeywords);
    if (spam.length > 0) {
      findings.push(
        finding(
          'warn',
          `SEO-spam keyword(s) on homepage for ${label}: ${spam.join(', ')}`
        )
      );
    }
  }

  const current = [...domains].sort();
  if (ctx.baseline) {
    const fresh = setDiff(current, ctx.baseline.domains);
    if (fresh.length > 0) {
      findings.push(
        finding(
          'alert',
          `new external domain(s) loaded by the homepage: ${list(fresh)}`
        )
      );
    }
  }
  findings.push(
    finding('info', `external domains: ${current.join(', ') || 'none'}`)
  );
  return { findings, snapshot: { domains: current } };
}

module.exports = {
  id: 'public-site',
  title: 'Public site',
  needsSsh: false,
  run
};
