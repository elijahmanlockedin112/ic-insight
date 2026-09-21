// Packages just the runtime files into dist/ic-insight-v<version>.zip, for a
// GitHub release or a Chrome Web Store upload. Dev files (tests, tools, CI,
// docs) are left out. Zero dependencies: a small ZIP writer over node:zlib.
//
// Run: npm run build
import { deflateRawSync } from 'node:zlib';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));

// Only what Chrome actually needs at runtime.
const INCLUDE = ['manifest.json', 'src', 'icons', 'LICENSE'];
const SKIP = /(^|[\\/])(node_modules|\.git|dist|test|tools|\.github)([\\/]|$)/;

function collect(entry) {
  const abs = join(root, entry);
  const st = statSync(abs);
  if (st.isFile()) return [abs];
  return readdirSync(abs).flatMap((child) => {
    const p = join(abs, child);
    if (SKIP.test(relative(root, p))) return [];
    return statSync(p).isDirectory() ? collect(relative(root, p)) : [p];
  });
}

const files = INCLUDE.flatMap(collect).sort();

// ------------------------------------------------------------- zip internals

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

/** MS-DOS date/time, which is what the ZIP format stores. */
function dosTime(d = new Date()) {
  const time = ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() / 2) & 31);
  const date = (((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31);
  return { time, date };
}

function buildZip(entries) {
  const { time, date } = dosTime();
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const { name, data } of entries) {
    const compressed = deflateRawSync(data, { level: 9 });
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);          // version needed
    local.writeUInt16LE(0, 6);           // flags
    local.writeUInt16LE(8, 8);           // method: deflate
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);          // extra field length
    locals.push(local, nameBuf, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);        // version made by
    central.writeUInt16LE(20, 6);        // version needed
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);        // extra
    central.writeUInt16LE(0, 32);        // comment
    central.writeUInt16LE(0, 34);        // disk number start
    central.writeUInt16LE(0, 36);        // internal attributes
    central.writeUInt32LE(0, 38);        // external attributes
    central.writeUInt32LE(offset, 42);   // local header offset
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + compressed.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuf, eocd]);
}

// -------------------------------------------------------------------- write

const entries = files.map((abs) => ({
  // ZIP paths always use forward slashes, whatever the host OS does.
  name: relative(root, abs).split(sep).join('/'),
  data: readFileSync(abs),
}));

mkdirSync(join(root, 'dist'), { recursive: true });
const out = join(root, 'dist', `ic-insight-v${manifest.version}.zip`);
const zip = buildZip(entries);
writeFileSync(out, zip);

console.log(`${entries.length} files -> dist/ic-insight-v${manifest.version}.zip (${(zip.length / 1024).toFixed(1)} KB)`);
for (const e of entries) console.log(`  ${e.name}`);
