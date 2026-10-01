// Minimal MIME helpers shared by the mail parsers (no dependencies).

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

// Decodes RFC 2047 encoded words ("=?us-ascii?Q?...?=") in a header value.
function decodeHeader(value) {
  return (value || '')
    .replace(/(\?=)\s+(=\?)/g, '$1$2')
    .replace(/=\?([^?]+)\?([bq])\?([^?]*)\?=/gi, (_, charset, enc, text) => {
      const buf =
        enc.toLowerCase() === 'b'
          ? Buffer.from(text, 'base64')
          : Buffer.from(
              text
                .replace(/_/g, ' ')
                .replace(/=([0-9A-F]{2})/gi, (m, h) =>
                  String.fromCharCode(parseInt(h, 16))
                ),
              'latin1'
            );
      try {
        return new TextDecoder(charset).decode(buf);
      } catch {
        return buf.toString('utf8');
      }
    })
    .trim();
}

// Parses a raw RFC 822 message into { headers, text } (text/plain preferred,
// falling back to tag-stripped text/html).
function parseMessage(buf) {
  const { headers } = splitHeaders(buf);
  const parts = collectParts(buf);
  const plain = parts.find(p => p.type === 'text/plain' && !p.filename);
  const html = parts.find(p => p.type === 'text/html' && !p.filename);
  let text = '';
  if (plain) text = plain.data.toString('utf8');
  else if (html)
    text = html.data
      .toString('utf8')
      .replace(/<(style|script)[\s\S]*?<\/\1>/gi, '')
      .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n\s*\n+/g, '\n');
  return { headers, text: text.trim() };
}

module.exports = { splitHeaders, collectParts, decodeHeader, parseMessage };
