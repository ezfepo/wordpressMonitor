'use strict';

// Registry, in the order checks run for each site.
const CHECKS = [
  require('./admins'),
  require('./options'),
  require('./integrity'),
  require('./uploads-cron'),
  require('./sucuri-audit'),
  require('./db-scan'),
  require('./public-site'),
  require('./exposed-files'),
  require('./backups'),
  require('./tls'),
  require('./abandoned')
];

module.exports = { CHECKS, CHECK_IDS: CHECKS.map(c => c.id) };
