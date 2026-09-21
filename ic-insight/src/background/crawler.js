// Plans what to request. The Governor in bridge.js decides whether and how fast.
//
// Infinite Campus API paths differ between districts and IC releases, so this
// does not assume it knows yours. It works in three passes:
//
//   1. Learn the shape. Every URL the portal fetched on its own is recorded, so
//      the base path ("/campus/api/portal/" vs "/campus/resources/portal/" vs a
//      district-specific prefix) is usually known before we ask for anything.
//   2. Ask for what is missing, one candidate at a time, ordered by how likely
//      it is to be right for the base we just learned.
//   3. Remember dead ends. A 404 is written down permanently, so a path that
//      does not exist on your install is requested exactly once, ever.
//
// That last rule is what separates this from probing: the request count for
// discovery is bounded and shrinks to zero as the extension learns your district.

const CANDIDATES = {
  identity: [
    'students',
    'portal/students',
    'my/demographics',
    'preferences/portal',
  ],
  roster: [
    'roster',
    'portal/roster',
    'grades',
    'students/{personID}/roster',
  ],
  grades: [
    'grades/detail/{personID}',
    'grades/{personID}',
    'portal/grades/detail/{personID}',
    'students/{personID}/grades',
  ],
  schedule: [
    'schedule',
    'schedule/{personID}',
    'portal/schedule',
    'roster/schedule',
  ],
  transcript: [
    'transcript?personID={personID}',
    'transcript/{personID}',
    'portal/transcript?personID={personID}',
    'students/{personID}/transcript',
  ],
  gpa: [
    'gpa/{personID}',
    'gpa',
    'portal/gpa/{personID}',
  ],
  assignments: [
    'grades/detail/{personID}?sectionID={sectionID}',
    'assignment/section/{sectionID}',
    'portal/assignment/section/{sectionID}',
  ],
};

// Used only when the portal has not shown us any API traffic yet.
const SEED_BASES = [
  '/campus/api/portal/',
  '/campus/resources/portal/',
  '/campus/api/',
  '/campus/resources/',
];

/**
 * Infer base paths from URLs the portal fetched itself.
 * A base learned this way is far more likely to be right than a seed guess.
 */
export function deriveBases(seenUrls, origin) {
  const counts = new Map();

  for (const raw of seenUrls || []) {
    let u;
    try { u = new URL(raw); } catch { continue; }
    if (u.origin !== origin) continue;

    const parts = u.pathname.split('/').filter(Boolean);
    const campusAt = parts.indexOf('campus');
    if (campusAt === -1) continue;

    // Keep the prefix up to and including the API segment, and at most one
    // grouping segment past it: /campus/api/ and /campus/api/portal/, but not
    // /campus/api/portal/students/ — that last one is a resource, not a base,
    // and treating it as one would cost a wasted 404 on every run.
    for (let end = campusAt + 2; end <= Math.min(parts.length - 1, campusAt + 3); end++) {
      const base = `/${parts.slice(0, end).join('/')}/`;
      if (!/\/(api|resources|prism)\//.test(base)) continue;
      counts.set(base, (counts.get(base) || 0) + 1);
    }
  }

  const learned = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([base]) => base);

  return [...new Set([...learned, ...SEED_BASES])].slice(0, 6);
}

const fill = (template, vars) =>
  template.replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? encodeURIComponent(vars[k]) : m));

const hasUnfilled = (s) => /\{\w+\}/.test(s);

function buildUrls(origin, bases, kind, vars, limit) {
  const out = [];
  for (const template of CANDIDATES[kind] || []) {
    const path = fill(template, vars);
    if (hasUnfilled(path)) continue; // missing a variable we do not know yet
    for (const base of bases) {
      out.push(origin + base.replace(/\/$/, '') + '/' + path.replace(/^\//, ''));
      if (out.length >= limit) return out;
    }
  }
  return out;
}

/** What the dataset still lacks, in the order worth fixing. */
export function gapsIn(data) {
  const gaps = [];
  const courses = data?.courses || [];
  if (!data?.student?.personID) gaps.push('identity');
  if (!courses.length) gaps.push('roster');
  if (!courses.some((c) => assignmentsIn(c) > 0)) gaps.push('grades');
  if (!(data?.schedule || []).length) gaps.push('schedule');
  if (!(data?.transcript || []).length) gaps.push('transcript');
  if (!data?.gpaSummary) gaps.push('gpa');
  return gaps;
}

const assignmentsIn = (course) =>
  (course.gradingTasks || []).reduce(
    (s, t) => s + (t.categories || []).reduce((n, c) => n + (c.assignments?.length ?? 0), 0), 0);

/**
 * Plan one round of requests.
 * @returns {{urls: string[], focus: string[]}}
 */
export function planRound({ round, origin, data, seenUrls, deadUrls, perRound = 14 }) {
  const bases = deriveBases(seenUrls, origin);
  const dead = new Set(deadUrls || []);
  const personID = data?.student?.personID ?? null;
  const vars = { personID };

  const urls = [];
  const focus = [];
  const push = (list) => {
    for (const u of list) {
      if (!dead.has(u) && !urls.includes(u) && urls.length < perRound) urls.push(u);
    }
  };

  if (round === 0) {
    // Bootstrap: we need a personID before most other paths mean anything.
    if (!personID) {
      focus.push('identity');
      push(buildUrls(origin, bases, 'identity', vars, 6));
    }
    focus.push('roster');
    push(buildUrls(origin, bases, 'roster', vars, 6));
    return { urls, focus, bases };
  }

  if (round === 1) {
    for (const kind of gapsIn(data)) {
      if (kind === 'identity' || kind === 'roster') continue;
      focus.push(kind);
      push(buildUrls(origin, bases, kind, vars, 4));
      if (urls.length >= perRound) break;
    }
    return { urls, focus, bases };
  }

  // Round 2+: per-section assignment detail for courses that arrived empty.
  const thin = (data?.courses || [])
    .filter((c) => assignmentsIn(c) === 0)
    .slice(0, 12);

  for (const course of thin) {
    focus.push(`assignments:${course.name}`);
    push(buildUrls(origin, bases, 'assignments', { ...vars, sectionID: course.id }, 2));
    if (urls.length >= perRound) break;
  }

  return { urls, focus, bases };
}

/** Human-readable note about what a run could not find. */
export function describeGaps(gaps) {
  const labels = {
    identity: 'student identity',
    roster: 'course list',
    grades: 'assignment-level grades',
    schedule: 'class schedule',
    transcript: 'transcript',
    gpa: 'GPA summary',
  };
  return gaps.map((g) => labels[g] || g);
}
