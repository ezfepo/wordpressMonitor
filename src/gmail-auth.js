/**
 * One-time Gmail OAuth consent (Desktop app client, loopback redirect).
 *
 * Usage: npm run gmail:auth
 *
 * Prerequisite: a Google Cloud project with the Gmail API enabled and an OAuth
 * client of type "Desktop app". On first run it asks for the client id/secret
 * (or reads them from config.json's existing "gmail.auth"), opens the consent
 * page and saves the refresh token to config.json (gitignored).
 *
 * Tip: publish the consent screen "In production" (no verification needed for
 * personal use). In "Testing" mode the refresh token expires after 7 days.
 */

const http = require('node:http');
const readline = require('node:readline/promises');
const { execFile } = require('node:child_process');
const { SCOPE, TOKEN_URL } = require('./lib/gmail');
const { readConfig, updateConfig } = require('./lib/config');

function existing() {
  return readConfig().gmail?.auth || {};
}

function openBrowser(url) {
  if (process.platform === 'win32') {
    // The empty "" is start's window-title argument; & must stay quoted.
    execFile('cmd', ['/c', 'start', '""', url.replace(/&/g, '^&')]);
  } else {
    execFile(process.platform === 'darwin' ? 'open' : 'xdg-open', [url]);
  }
}

async function main() {
  const auth = existing();
  if (!auth.clientId || !auth.clientSecret) {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
    auth.clientId = (await rl.question('OAuth client id: ')).trim();
    auth.clientSecret = (await rl.question('OAuth client secret: ')).trim();
    rl.close();
  }

  const server = http.createServer();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const redirect = `http://127.0.0.1:${server.address().port}`;

  const consent = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  consent.search = new URLSearchParams({
    client_id: auth.clientId,
    redirect_uri: redirect,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent'
  }).toString();

  console.log('Opening the consent page. If it does not open, visit:');
  console.log(consent.href);
  openBrowser(consent.href);

  const code = await new Promise((resolve, reject) => {
    server.on('request', (req, res) => {
      const url = new URL(req.url, redirect);
      const err = url.searchParams.get('error');
      const c = url.searchParams.get('code');
      if (!c && !err) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(err ? `Error: ${err}` : 'Done. You can close this tab.');
      err ? reject(new Error(err)) : resolve(c);
    });
  });
  server.close();

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: auth.clientId,
      client_secret: auth.clientSecret,
      redirect_uri: redirect,
      grant_type: 'authorization_code'
    })
  });
  const json = await res.json();
  if (!res.ok || !json.refresh_token) {
    throw new Error(
      `Token exchange failed: ${json.error_description || json.error || 'no refresh_token returned'}`
    );
  }
  auth.refreshToken = json.refresh_token;
  const config = readConfig();
  updateConfig({ gmail: { ...config.gmail, auth } });
  console.log('Saved gmail.auth to config.json');
}

main().catch(err => {
  console.error(`gmail-auth error: ${err.message}`);
  process.exitCode = 1;
});
