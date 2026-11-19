'use strict';

/**
 * Shared SSH / sites.json helpers (extracted from update-plugins.js so the
 * security checks reuse the exact same connection and WP-CLI plumbing).
 * Never log credentials: nothing here prints site config.
 */

const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('ssh2');

const ROOT = path.resolve(__dirname, '..', '..');
const SITES_FILE = path.join(ROOT, 'sites.json');
const SSH_READY_TIMEOUT_MS = 20000;
const COMMAND_TIMEOUT_MS = 300000;

function loadSites() {
  if (!fs.existsSync(SITES_FILE)) {
    throw new Error(`Missing sites.json at ${SITES_FILE}`);
  }
  const config = JSON.parse(fs.readFileSync(SITES_FILE, 'utf8'));
  if (!Array.isArray(config.sites) || config.sites.length === 0) {
    throw new Error('sites.json must contain a non-empty "sites" array');
  }
  for (const site of config.sites) {
    for (const field of ['name', 'sshHost', 'sshUser', 'wpPath']) {
      if (!site[field]) {
        throw new Error(
          `sites.json entry ${JSON.stringify(site.name || site)} is missing "${field}"`
        );
      }
    }
  }
  return config.sites;
}

function credentialsForSite(site) {
  const { sshPassword, sshKeyPath, sshKeyPassphrase } = site;
  if (sshKeyPath) {
    if (!fs.existsSync(sshKeyPath)) {
      throw new Error(
        `SSH key for site "${site.name}" not found at ${sshKeyPath} (sshKeyPath in sites.json)`
      );
    }
    return {
      privateKey: fs.readFileSync(sshKeyPath, 'utf8'),
      passphrase: sshKeyPassphrase
    };
  }
  if (sshPassword) {
    return { password: sshPassword };
  }
  throw new Error(
    `No credentials for site "${site.name}": set sshPassword or sshKeyPath in sites.json`
  );
}

function sshConnect(site, credentials) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    conn
      .on('ready', () => resolve(conn))
      .on('error', err =>
        reject(new Error(`SSH connection failed: ${err.message}`))
      )
      .connect({
        host: site.sshHost,
        port: site.sshPort || 22,
        username: site.sshUser,
        readyTimeout: SSH_READY_TIMEOUT_MS,
        ...credentials
      });
  });
}

// Runs one remote command. Rejects on timeout (and closes the stream, so the
// local side stops waiting; callers that run heavy commands also wrap them in
// the remote `timeout` so the process dies on the server too).
function execCommand(conn, command, { timeoutMs = COMMAND_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let stream = null;
    const timer = setTimeout(() => {
      try {
        stream?.close();
      } catch {
        // already closed
      }
      reject(
        new Error(
          `Command timed out after ${timeoutMs / 1000}s: ${command.slice(0, 120)}`
        )
      );
    }, timeoutMs);
    conn.exec(command, (err, s) => {
      if (err) {
        clearTimeout(timer);
        return reject(err);
      }
      stream = s;
      let stdout = '';
      let stderr = '';
      s.on('close', code => {
        clearTimeout(timer);
        resolve({ code: code ?? 0, stdout, stderr });
      }).on('data', data => {
        stdout += data.toString();
      });
      s.stderr.on('data', data => {
        stderr += data.toString();
      });
    });
  });
}

// WP-CLI can print PHP notices/warnings around the JSON payload; extract the
// outermost JSON array before parsing.
function parseWpJson(stdout, context) {
  const start = stdout.indexOf('[');
  const end = stdout.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) {
    throw new Error(
      `Could not parse WP-CLI JSON output (${context}): ${stdout.slice(0, 500)}`
    );
  }
  return JSON.parse(stdout.slice(start, end + 1));
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function wpCommand(site, args) {
  return `wp ${args} --path=${shellQuote(site.wpPath)} --skip-plugins --skip-themes`;
}

// Explicit siteUrl wins; otherwise derive it from the domain folder inside
// wpPath (domains/<domain>/public_html -> https://<domain>), the same
// derivation php-check.js and wp-mails-fetch.js already use. Returns null if
// neither is available.
function siteUrl(site) {
  if (site.siteUrl) {
    return site.siteUrl;
  }
  const domain = (site.wpPath || '').match(/domains\/([^/]+)/)?.[1];
  return domain ? `https://${domain}` : null;
}

const CRITICAL_ERROR_MARKER = 'There has been a critical error on this website';

module.exports = {
  ROOT,
  SITES_FILE,
  CRITICAL_ERROR_MARKER,
  loadSites,
  credentialsForSite,
  sshConnect,
  execCommand,
  parseWpJson,
  shellQuote,
  wpCommand,
  siteUrl
};
