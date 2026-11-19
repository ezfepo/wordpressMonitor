'use strict';

const { finding, wpEval, bare, hostOf, siteDomain } = require('./common');
const { siteUrl } = require('../ssh');

const PHP = `
return [
  'siteurl' => get_option('siteurl'),
  'home' => get_option('home'),
  'usersCanRegister' => (string) get_option('users_can_register'),
  'defaultRole' => get_option('default_role'),
  'adminEmail' => get_option('admin_email'),
  'newAdminEmail' => get_option('adminhash') ? 'pending' : ''
];
`;

async function run(ctx) {
  const o = await wpEval(ctx, PHP);
  const findings = [];
  const expected = bare(siteDomain(ctx.site) || hostOf(siteUrl(ctx.site)));

  for (const key of ['siteurl', 'home']) {
    const host = bare(hostOf(o[key]));
    if (expected && host !== expected) {
      findings.push(
        finding(
          'alert',
          `${key} ${o[key]} does not match the site domain ${expected}`
        )
      );
    }
  }
  if (o.usersCanRegister !== '0' && o.usersCanRegister !== '') {
    findings.push(finding('alert', 'users_can_register is enabled'));
  } else if (o.usersCanRegister === '') {
    // Option missing: WordPress treats it as disabled.
  }
  if (o.defaultRole === 'administrator') {
    findings.push(finding('alert', 'default_role is administrator'));
  }
  if (o.newAdminEmail === 'pending') {
    findings.push(
      finding('warn', 'an admin email change is pending confirmation')
    );
  }
  if (ctx.baseline && ctx.baseline.adminEmail !== o.adminEmail) {
    findings.push(
      finding(
        'alert',
        `admin_email changed: ${ctx.baseline.adminEmail} -> ${o.adminEmail}`
      )
    );
  }
  findings.push(
    finding(
      'info',
      `siteurl ${o.siteurl}, home ${o.home}, default_role ${o.defaultRole}, admin_email ${o.adminEmail}`
    )
  );
  return { findings, snapshot: { adminEmail: o.adminEmail } };
}

module.exports = {
  id: 'options',
  title: 'Core options',
  needsSsh: true,
  run
};
