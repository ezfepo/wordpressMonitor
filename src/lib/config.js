/**
 * Single gitignored config/credentials file: config.json (see
 * config.json.example for every key, documented in README.md). Holds local
 * settings (retentionDays, Gmail labels, DMARC known senders) alongside
 * credentials (Gmail OAuth tokens, Hostinger API token) that used to live in
 * their own gmail-auth.json / hostinger-auth.json files.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const CONFIG_FILE = path.join(ROOT, 'config.json');

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return {};
  }
}

// Shallow-merges `patch` into the on-disk config and writes it back, so a
// concurrent edit to an unrelated key (e.g. while gmail:auth updates
// gmail.auth) isn't clobbered.
function updateConfig(patch) {
  const config = readConfig();
  fs.writeFileSync(
    CONFIG_FILE,
    JSON.stringify({ ...config, ...patch }, null, 2)
  );
}

module.exports = { CONFIG_FILE, readConfig, updateConfig };
