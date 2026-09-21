// Generates the extension icons without any dependency: raw RGBA -> PNG.
// Run: node tools/make-icons.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(root, 'icons');
mkdirSync(OUT, { recursive: true });

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

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // colour type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A rounded square with three rising bars: a gradebook trending up. */
function draw(size) {
  const buf = Buffer.alloc(size * size * 4);
  const bg = [26, 107, 74, 255];      // --accent
  const fg = [244, 252, 248, 255];
  const radius = size * 0.22;

  const set = (x, y, c) => {
    const i = (y * size + x) * 4;
    buf[i] = c[0]; buf[i + 1] = c[1]; buf[i + 2] = c[2]; buf[i + 3] = c[3];
  };

  const inRounded = (x, y) => {
    const r = radius;
    const cx = Math.min(Math.max(x, r), size - r);
    const cy = Math.min(Math.max(y, r), size - r);
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r || (x >= r && x <= size - r) || (y >= r && y <= size - r);
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      set(x, y, inRounded(x + 0.5, y + 0.5) ? bg : [0, 0, 0, 0]);
    }
  }

  // Three bars of increasing height.
  const pad = Math.round(size * 0.24);
  const barW = Math.max(1, Math.round(size * 0.13));
  const gap = Math.max(1, Math.round(size * 0.07));
  const baseY = size - pad;
  const heights = [0.22, 0.38, 0.54].map((h) => Math.round(size * h));

  let x0 = pad;
  for (const h of heights) {
    for (let x = x0; x < x0 + barW && x < size; x++) {
      for (let y = baseY - h; y < baseY; y++) {
        if (y >= 0 && y < size) set(x, y, fg);
      }
    }
    x0 += barW + gap;
  }

  return buf;
}

for (const size of [16, 32, 48, 128]) {
  writeFileSync(join(OUT, `icon${size}.png`), png(size, size, draw(size)));
  console.log(`icons/icon${size}.png`);
}
