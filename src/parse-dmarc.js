/**
 * DMARC aggregate report parser.
 *
 * Usage:
 *   node src/parse-dmarc.js <file.b64|file.eml|file.xml|file.gz|file.zip>...
 *     [--out <path.json>] [--label <gmail label>]
 *
 * .b64 files hold a Gmail RAW message (base64url) named <messageId>.b64. The
 * MIME message is decoded, its zip/gzip/xml attachment extracted and the
 * report XML parsed. No dependencies. ZIP CRCs are deliberately not verified:
 * some senders ship archives with a bad CRC but readable content (a warning is
 * recorded instead of failing).
 *
 * Sources (IPs) are classified against config.json (dmarc.knownSources) using reverse DNS (hostname suffix or IP prefix):
 *   ok             - known sender, DKIM or SPF aligned
 *   known-unaligned - known sender, neither aligned
 *   unknown        - not a known sender (possible spoofing)
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const dns = require('node:dns').promises;
const { formatTimestamp } = require('./lib/format');

const ROOT = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const opts = { files: [], out: null, label: 'dmarc' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') {
      opts.out = argv[++i];
    } else if (argv[i] === '--label') {
      opts.label = argv[++i];
    } else {
      opts.files.push(argv[i]);
    }
  }
  return opts;
}

// ---- MIME -----------------------------------------------------------------

function splitHeaders(buf) {
  const text = buf.toString('latin1');
  const idx = text.search(/\r?\n\r?\n/);
  if (idx === -1) return { headers: {}, body: Buffer.alloc(0) };
  const sep = text.slice(idx).startsWith('\r\n\r\n') ? 4 : 2;
  const rawHeaders = text.slice(0, idx).replace(/\r?\n[ \t]+/g, ' ');
  const headers = {};
  for (const line of rawHeaders.split(/\r?\n/)) {
    const m = line.match(/^([^:]+):\s*(.*)$/);
    if (m) headers[m[1].toLowerCase()] = m[2];
  }
  return { headers, body: buf.subarray(idx + sep) };
}

function decodeBody(headers, body) {
  const enc = (headers['content-transfer-encoding'] || '').toLowerCase();
  if (enc === 'base64') {
    return Buffer.from(body.toString('latin1').replace(/\s+/g, ''), 'base64');
  }
  if (enc === 'quoted-printable') {
    const s = body
      .toString('latin1')
      .replace(/=\r?\n/g, '')
      .replace(/=([0-9A-F]{2})/gi, (_, h) =>
        String.fromCharCode(parseInt(h, 16))
      );
    return Buffer.from(s, 'latin1');
  }
  return body;
}

// Returns [{ type, filename, data }] for every leaf part.
function collectParts(buf, out = []) {
  const { headers, body } = splitHeaders(buf);
  const type = (headers['content-type'] || 'text/plain').toLowerCase();
  const boundary = type.includes('multipart/')
    ? (headers['content-type'].match(/boundary="?([^";]+)"?/i) || [])[1]
    : null;
  if (boundary) {
    const delim = `--${boundary}`;
    const text = body.toString('latin1');
    const chunks = text.split(delim).slice(1);
    for (const chunk of chunks) {
      if (chunk.startsWith('--')) break;
      collectParts(Buffer.from(chunk.replace(/^\r?\n/, ''), 'latin1'), out);
    }
    return out;
  }
  const disp = headers['content-disposition'] || '';
  const nameMatch = (disp + ' ' + (headers['content-type'] || '')).match(
    /(?:file)?name\*?="?([^";]+)"?/i
  );
  out.push({
    type: type.split(';')[0].trim(),
    filename: nameMatch ? nameMatch[1] : '',
    data: decodeBody(headers, body)
  });
  return out;
}

// ---- Archives -------------------------------------------------------------

function unzipFirst(buf, warnings) {
  if (buf.readUInt32LE(0) !== 0x04034b50) {
    throw new Error('not a ZIP local file header');
  }
  const flags = buf.readUInt16LE(6);
  const method = buf.readUInt16LE(8);
  const crc = buf.readUInt32LE(14);
  let compSize = buf.readUInt32LE(18);
  const nameLen = buf.readUInt16LE(26);
  const extraLen = buf.readUInt16LE(28);
  const start = 30 + nameLen + extraLen;
  if (flags & 0x08 || compSize === 0) {
    // Sizes live in the central directory / data descriptor; inflate to the end.
    compSize = buf.length - start;
  }
  const raw = buf.subarray(start, start + compSize);
  const data = method === 0 ? raw : zlib.inflateRawSync(raw);
  const actual = zlib.crc32 ? zlib.crc32(data) : null;
  if (crc && actual !== null && actual !== crc) {
    warnings.push('ZIP CRC mismatch (content read anyway)');
  }
  return data;
}

function extractXml(part, warnings) {
  const isZip =
    part.data.length >= 4 && part.data.readUInt32LE(0) === 0x04034b50;
  const isGz =
    !isZip &&
    part.data.length >= 2 &&
    part.data[0] === 0x1f &&
    part.data[1] === 0x8b;
  if (isZip) return unzipFirst(part.data, warnings).toString('utf8');
  if (isGz) return zlib.gunzipSync(part.data).toString('utf8');
  return part.data.toString('utf8');
}

// ---- XML ------------------------------------------------------------------

function tag(xml, name) {
  const m = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return m ? m[1].trim() : null;
}

function blocks(xml, name) {
  return [
    ...xml.matchAll(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'g'))
  ].map(m => m[1]);
}

function parseReportXml(xml) {
  const meta = tag(xml, 'report_metadata') || '';
  const pol = tag(xml, 'policy_published') || '';
  const range = tag(meta, 'date_range') || '';
  const toIso = s => (s ? new Date(Number(s) * 1000).toISOString() : null);
  const records = blocks(xml, 'record').map(rec => {
    const row = tag(rec, 'row') || '';
    const eval_ = tag(row, 'policy_evaluated') || '';
    const ids = tag(rec, 'identifiers') || '';
    const auth = tag(rec, 'auth_results') || '';
    return {
      ip: tag(row, 'source_ip'),
      count: Number(tag(row, 'count') || 0),
      disposition: tag(eval_, 'disposition'),
      dkimEval: tag(eval_, 'dkim'),
      spfEval: tag(eval_, 'spf'),
      headerFrom: tag(ids, 'header_from'),
      dkim: blocks(auth, 'dkim').map(d => ({
        domain: tag(d, 'domain'),
        selector: tag(d, 'selector'),
        result: tag(d, 'result')
      })),
      spf: blocks(auth, 'spf').map(s => ({
        domain: tag(s, 'domain'),
        result: tag(s, 'result')
      }))
    };
  });
  return {
    org: tag(meta, 'org_name'),
    reportId: tag(meta, 'report_id'),
    domain: tag(pol, 'domain'),
    policy: {
      p: tag(pol, 'p'),
      sp: tag(pol, 'sp'),
      pct: tag(pol, 'pct'),
      adkim: tag(pol, 'adkim'),
      aspf: tag(pol, 'aspf')
    },
    dateBegin: toIso(tag(range, 'begin')),
    dateEnd: toIso(tag(range, 'end')),
    records
  };
}

// ---- Loading a file -------------------------------------------------------

function loadReportFromFile(file) {
  const warnings = [];
  const base = path.basename(file);
  const messageId = base.replace(/\.[^.]+$/, '');
  const buf = fs.readFileSync(file);
  let xml;
  if (/\.b64$/i.test(file)) {
    const mime = Buffer.from(buf.toString('utf8').trim(), 'base64url');
    const part = collectParts(mime).find(
      p => /zip|gzip|xml/.test(p.type) || /\.(zip|gz|xml)$/i.test(p.filename)
    );
    if (!part) throw new Error('no DMARC attachment found');
    xml = extractXml(part, warnings);
  } else if (/\.eml$/i.test(file)) {
    const part = collectParts(buf).find(
      p => /zip|gzip|xml/.test(p.type) || /\.(zip|gz|xml)$/i.test(p.filename)
    );
    if (!part) throw new Error('no DMARC attachment found');
    xml = extractXml(part, warnings);
  } else {
    xml = extractXml({ type: '', filename: base, data: buf }, warnings);
  }
  const report = parseReportXml(xml);
  if (!report.domain || report.records.length === 0) {
    throw new Error('XML is not a recognizable DMARC aggregate report');
  }
  return { messageId, warnings, ...report };
}

// ---- Classification -------------------------------------------------------

function loadSources() {
  try {
    const config = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')
    );
    return config.dmarc?.knownSources || [];
  } catch {
    return [];
  }
}

async function reverseName(ip) {
  try {
    return (await dns.reverse(ip))[0] || null;
  } catch {
    return null;
  }
}

function classify(sources, ip, ptr, aligned) {
  for (const src of sources) {
    const hit = src.match.some(re => {
      const rx = new RegExp(re, 'i');
      return rx.test(ip) || (ptr && rx.test(ptr));
    });
    if (hit) {
      return {
        sender: src.name,
        class: aligned ? 'ok' : 'known-unaligned'
      };
    }
  }
  return { sender: null, class: 'unknown' };
}

async function buildOutput(files, label) {
  const sources = loadSources();
  const reports = [];
  const failed = [];
  for (const file of files) {
    try {
      reports.push(loadReportFromFile(file));
    } catch (err) {
      failed.push({
        messageId: path.basename(file).replace(/\.[^.]+$/, ''),
        error: err.message
      });
    }
  }

  const ptrCache = new Map();
  const domains = new Map();
  let total = 0;
  let alignedTotal = 0;
  let rejected = 0;
  let unknownVolume = 0;
  const bySource = new Map();

  for (const rep of reports) {
    let d = domains.get(rep.domain);
    if (!d) {
      d = {
        domain: rep.domain,
        policy: rep.policy,
        status: 'ok',
        sources: new Map()
      };
      domains.set(rep.domain, d);
    }
    for (const rec of rep.records) {
      const aligned = rec.dkimEval === 'pass' || rec.spfEval === 'pass';
      if (!ptrCache.has(rec.ip))
        ptrCache.set(rec.ip, await reverseName(rec.ip));
      const ptr = ptrCache.get(rec.ip);
      const cls = classify(sources, rec.ip, ptr, aligned);
      total += rec.count;
      if (aligned) alignedTotal += rec.count;
      if (rec.disposition && rec.disposition !== 'none') rejected += rec.count;
      if (cls.class === 'unknown') unknownVolume += rec.count;
      const key = `${rep.domain}|${rec.ip}`;
      const cur = d.sources.get(key) || {
        ip: rec.ip,
        ptr,
        sender: cls.sender,
        class: cls.class,
        count: 0,
        aligned: 0,
        dkimAligned: 0,
        spfAligned: 0,
        disposition: {}
      };
      cur.count += rec.count;
      if (aligned) cur.aligned += rec.count;
      if (rec.dkimEval === 'pass') cur.dkimAligned += rec.count;
      if (rec.spfEval === 'pass') cur.spfAligned += rec.count;
      cur.disposition[rec.disposition] =
        (cur.disposition[rec.disposition] || 0) + rec.count;
      // A source is only "ok" if every record from it aligned.
      if (cls.class !== 'ok' && cur.class === 'ok') cur.class = cls.class;
      d.sources.set(key, cur);
      bySource.set(rec.ip, (bySource.get(rec.ip) || 0) + rec.count);
    }
  }

  const domainList = [...domains.values()].map(d => {
    const srcs = [...d.sources.values()].sort((a, b) => b.count - a.count);
    let status = 'ok';
    if (srcs.some(s => s.class === 'unknown')) status = 'alert';
    else if (srcs.some(s => s.class === 'known-unaligned'))
      status = 'attention';
    return { domain: d.domain, policy: d.policy, status, sources: srcs };
  });

  const dates = reports
    .flatMap(r => [r.dateBegin, r.dateEnd])
    .filter(Boolean)
    .sort();
  const highlights = {
    reports: reports.length,
    messages: total,
    alignedPct: total ? Math.round((alignedTotal / total) * 1000) / 10 : null,
    rejectedOrQuarantined: rejected,
    unknownSourceMessages: unknownVolume,
    topSources: [...bySource.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([ip, count]) => ({ ip, count, ptr: ptrCache.get(ip) || null })),
    attentionDomains: domainList
      .filter(d => d.status === 'attention')
      .map(d => d.domain),
    alertDomains: domainList
      .filter(d => d.status === 'alert')
      .map(d => d.domain),
    dateBegin: dates[0] || null,
    dateEnd: dates[dates.length - 1] || null
  };

  return {
    timestamp: new Date().toISOString(),
    generatedAt: formatTimestamp(new Date()),
    label,
    highlights,
    reports,
    domains: domainList,
    failed
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.files.length === 0) {
    throw new Error('usage: node src/parse-dmarc.js <files...> [--out file]');
  }
  const out = await buildOutput(opts.files, opts.label);
  const json = JSON.stringify(out, null, 2);
  if (opts.out) {
    fs.mkdirSync(path.dirname(path.resolve(opts.out)), { recursive: true });
    fs.writeFileSync(opts.out, json);
    console.log(
      `Parsed ${out.reports.length} report(s), ${out.failed.length} failed -> ${opts.out}`
    );
  } else {
    console.log(json);
  }
  const warns = out.reports.flatMap(r =>
    r.warnings.map(w => `${r.messageId}: ${w}`)
  );
  for (const w of warns) console.warn(`warning: ${w}`);
}

if (require.main === module) {
  main().catch(err => {
    console.error(`parse-dmarc error: ${err.message}`);
    process.exitCode = 1;
  });
}

module.exports = { buildOutput };
