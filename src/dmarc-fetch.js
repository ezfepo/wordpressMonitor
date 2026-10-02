/**
 * DMARC step without Claude: Gmail API -> parse-dmarc -> reports/<ts>-dmarc.json.
 *
 * Usage: node src/dmarc-fetch.js [--dry-run]
 *
 * Reads the threads under the dmarc label (config.json -> gmail.labels.dmarc),
 * saves each raw message to .claude/tmp/dmarc/, parses them, adds a rule-based
 * `narrative` and trashes the threads that parsed fine (recoverable 30 days).
 * --dry-run trashes nothing, so it can be repeated.
 */

const fs = require('node:fs');
const path = require('node:path');
const gmail = require('./lib/gmail');
const { timestampSlug } = require('./lib/format');
const { readConfig } = require('./lib/config');
const { buildOutput } = require('./parse-dmarc');

const ROOT = path.resolve(__dirname, '..');
const TMP = path.join(ROOT, '.claude', 'tmp', 'dmarc');
const REPORTS = path.join(ROOT, 'reports');

function loadLabel() {
  return readConfig().gmail?.labels?.dmarc || 'dmarc';
}

function narrativeFor(out) {
  const h = out.highlights;
  const lines = [];
  if (h.reports === 0) {
    lines.push('No DMARC reports could be parsed.');
  } else {
    lines.push(
      `${h.reports} report(s) covering ${h.messages} message(s); ${h.alignedPct}% aligned (DKIM or SPF).`
    );
  }
  if (h.alertDomains.length) {
    const unknown = out.domains
      .filter(d => d.status === 'alert')
      .map(d => {
        const ips = d.sources
          .filter(s => s.class === 'unknown')
          .map(s => `${s.ip}${s.ptr ? ` (${s.ptr})` : ''}`);
        return `${d.domain}: ${ips.join(', ')}`;
      });
    lines.push(
      `Unknown sources are sending as your domain (${h.unknownSourceMessages} message(s)). Check whether they are legitimate, or spoofing: ${unknown.join('; ')}.`
    );
  }
  if (h.attentionDomains.length) {
    const items = out.domains
      .filter(d => d.status === 'attention')
      .map(
        d =>
          `${d.domain}: ${d.sources
            .filter(s => s.class === 'known-unaligned')
            .map(s => s.sender)
            .join(', ')}`
      );
    lines.push(
      `Known senders failing alignment, fix SPF/DKIM for them: ${items.join('; ')}.`
    );
  }
  if (h.rejectedOrQuarantined > 0) {
    lines.push(
      `${h.rejectedOrQuarantined} message(s) were quarantined or rejected by receivers.`
    );
  }
  if (h.reports > 0 && !h.alertDomains.length && !h.attentionDomains.length) {
    const weak = out.domains
      .filter(d => !d.policy.p || d.policy.p === 'none')
      .map(d => d.domain);
    lines.push(
      weak.length
        ? `All sources are known and aligned. It looks safe to tighten the policy (quarantine/reject) for: ${weak.join(', ')}.`
        : 'All sources are known and aligned; policies are already enforcing.'
    );
  } else if (h.reports > 0) {
    lines.push('Not yet safe to tighten the DMARC policy.');
  }
  if (out.failed.length) {
    lines.push(
      `${out.failed.length} message(s) could not be parsed and were left in Gmail.`
    );
  }
  return lines;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const label = loadLabel();
  const stamp = timestampSlug(new Date());
  const outFile = path.join(REPORTS, `${stamp}-dmarc.json`);
  fs.mkdirSync(REPORTS, { recursive: true });

  const labelId = await gmail.findLabelId(label);
  if (!labelId) throw new Error(`Gmail label "${label}" not found`);
  const threadIds = await gmail.listThreadIds(labelId);
  if (threadIds.length === 0) {
    fs.writeFileSync(
      outFile,
      JSON.stringify({ reports: [], note: 'No new DMARC reports.' }, null, 2)
    );
    console.log('No new DMARC reports.');
    return;
  }

  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  const threadOf = new Map(); // messageId -> threadId
  const files = [];
  for (const threadId of threadIds) {
    for (const messageId of await gmail.getThreadMessageIds(threadId)) {
      const file = path.join(TMP, `${stamp}-${messageId}.b64`);
      fs.writeFileSync(file, await gmail.getRawMessage(messageId));
      threadOf.set(messageId, threadId);
      files.push(file);
    }
  }

  const out = await buildOutput(files, label);
  out.narrative = narrativeFor(out);

  // Only trash threads whose every message parsed.
  const failedThreads = new Set(out.failed.map(f => threadOf.get(f.messageId)));
  const toTrash = threadIds.filter(id => !failedThreads.has(id));
  out.trashed = [];
  out.trashFailed = [];
  if (dryRun) {
    out.dryRun = true;
  } else {
    for (const id of toTrash) {
      try {
        await gmail.trashThread(id);
        out.trashed.push(id);
      } catch (err) {
        console.warn(`trash ${id}: ${err.message}`);
        out.trashFailed.push(id);
      }
    }
  }

  fs.writeFileSync(outFile, JSON.stringify(out, null, 2));
  console.log(
    `Parsed ${out.reports.length} report(s), ${out.failed.length} failed, ${out.trashed.length} trashed${dryRun ? ' (dry run)' : ''}.`
  );
  for (const d of out.domains) console.log(`  ${d.domain}: ${d.status}`);
  if (out.failed.length || out.trashFailed.length) process.exitCode = 1;
}

main().catch(err => {
  console.error(`dmarc-fetch error: ${err.message}`);
  process.exitCode = 1;
});
