'use strict';

/**
 * wpMon — per-site SSH connectivity/auth validator.
 *
 * Independent of WP-CLI: checks raw TCP reachability to host:port, then
 * attempts an SSH handshake + auth using the same credential resolution as
 * update-plugins.js. Prints the real underlying error per site (DNS, TCP
 * refused/timeout, handshake, auth) instead of a generic "unreachable".
 *
 * Usage:
 *   node src/check-ssh.js [--site <name>]
 */

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { Client } = require('ssh2');

const ROOT = path.resolve(__dirname, '..');
const SITES_FILE = path.join(ROOT, 'sites.json');
const TCP_TIMEOUT_MS = 10000;
const SSH_READY_TIMEOUT_MS = 20000;

function parseArgs(argv) {
  const args = { site: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--site') {
      args.site = argv[++i];
      if (!args.site) {
        throw new Error('--site requires a value');
      }
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function loadSites() {
  if (!fs.existsSync(SITES_FILE)) {
    throw new Error(`Missing sites.json at ${SITES_FILE}`);
  }
  const config = JSON.parse(fs.readFileSync(SITES_FILE, 'utf8'));
  if (!Array.isArray(config.sites) || config.sites.length === 0) {
    throw new Error('sites.json must contain a non-empty "sites" array');
  }
  return config.sites;
}

function credentialsForSite(site) {
  const { sshPassword, sshKeyPath, sshKeyPassphrase } = site;
  if (sshKeyPath) {
    if (!fs.existsSync(sshKeyPath)) {
      return { error: `SSH key not found at ${sshKeyPath} (sshKeyPath in sites.json)` };
    }
    return {
      credentials: {
        privateKey: fs.readFileSync(sshKeyPath, 'utf8'),
        passphrase: sshKeyPassphrase
      },
      source: `key:${sshKeyPath}`
    };
  }
  if (sshPassword) {
    return { credentials: { password: sshPassword }, source: 'password' };
  }
  return {
    error: 'No credentials set: expected sshPassword or sshKeyPath in sites.json'
  };
}

// Raw TCP probe so we can tell "host/port unreachable" apart from "SSH/auth
// rejected us" — ssh2 folds both into a generic connection error otherwise.
function checkTcp(host, port) {
  return new Promise(resolve => {
    const socket = new net.Socket();
    const timer = setTimeout(() => {
      socket.destroy();
      resolve({ ok: false, error: `TCP connect timed out after ${TCP_TIMEOUT_MS / 1000}s` });
    }, TCP_TIMEOUT_MS);

    socket
      .once('connect', () => {
        clearTimeout(timer);
        socket.destroy();
        resolve({ ok: true });
      })
      .once('error', err => {
        clearTimeout(timer);
        resolve({ ok: false, error: `${err.code || err.message}: ${err.message}` });
      })
      .connect(port, host);
  });
}

function checkSsh(site, credentials) {
  return new Promise(resolve => {
    const conn = new Client();
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    conn
      .on('ready', () => {
        conn.end();
        finish({ ok: true });
      })
      .on('error', err => {
        finish({
          ok: false,
          error: err.level ? `[${err.level}] ${err.message}` : err.message
        });
      })
      .connect({
        host: site.sshHost,
        port: site.sshPort || 22,
        username: site.sshUser,
        readyTimeout: SSH_READY_TIMEOUT_MS,
        ...credentials
      });
  });
}

async function checkSite(site) {
  const result = { site: site.name, host: site.sshHost, port: site.sshPort || 22 };

  const tcp = await checkTcp(site.sshHost, result.port);
  result.tcp = tcp.ok ? 'ok' : 'failed';
  if (!tcp.ok) {
    result.ok = false;
    result.error = `TCP: ${tcp.error}`;
    return result;
  }

  const credResult = credentialsForSite(site);
  if (credResult.error) {
    result.ok = false;
    result.error = `Credentials: ${credResult.error}`;
    return result;
  }
  result.credSource = credResult.source;

  const ssh = await checkSsh(site, credResult.credentials);
  result.ssh = ssh.ok ? 'ok' : 'failed';
  if (!ssh.ok) {
    result.ok = false;
    result.error = `SSH: ${ssh.error}`;
    return result;
  }

  result.ok = true;
  return result;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  let sites = loadSites();
  if (options.site) {
    sites = sites.filter(s => s.name === options.site);
    if (sites.length === 0) {
      throw new Error(`No site named "${options.site}" in sites.json`);
    }
  }

  console.log(`wpMon: validating SSH connectivity for ${sites.length} site(s)...\n`);

  const results = [];
  for (const site of sites) {
    process.stdout.write(`- ${site.name} (${site.sshHost}:${site.sshPort || 22})... `);
    const result = await checkSite(site);
    results.push(result);
    if (result.ok) {
      console.log(`OK (tcp: ok, auth: ${result.credSource}, ssh: ok)`);
    } else {
      console.log(`FAILED — ${result.error}`);
    }
  }

  console.log('\nSummary:');
  for (const r of results) {
    console.log(`  ${r.site}: ${r.ok ? 'OK' : 'FAILED — ' + r.error}`);
  }

  const anyFailure = results.some(r => !r.ok);
  process.exitCode = anyFailure ? 1 : 0;
}

main().catch(err => {
  console.error(`wpMon check-ssh error: ${err.message}`);
  process.exitCode = 1;
});
