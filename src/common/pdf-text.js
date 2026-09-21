// Minimal PDF text extraction, no dependencies.
//
// This is deliberately not a PDF renderer. It does one job: pull the visible
// text out of a generated report like an Infinite Campus transcript, which uses
// ordinary Flate-compressed content streams and standard fonts. Scanned or
// image-only PDFs have no text to find, and PDFs using subset fonts with custom
// encodings can come back as gibberish - both are detected and reported rather
// than passed off as a successful read, because a silently mangled transcript
// is worse than an honest failure.

const ASCII = new TextDecoder('latin1');

/**
 * @param {ArrayBuffer|Uint8Array} data
 * @returns {Promise<{text: string, ok: boolean, reason: string|null, streams: number}>}
 */
export async function extractPdfText(data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);

  if (bytes.length < 5 || ASCII.decode(bytes.subarray(0, 5)) !== '%PDF-') {
    return { text: '', ok: false, reason: 'That file is not a PDF.', streams: 0 };
  }

  const chunks = [];
  let streams = 0;

  for (const { body, dict } of findStreams(bytes)) {
    let content = body;
    if (/\/FlateDecode/.test(dict)) {
      const inflated = await inflate(body);
      if (!inflated) continue;
      content = inflated;
    } else if (/\/DCTDecode|\/JPXDecode|\/CCITTFaxDecode|\/JBIG2Decode/.test(dict)) {
      continue; // an image, not text
    }
    const text = readTextOperators(ASCII.decode(content));
    if (text.trim()) {
      chunks.push(text);
      streams += 1;
    }
  }

  const text = chunks.join('\n');

  if (!text.trim()) {
    return {
      text: '',
      ok: false,
      streams,
      reason: 'No text layer found. This transcript is probably a scan or an image, so the ' +
              'words are pixels rather than characters. Copy the text from the portal instead.',
    };
  }

  if (looksLikeGibberish(text)) {
    return {
      text,
      ok: false,
      streams,
      reason: 'Text was found but it decoded as gibberish, which happens when a PDF embeds ' +
              'fonts with a custom character map. Copy the text from the portal instead.',
    };
  }

  return { text, ok: true, reason: null, streams };
}

/** Walk the file for `stream ... endstream` pairs and the dictionary before each. */
function* findStreams(bytes) {
  const STREAM = toBytes('stream');
  const ENDSTREAM = toBytes('endstream');
  let i = 0;

  while (i < bytes.length) {
    const start = indexOf(bytes, STREAM, i);
    if (start === -1) return;

    // The dictionary sits immediately before the keyword.
    const dictFrom = Math.max(0, start - 800);
    const dict = ASCII.decode(bytes.subarray(dictFrom, start));

    // Skip the EOL that must follow the keyword.
    let from = start + STREAM.length;
    if (bytes[from] === 0x0d) from += 1;
    if (bytes[from] === 0x0a) from += 1;

    const end = indexOf(bytes, ENDSTREAM, from);
    if (end === -1) return;

    // The EOL before `endstream` is delimiter, not payload. DecompressionStream
    // rejects a zlib stream with trailing bytes, so it has to come off.
    let stop = end;
    while (stop > from && (bytes[stop - 1] === 0x0a || bytes[stop - 1] === 0x0d)) stop -= 1;

    yield { body: bytes.subarray(from, stop), dict };
    i = end + ENDSTREAM.length;
  }
}

async function inflate(bytes) {
  // PDF Flate streams carry a zlib wrapper, but some writers emit raw deflate,
  // and some leave stray bytes on the end. Try each framing, then retry once
  // with a byte trimmed, which covers the common off-by-one padding.
  for (const format of ['deflate', 'deflate-raw']) {
    for (const trim of [0, 1]) {
      const slice = trim ? bytes.subarray(0, bytes.length - trim) : bytes;
      if (!slice.length) continue;
      try {
        const stream = new Blob([slice]).stream().pipeThrough(new DecompressionStream(format));
        const out = new Uint8Array(await new Response(stream).arrayBuffer());
        if (out.length) return out;
      } catch {
        // Try the next framing or trim.
      }
    }
  }
  return null;
}

/**
 * Pull strings out of a content stream's text-showing operators.
 * Tj and ' and " show one string; TJ shows an array of strings and kerning
 * numbers. Positioning operators become line breaks so the row structure a
 * transcript depends on survives.
 */
function readTextOperators(content) {
  const out = [];
  let i = 0;

  while (i < content.length) {
    const ch = content[i];

    if (ch === '(') {
      const { value, next } = readLiteralString(content, i);
      const op = peekOperator(content, next);
      if (op) out.push(value);
      i = next;
      continue;
    }

    if (ch === '<' && content[i + 1] !== '<') {
      const close = content.indexOf('>', i);
      if (close === -1) break;
      const hex = content.slice(i + 1, close).replace(/[^0-9a-f]/gi, '');
      const op = peekOperator(content, close + 1);
      if (op) out.push(hexToString(hex));
      i = close + 1;
      continue;
    }

    // Anything that moves the cursor to a new line ends the current row.
    if (/[A-Za-z*'"]/.test(ch)) {
      // Not \b: it fails after `T*`, because `*` is not a word character, and
      // losing T* loses every line break the transcript rows depend on.
      const m = content.slice(i).match(/^(T\*|Td|TD|Tm|TL|BT|ET)(?![A-Za-z0-9])/);
      if (m) {
        out.push('\n');
        i += m[1].length;
        continue;
      }
    }

    i += 1;
  }

  return out
    .join('')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n');
}

/** True when the next non-space token is a text-showing operator. */
function peekOperator(content, from) {
  const rest = content.slice(from, from + 24);
  return /^\s*(?:\][\s\d.-]*)?(?:TJ|Tj|'|")/.test(rest);
}

function readLiteralString(content, start) {
  let depth = 0;
  let out = '';
  let i = start;

  while (i < content.length) {
    const ch = content[i];

    if (ch === '\\') {
      const next = content[i + 1];
      const simple = { n: '\n', r: '\n', t: ' ', b: '', f: '', '(': '(', ')': ')', '\\': '\\' };
      if (next in simple) { out += simple[next]; i += 2; continue; }
      const octal = content.slice(i + 1, i + 4).match(/^[0-7]{1,3}/);
      if (octal) {
        out += String.fromCharCode(parseInt(octal[0], 8));
        i += 1 + octal[0].length;
        continue;
      }
      i += 2;
      continue;
    }

    if (ch === '(') { depth += 1; if (depth > 1) out += ch; i += 1; continue; }
    if (ch === ')') {
      depth -= 1;
      if (depth === 0) { i += 1; break; }
      out += ch;
      i += 1;
      continue;
    }

    out += ch;
    i += 1;
  }

  return { value: out, next: i };
}

function hexToString(hex) {
  let out = '';
  // UTF-16BE is common in hex strings; fall back to bytes when it looks 8-bit.
  const pairs = hex.length % 4 === 0 && /^(00|0[1-9a-f])/i.test(hex) ? 4 : 2;
  for (let i = 0; i + pairs <= hex.length; i += pairs) {
    const code = parseInt(hex.slice(i, i + pairs), 16);
    if (code) out += String.fromCharCode(code);
  }
  return out;
}

/** Subset fonts with custom encodings decode to noise; catch that. */
function looksLikeGibberish(text) {
  const sample = text.slice(0, 4000);
  const letters = (sample.match(/[A-Za-z]/g) || []).length;
  if (letters < 20) return true;
  const words = sample.split(/\s+/).filter((w) => /^[A-Za-z]{3,}$/.test(w));
  // A real transcript is full of ordinary words; noise produces almost none.
  return words.length < sample.length / 400;
}

const toBytes = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));

function indexOf(haystack, needle, from) {
  outer: for (let i = from; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}
