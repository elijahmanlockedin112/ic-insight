// Plans what to request. The Governor in bridge.js decides whether and how fast.
//
// These are not guesses. The paths below are the Campus Student / Campus Parent
// portal endpoints that community reference implementations have confirmed
// against live districts:
//
//   https://github.com/chrischall/infinitecampus-mcp  (docs/endpoints.md)
//   https://github.com/schwartzpub/ic_parent_api
//   https://github.com/gilesgc/Infinite-Campus-API
//   https://github.com/tonyzimbinski/infinite-campus
//
// None of them are publicly supported interfaces, so a district on an older or
// customised Campus release can still differ. Three things keep that cheap:
//
//   1. Only the district prefix is inferred, from URLs the portal itself used.
//      Everything after /campus/ is a known-good path, so the candidate set is
//      one or two URLs per kind rather than a combinatorial sweep.
//   2. displayOptions tells us which modules the district has switched off, so
//      disabled features are never requested at all.
//   3. A 404 is recorded permanently, so any path that is wrong here costs
//      exactly one request, once, forever.

/**
 * Confirmed portal endpoints. `flag` names the displayOptions key that gates
 * the feature; when the district reports it false we skip the request entirely.
 */
const ENDPOINTS = {
  identity: [
    { path: '/campus/api/portal/students' },
  ],
  features: [
    { path: '/campus/api/portal/displayOptions/{structureID}?personID={personID}' },
  ],
  roster: [
    { path: '/campus/resources/portal/roster?personID={personID}', flag: 'schedule' },
  ],
  grades: [
    { path: '/campus/resources/portal/grades?personID={personID}', flag: 'grades' },
  ],
  assignments: [
    { path: '/campus/api/portal/assignment/listView?personID={personID}', flag: 'grades' },
  ],
  sectionAssignments: [
    {
      path: '/campus/api/portal/assignment/listView?personID={personID}&sectionID={sectionID}',
      flag: 'grades',
    },
  ],
  terms: [
    { path: '/campus/resources/term?structureID={structureID}' },
  ],
  documents: [
    // Transcripts and report cards live here, as downloadable files rather than
    // as structured JSON. There is no portal endpoint that returns a parsed
    // transcript - see README, "Limitations worth knowing".
    { path: '/campus/resources/portal/report/all?personID={personID}', flag: 'documents' },
  ],
};

/** Order matters: each kind can depend on ids the previous one returned. */
const ROUNDS = [
  ['identity'],
  ['features', 'roster', 'grades'],
  ['assignments', 'terms', 'documents'],
  ['sectionAssignments'],
];

/**
 * Infer the district's path prefix from URLs the portal fetched itself.
 * Almost always "", but some deployments mount Campus under an extra segment.
 */
export function derivePrefixes(seenUrls, origin) {
  const counts = new Map();

  for (const raw of seenUrls || []) {
    let u;
    try { u = new URL(raw); } catch { continue; }
    if (u.origin !== origin) continue;

    const at = u.pathname.indexOf('/campus/');
    if (at === -1) continue;
    counts.set(u.pathname.slice(0, at), (counts.get(u.pathname.slice(0, at)) || 0) + 1);
  }

  const learned = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([p]) => p);
  return [...new Set([...learned, ''])].slice(0, 3);
}

const hasUnfilled = (s) => /\{\w+\}/.test(s);

function fill(template, vars) {
  return template.replace(/\{(\w+)\}/g, (m, key) =>
    (vars[key] !== null && vars[key] !== undefined ? encodeURIComponent(vars[key]) : m));
}

/**
 * Build candidate URLs for one kind.
 * Iterates prefix-major so a single unlucky prefix can never starve the rest of
 * the list - the bug that made an earlier version miss the correct endpoint.
 */
function buildUrls(origin, prefixes, kind, vars, flags) {
  const out = [];
  for (const endpoint of ENDPOINTS[kind] || []) {
    if (endpoint.flag && flags && flags[endpoint.flag] === false) continue;
    const path = fill(endpoint.path, vars);
    if (hasUnfilled(path)) continue; // depends on an id we do not have yet
    for (const prefix of prefixes) out.push(origin + prefix + path);
  }
  return out;
}

/** What the dataset still lacks, in the order worth fixing. */
export function gapsIn(data) {
  const gaps = [];
  const courses = data?.courses || [];
  if (!data?.student?.personID) gaps.push('identity');
  if (!courses.length) gaps.push('roster');
  if (!courses.some((c) => assignmentsIn(c) > 0)) gaps.push('assignments');
  if (!(data?.schedule || []).length) gaps.push('schedule');
  if (!(data?.documents || []).length) gaps.push('documents');
  if (!data?.gpaSummary && !(data?.transcript || []).length) gaps.push('transcript');
  return gaps;
}

const assignmentsIn = (course) =>
  (course.gradingTasks || []).reduce(
    (s, t) => s + (t.categories || []).reduce((n, c) => n + (c.assignments?.length ?? 0), 0), 0);

/**
 * Plan one round of requests.
 * @returns {{urls: string[], focus: string[], prefixes: string[]}}
 */
export function planRound({ round, origin, data, seenUrls, deadUrls, perRound = 14 }) {
  const prefixes = derivePrefixes(seenUrls, origin);
  const dead = new Set(deadUrls || []);
  const flags = data?.displayOptions || null;

  const enrollment = (data?.enrollments || [])[0] || {};
  const vars = {
    personID: data?.student?.personID ?? null,
    structureID: enrollment.structureID ?? null,
    calendarID: enrollment.calendarID ?? null,
    enrollmentID: enrollment.enrollmentID ?? null,
  };

  const urls = [];
  const focus = [];
  const push = (list) => {
    for (const u of list) {
      if (!dead.has(u) && !urls.includes(u) && urls.length < perRound) urls.push(u);
    }
  };

  const kinds = ROUNDS[Math.min(round, ROUNDS.length - 1)] || [];

  for (const kind of kinds) {
    if (kind === 'sectionAssignments') {
      // Only for courses that arrived without any assignment detail.
      const thin = (data?.courses || []).filter((c) => assignmentsIn(c) === 0).slice(0, 12);
      for (const course of thin) {
        const built = buildUrls(origin, prefixes, kind, { ...vars, sectionID: course.id }, flags);
        if (built.length) focus.push(`assignments: ${course.name}`);
        push(built);
        if (urls.length >= perRound) break;
      }
      continue;
    }

    const built = buildUrls(origin, prefixes, kind, vars, flags);
    if (built.length) focus.push(kind);
    push(built);
    if (urls.length >= perRound) break;
  }

  return { urls, focus, prefixes };
}

/** Human-readable note about what a run could not find. */
export function describeGaps(gaps) {
  const labels = {
    identity: 'student identity',
    roster: 'course list',
    assignments: 'assignment-level grades',
    schedule: 'class schedule',
    documents: 'report cards and transcript files',
    transcript: 'transcript history',
  };
  return gaps.map((g) => labels[g] || g);
}

export const CONFIRMED_ENDPOINTS = ENDPOINTS;
