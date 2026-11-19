'use strict';

const { finding, wpEval, list } = require('./common');

const PHP = `
$caps = ['manage_options','activate_plugins','install_plugins','edit_plugins','edit_users','create_users','promote_users'];
$out = [];
foreach (get_users(['number' => 500, 'orderby' => 'ID']) as $u) {
  $isRole = in_array('administrator', (array) $u->roles, true);
  $priv = false;
  foreach ($caps as $c) { if ($u->has_cap($c)) { $priv = true; break; } }
  if (!$isRole && !$priv) { continue; }
  $app = class_exists('WP_Application_Passwords')
    ? count(WP_Application_Passwords::get_user_application_passwords($u->ID)) : 0;
  $out[] = [
    'id' => (int) $u->ID,
    'login' => $u->user_login,
    'email' => $u->user_email,
    'registered' => $u->user_registered,
    'roles' => array_values((array) $u->roles),
    'adminRole' => $isRole,
    'passSig' => sha1($u->user_pass),
    'appPasswords' => $app
  ];
}
return $out;
`;

const FIELDS = ['login', 'email', 'roles', 'passSig'];

async function run(ctx) {
  const users = await wpEval(ctx, PHP);
  const findings = [];
  const admins = users.filter(u => u.adminRole);
  const base = ctx.baseline?.admins || null;

  for (const u of admins) {
    findings.push(
      finding(
        'info',
        `admin ID ${u.id} ${u.login} <${u.email}> registered ${u.registered}, ${u.appPasswords} application password(s)`
      )
    );
  }

  if (admins.length !== ctx.config.expectedAdmins) {
    findings.push(
      finding(
        'alert',
        `${admins.length} administrators (expected ${ctx.config.expectedAdmins})`
      )
    );
  }

  // Capability-based admins without the administrator role.
  for (const u of users.filter(x => !x.adminRole)) {
    if (!base || !base[u.id]) {
      findings.push(
        finding(
          'alert',
          `user ${u.login} (ID ${u.id}, role ${u.roles.join('/') || 'none'}) has administrator capabilities`
        )
      );
    }
  }

  const appTotal = users.reduce((n, u) => n + u.appPasswords, 0);
  const appBase = ctx.baseline?.appPasswords ?? 0;
  if (appTotal > appBase) {
    const who = users
      .filter(u => u.appPasswords > 0)
      .map(u => `${u.login} (${u.appPasswords})`);
    findings.push(
      finding('alert', `unexpected application password(s): ${list(who)}`)
    );
  }

  if (base) {
    const current = new Map(users.map(u => [String(u.id), u]));
    for (const [id, old] of Object.entries(base)) {
      const now = current.get(id);
      if (!now) {
        findings.push(
          finding('alert', `administrator removed: ${old.login} (ID ${id})`)
        );
        continue;
      }
      const changed = FIELDS.filter(
        f => JSON.stringify(old[f]) !== JSON.stringify(now[f])
      ).map(f => (f === 'passSig' ? 'password' : f));
      if (changed.length > 0) {
        findings.push(
          finding(
            'alert',
            `administrator modified: ${now.login} (ID ${id}): ${changed.join(', ')}`
          )
        );
      }
    }
    for (const u of admins) {
      if (!base[u.id]) {
        findings.push(
          finding(
            'alert',
            `new administrator: ${u.login} (ID ${u.id}, registered ${u.registered})`
          )
        );
      }
    }
  }

  const snapshot = {
    admins: Object.fromEntries(
      users.map(u => [
        u.id,
        {
          login: u.login,
          email: u.email,
          registered: u.registered,
          roles: u.roles,
          passSig: u.passSig
        }
      ])
    ),
    appPasswords: appTotal
  };
  return { findings, snapshot };
}

module.exports = {
  id: 'admins',
  title: 'Administrators',
  needsSsh: true,
  run
};
