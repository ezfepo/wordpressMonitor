/**
 * Minimal Gmail API client (plain fetch, no dependencies).
 *
 * Credentials live in gmail-auth.json (gitignored, created by
 * `npm run gmail:auth`): { clientId, clientSecret, refreshToken }.
 * Scope gmail.modify is needed to trash threads.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const AUTH_FILE = path.join(ROOT, 'gmail-auth.json');
const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/gmail.modify';

function loadAuth() {
  try {
    return JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
  } catch {
    throw new Error('gmail-auth.json not found. Run: npm run gmail:auth');
  }
}

let cached = null;

async function accessToken() {
  if (cached && cached.expires > Date.now() + 30_000) return cached.token;
  const auth = loadAuth();
  if (!auth.refreshToken) {
    throw new Error(
      'gmail-auth.json has no refreshToken. Run: npm run gmail:auth'
    );
  }
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: auth.clientId,
      client_secret: auth.clientSecret,
      refresh_token: auth.refreshToken,
      grant_type: 'refresh_token'
    })
  });
  const json = await res.json();
  if (!res.ok) {
    const hint =
      json.error === 'invalid_grant'
        ? ' (refresh token expired or revoked: run npm run gmail:auth)'
        : '';
    throw new Error(
      `Gmail token refresh failed: ${json.error_description || json.error}${hint}`
    );
  }
  cached = {
    token: json.access_token,
    expires: Date.now() + json.expires_in * 1000
  };
  return cached.token;
}

async function api(method, endpoint, query) {
  const url = new URL(`${API}${endpoint}`);
  for (const [k, v] of Object.entries(query || {})) {
    for (const item of [].concat(v)) url.searchParams.append(k, item);
  }
  const res = await fetch(url, {
    method,
    headers: { authorization: `Bearer ${await accessToken()}` }
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      `Gmail ${method} ${endpoint}: ${res.status} ${json.error?.message || ''}`.trim()
    );
  }
  return json;
}

async function findLabelId(name) {
  const { labels = [] } = await api('GET', '/labels');
  const hit = labels.find(l => l.name.toLowerCase() === name.toLowerCase());
  return hit ? hit.id : null;
}

async function listThreadIds(labelId) {
  const ids = [];
  let pageToken;
  do {
    const page = await api('GET', '/threads', {
      labelIds: labelId,
      maxResults: 100,
      ...(pageToken ? { pageToken } : {})
    });
    ids.push(...(page.threads || []).map(t => t.id));
    pageToken = page.nextPageToken;
  } while (pageToken);
  return ids;
}

async function getThreadMessageIds(threadId) {
  const t = await api('GET', `/threads/${threadId}`, { format: 'minimal' });
  return (t.messages || []).map(m => m.id);
}

// Returns the RFC 822 message as base64url (what parse-dmarc.js expects).
async function getRawMessage(messageId) {
  const m = await api('GET', `/messages/${messageId}`, { format: 'raw' });
  return m.raw;
}

async function trashThread(threadId) {
  await api('POST', `/threads/${threadId}/trash`);
}

module.exports = {
  AUTH_FILE,
  SCOPE,
  TOKEN_URL,
  findLabelId,
  listThreadIds,
  getThreadMessageIds,
  getRawMessage,
  trashThread
};
