'use strict';

const hostinger = require('../hostinger');
const { finding } = require('./common');

/**
 * Backup freshness. As of this writing Hostinger's public API
 * (https://developers.hostinger.com) exposes backups only for VPS
 * (vps_backups_*), not for shared web hosting, so there is nothing to list
 * for these sites. The check therefore reports "unavailable" (like php-check
 * does without a token). When Hostinger adds a hosting-backups endpoint,
 * implement listBackups() in src/lib/hostinger.js and compare the newest
 * entry against security.maxBackupAgeDays here.
 */
async function run(ctx) {
  const reason = hostinger.isConfigured()
    ? 'Hostinger API has no backup endpoint for shared web hosting (only VPS)'
    : 'no hostinger.apiToken in config.json';
  void ctx;
  return {
    findings: [finding('info', `backups unavailable: ${reason}`)],
    snapshot: null,
    unavailable: true
  };
}

module.exports = {
  id: 'backups',
  title: 'Backups',
  needsSsh: false,
  run
};
