# Privacy Policy

wordpressMonitor is a personal, self-hosted tool. It is not offered to third
parties and has a single user: its owner.

## Data accessed

Using the Gmail API (scope `gmail.modify`), the tool reads emails under two
labels chosen by the owner (DMARC aggregate reports and WordPress notification
emails) and moves the processed ones to the trash.

## How data is used

- Emails are parsed locally on the owner's machine to build a report.
- Nothing is sent to any third party, and no data is shared, sold or used for
  advertising or analytics.
- OAuth credentials are stored locally in `config.json` (`gmail.auth`), which
  is excluded from version control.

## Retention

Reports and temporary files are stored locally and deleted automatically after
a few days (`retentionDays`).

## Revoking access

Access can be revoked at any time at
<https://myaccount.google.com/permissions>
