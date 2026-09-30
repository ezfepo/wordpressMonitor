---
name: dmarc-check
description: Process DMARC aggregate reports from Gmail (label from config.json), parse them with src/parse-dmarc.js, write reports/dmarc-<ts>.json with highlights, and move the processed emails to trash. Use when the user asks to check or summarize DMARC reports or runs the wordpressMonitor DMARC step.
---

# DMARC check (wordpressMonitor)

Reads the DMARC aggregate report emails from Gmail, parses them and writes a
JSON result that `src/build-report.js` renders in the HTML report. **Do not
create Gmail drafts or emails.**

If the skill argument is `check-only`, do everything except step 6: **never
trash anything** (leave `trashed` empty and add `"dryRun": true` to the JSON), so
the same reports can be re-processed on the next run.

Let `<ts>` be the current local-time slug `YYYY-MM-DD-HHmmss`.

**Language:** everything you write — JSON text fields (`summary`, `narrative`, `reason`,
`note`, ...) and the final summary — must be in English.

## Steps

1. Read `config.json` -> `gmail.labels.dmarc` (default `dmarc`).
   Call `search_threads` with `label:"<label>"`.
2. No threads: write `reports/dmarc-<ts>.json` as
   `{ "reports": [], "note": "No new DMARC reports." }` and stop.
3. For each thread, `get_message` with `messageFormat: RAW` and save the raw
   field (base64**url**) to `.claude/tmp/dmarc/<messageId>.b64`. The Gmail
   connector has no attachment download, hence RAW.
4. Run `node src/parse-dmarc.js .claude/tmp/dmarc/*.b64 --out reports/dmarc-<ts>.json --label <label>`.
   It classifies each source IP (Titan / Hostinger shared / unknown, from
   `config.json` (`dmarc.knownSources`)), computes `highlights` and a per-domain status
   (`ok`, `attention`, `alert`). A ZIP CRC warning is not an error.
5. Read the JSON and add `narrative`: 3–6 short bullets in English saying what
   happened and what to do — unknown sources sending as the domain,
   legitimate senders that aren't aligned (e.g. shared Hostinger not in SPF),
   the alignment rate, whether it looks safe to tighten the policy
   (`quarantine`/`reject`) or not yet, and any reports that failed to parse.
   Save it back into the same file.
6. Trash only what was parsed successfully: for each message id that is in
   `reports` (not in `failed`), `trash_thread` its thread. Record
   `"trashed": [threadIds]` and `"trashFailed": [threadIds]` in the JSON.
   Messages in `failed` stay in Gmail.
7. Finish with a 3-5 line plain-text summary of the results only (reports parsed,
   domains and their status, what was trashed). Never mention emails, drafts,
   the HTML report or file paths in it; the runner handles all of that.

Gmail's trash is recoverable for 30 days.
