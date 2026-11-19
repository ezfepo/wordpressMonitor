'use strict';

const tls = require('node:tls');
const hostinger = require('../hostinger');
const { siteUrl } = require('../ssh');
const { finding, hostOf, bare } = require('./common');

const TIMEOUT_MS = 15000;
const DAY_MS = 86400000;

function certExpiry(host) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect(
      { host, port: 443, servername: host, rejectUnauthorized: false },
      () => {
        const cert = socket.getPeerCertificate();
        const result = {
          validTo: cert?.valid_to ? new Date(cert.valid_to) : null,
          authorized: socket.authorized,
          error: socket.authorizationError || null
        };
        socket.end();
        resolve(result);
      }
    );
    socket.setTimeout(TIMEOUT_MS, () => {
      socket.destroy();
      reject(new Error('TLS connection timed out'));
    });
    socket.on('error', reject);
  });
}

// Domains of the Hostinger account, fetched once per run: domain -> expiry.
async function prepare(sites, shared) {
  shared.domains = null;
  if (!hostinger.isConfigured()) return;
  try {
    const list = await hostinger.listDomains();
    shared.domains = new Map(
      list
        .filter(d => d.domain && (d.expires_at || d.expiration_date))
        .map(d => [bare(d.domain), new Date(d.expires_at || d.expiration_date)])
    );
  } catch (err) {
    shared.domainsError = err.message;
  }
}

function expiryFinding(label, days, warn, alert) {
  if (days < 0) return finding('alert', `${label} expired ${-days} day(s) ago`);
  if (days < alert)
    return finding('alert', `${label} expires in ${days} day(s)`);
  if (days < warn) return finding('warn', `${label} expires in ${days} day(s)`);
  return null;
}

async function run(ctx) {
  const host = bare(hostOf(siteUrl(ctx.site)));
  if (!host) throw new Error('no siteUrl or domain folder to derive it from');
  const c = ctx.config;
  const findings = [];

  const cert = await certExpiry(host);
  if (!cert.validTo) {
    findings.push(finding('alert', 'could not read the TLS certificate'));
  } else {
    const days = Math.floor((cert.validTo - Date.now()) / DAY_MS);
    const f = expiryFinding(
      'TLS certificate',
      days,
      c.tlsWarnDays,
      c.tlsAlertDays
    );
    findings.push(
      f || finding('info', `TLS certificate valid for ${days} more day(s)`)
    );
    if (!cert.authorized && days >= 0) {
      findings.push(
        finding('alert', `TLS certificate not trusted: ${cert.error}`)
      );
    }
  }

  const domains = ctx.shared?.domains;
  if (domains) {
    const expires = [...domains.entries()].find(
      ([d]) => host === d || host.endsWith(`.${d}`)
    )?.[1];
    if (expires) {
      const days = Math.floor((expires - Date.now()) / DAY_MS);
      const f = expiryFinding(
        'domain registration',
        days,
        c.domainWarnDays,
        c.domainAlertDays
      );
      findings.push(
        f || finding('info', `domain registered for ${days} more day(s)`)
      );
    } else {
      findings.push(
        finding(
          'info',
          'domain is not in the Hostinger account (expiry not checked)'
        )
      );
    }
  } else if (ctx.shared?.domainsError) {
    findings.push(
      finding('info', `domain expiry unavailable: ${ctx.shared.domainsError}`)
    );
  }
  return { findings, snapshot: null };
}

module.exports = {
  id: 'tls',
  title: 'TLS and domain expiry',
  needsSsh: false,
  prepare,
  run
};
