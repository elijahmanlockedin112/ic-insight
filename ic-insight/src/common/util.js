// Small helpers shared by the service worker and the UI pages.

export const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

export function num(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const cleaned = String(v).replace(/[^0-9.\-]/g, '');
  if (cleaned === '' || cleaned === '-' || cleaned === '.') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

export function pct(earned, possible) {
  if (!possible || possible <= 0) return null;
  return (earned / possible) * 100;
}

export const round = (n, places = 2) =>
  n === null || n === undefined || !Number.isFinite(n)
    ? null
    : Math.round(n * 10 ** places) / 10 ** places;

export function parseDate(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

export const isoDay = (d = new Date()) => d.toISOString().slice(0, 10);

/** Least-squares slope of y over its own index. Units: y per step. */
export function slope(ys) {
  const n = ys.length;
  if (n < 3) return null;
  const meanX = (n - 1) / 2;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  let numr = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    numr += (i - meanX) * (ys[i] - meanY);
    den += (i - meanX) ** 2;
  }
  return den === 0 ? null : numr / den;
}

export const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/** Stable-ish id for records that arrive without one. */
export function hashId(...parts) {
  const s = parts.filter(Boolean).join('|');
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

export function uniqueBy(arr, keyFn) {
  const seen = new Map();
  for (const item of arr) {
    const k = keyFn(item);
    if (!seen.has(k)) seen.set(k, item);
  }
  return [...seen.values()];
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Default US letter-grade cutoffs, and the common flat 10-point scale. */
export const SCALES = {
  standard: [
    ['A', 93], ['A-', 90], ['B+', 87], ['B', 83], ['B-', 80],
    ['C+', 77], ['C', 73], ['C-', 70], ['D+', 67], ['D', 63], ['D-', 60], ['F', 0],
  ],
  tenPoint: [
    ['A', 90], ['B', 80], ['C', 70], ['D', 60], ['F', 0],
  ],
};

export const GPA_POINTS = {
  'A+': 4.0, A: 4.0, 'A-': 3.7,
  'B+': 3.3, B: 3.0, 'B-': 2.7,
  'C+': 2.3, C: 2.0, 'C-': 1.7,
  'D+': 1.3, D: 1.0, 'D-': 0.7,
  F: 0.0,
};

export function letterFor(percent, scaleName = 'standard') {
  if (percent === null || percent === undefined) return null;
  for (const [letter, floor] of SCALES[scaleName] || SCALES.standard) {
    if (percent >= floor) return letter;
  }
  return 'F';
}

/** The next letter up from `percent`, plus the percent needed to reach it. */
export function nextLetterUp(percent, scaleName = 'standard') {
  const scale = SCALES[scaleName] || SCALES.standard;
  let best = null;
  for (const [letter, floor] of scale) {
    if (floor > percent && (best === null || floor < best.floor)) best = { letter, floor };
  }
  return best;
}

/** How far above the next cutoff *down* we are — i.e. the safety cushion. */
export function cushion(percent, scaleName = 'standard') {
  const scale = SCALES[scaleName] || SCALES.standard;
  let floorBelow = 0;
  for (const [, floor] of scale) {
    if (percent >= floor) { floorBelow = floor; break; }
  }
  return round(percent - floorBelow, 2);
}

const HONORS_RE = /\b(honors?|hnrs|pre[- ]?ap|advanced|adv)\b/i;
const AP_RE = /\b(ap|a\.p\.|advanced placement|ib|international baccalaureate|de|dual (credit|enroll)|cambridge|aice)\b/i;

/** Rough rigor detection from a course title. Users can override per course. */
export function rigorOf(courseName = '') {
  if (AP_RE.test(courseName)) return 'ap';
  if (HONORS_RE.test(courseName)) return 'honors';
  return 'regular';
}

export const RIGOR_BUMP = { regular: 0, honors: 0.5, ap: 1.0 };
