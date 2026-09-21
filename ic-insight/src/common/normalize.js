// Turns whatever JSON Infinite Campus happened to return into one canonical shape.
//
// IC's payload structure varies by district and by IC release, so this does NOT
// hardcode response paths. It walks any captured JSON and picks out nodes that
// *structurally* look like a course, grading task, category, assignment,
// transcript row or schedule row. That tolerates far more district variation
// than pinning specific endpoints would.

import { num, pct, hashId, parseDate, uniqueBy, rigorOf } from './util.js';

const first = (o, ...names) => {
  for (const n of names) {
    if (o[n] !== undefined && o[n] !== null && o[n] !== '') return o[n];
  }
  return null;
};

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Depth-limited walk over every object in a payload. */
function walk(node, visit, depth = 0, seen = new Set()) {
  if (depth > 14 || node === null || typeof node !== 'object') return;
  if (seen.has(node)) return;
  seen.add(node);
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit, depth + 1, seen);
    return;
  }
  visit(node);
  for (const v of Object.values(node)) {
    if (v && typeof v === 'object') walk(v, visit, depth + 1, seen);
  }
}

// ---------------------------------------------------------------- predicates

const looksLikeAssignment = (o) =>
  isObj(o) &&
  (o.assignmentName !== undefined || o.assignmentID !== undefined || o.objectSectionID !== undefined) &&
  (o.totalPoints !== undefined || o.pointsPossible !== undefined || o.scorePoints !== undefined ||
   o.score !== undefined || o.dueDate !== undefined);

const looksLikeCourse = (o) =>
  isObj(o) &&
  (o.courseName !== undefined || (o.name !== undefined && (o.sectionID !== undefined || o.courseID !== undefined))) &&
  (Array.isArray(o.gradingTasks) || Array.isArray(o.gradingTaskList) ||
   Array.isArray(o.grades) || Array.isArray(o.categories) || Array.isArray(o.standards));

const looksLikeTranscriptRow = (o) =>
  isObj(o) &&
  (o.creditsEarned !== undefined || o.creditsAttempted !== undefined || o.credits !== undefined) &&
  (o.courseName !== undefined || o.courseNumber !== undefined) &&
  (o.score !== undefined || o.grade !== undefined || o.gpaValue !== undefined);

const looksLikeScheduleRow = (o) =>
  isObj(o) &&
  (o.periodName !== undefined || o.periodSequence !== undefined || o.startTime !== undefined) &&
  (o.courseName !== undefined || o.name !== undefined);

const looksLikeStudent = (o) =>
  isObj(o) &&
  (o.personID !== undefined || o.studentNumber !== undefined) &&
  (o.firstName !== undefined || o.lastName !== undefined || o.studentName !== undefined);

// ---------------------------------------------------------------- converters

function toAssignment(a, ctx = {}) {
  const possible = num(first(a, 'totalPoints', 'pointsPossible', 'possiblePoints', 'maxPoints'));
  const earnedRaw = first(a, 'scorePoints', 'pointsEarned', 'earnedPoints', 'scoreValue', 'score');
  const earned = num(earnedRaw);

  const notGraded =
    a.notGraded === true || a.scoringType === 'NOT_GRADED' ||
    (earned === null && !a.missing && !a.turnedIn);

  const missing = a.missing === true || a.isMissing === true;
  const dueDate = parseDate(first(a, 'dueDate', 'endDate', 'assignedDate'));

  const percent =
    num(a.percent) ??
    (earned !== null && possible ? pct(earned, possible) : null);

  return {
    id: String(first(a, 'objectSectionID', 'assignmentID', 'id') ??
        hashId(ctx.courseId, a.assignmentName, a.dueDate)),
    name: String(first(a, 'assignmentName', 'name', 'title') ?? 'Untitled'),
    courseId: ctx.courseId ?? String(first(a, 'sectionID', 'courseID') ?? ''),
    categoryId: ctx.categoryId ?? (a.groupActivityID != null ? String(a.groupActivityID) : null),
    categoryName: ctx.categoryName ?? null,
    taskName: ctx.taskName ?? null,
    dueDate: dueDate ? dueDate.toISOString() : null,
    possible,
    earned,
    percent,
    missing,
    late: a.late === true,
    turnedIn: a.turnedIn === true,
    dropped: a.dropped === true || a.omitFromGrade === true,
    notGraded,
    comment: typeof a.comments === 'string' ? a.comments.slice(0, 400) : null,
  };
}

function collectAssignments(node, ctx) {
  const out = [];
  walk(node, (o) => { if (looksLikeAssignment(o)) out.push(toAssignment(o, ctx)); });
  return out;
}

function toCategory(c, ctx) {
  const categoryId = String(first(c, 'groupActivityID', 'categoryID', 'id') ??
    hashId(ctx.courseId, ctx.taskName, first(c, 'name', 'groupName')));
  const categoryName = String(first(c, 'name', 'groupName', 'categoryName') ?? 'Uncategorized');

  const assignments = collectAssignments(
    c.assignments ?? c.assignmentList ?? c,
    { ...ctx, categoryId, categoryName },
  );

  const graded = assignments.filter((a) => !a.dropped && !a.notGraded && a.possible > 0);
  const earned = graded.reduce((s, a) => s + (a.earned ?? 0), 0);
  const possible = graded.reduce((s, a) => s + a.possible, 0);

  return {
    id: categoryId,
    name: categoryName,
    // Units do not matter (0-1 or 0-100): every consumer divides by the sum.
    weight: num(first(c, 'weight', 'groupWeight', 'categoryWeight')),
    earned: num(first(c, 'pointsEarned', 'earnedPoints')) ?? earned,
    possible: num(first(c, 'pointsPossible', 'totalPoints')) ?? possible,
    assignments,
  };
}

function toGradingTask(t, ctx) {
  const taskName = String(first(t, 'taskName', 'name', 'gradingTaskName') ?? 'Grade');
  const inner = { ...ctx, taskName };

  const rawCats = t.categories ?? t.categoryList ?? t.groups ?? null;
  let categories = Array.isArray(rawCats) ? rawCats.map((c) => toCategory(c, inner)) : [];

  // Total-points courses have no categories, so synthesise one bucket.
  if (!categories.length) {
    const assignments = collectAssignments(t, inner);
    if (assignments.length) {
      const graded = assignments.filter((a) => !a.dropped && !a.notGraded && a.possible > 0);
      categories = [{
        id: taskName + '-all',
        name: 'All assignments',
        weight: null,
        earned: graded.reduce((s, a) => s + (a.earned ?? 0), 0),
        possible: graded.reduce((s, a) => s + a.possible, 0),
        assignments,
      }];
    }
  }

  const weighted = categories.some((c) => c.weight !== null && c.weight > 0) ||
                   t.groupWeighted === true;

  return {
    name: taskName,
    termName: first(t, 'termName', 'term', 'termID') ? String(first(t, 'termName', 'term', 'termID')) : null,
    isPosted: t.posted === true || t.progressScore != null || t.score != null,
    reportedScore: first(t, 'score', 'progressScore', 'letterGrade'),
    reportedPercent:
      num(first(t, 'percent', 'progressPercent', 'scorePercentage', 'progressScorePercent')),
    weighted,
    categories,
  };
}

function toCourse(c) {
  const courseId = String(first(c, 'sectionID', 'courseID', 'id') ??
    hashId(first(c, 'courseName', 'name'), first(c, 'courseNumber')));
  const name = String(first(c, 'courseName', 'name') ?? 'Unnamed course');

  const rawTasks = c.gradingTasks ?? c.gradingTaskList ?? c.grades ?? null;
  let tasks = Array.isArray(rawTasks)
    ? rawTasks.map((t) => toGradingTask(t, { courseId }))
    : [];

  if (!tasks.length && (Array.isArray(c.categories) || collectAssignments(c, { courseId }).length)) {
    tasks = [toGradingTask(c, { courseId })];
  }

  return {
    id: courseId,
    name,
    courseNumber: first(c, 'courseNumber') ? String(first(c, 'courseNumber')) : null,
    teacher: first(c, 'teacherDisplay', 'teacherName', 'primaryTeacherName', 'staffName'),
    period: first(c, 'periodName', 'period', 'periodSequence'),
    room: first(c, 'roomName', 'room'),
    termName: first(c, 'termName', 'term'),
    rigor: rigorOf(name),
    credits: num(first(c, 'credits', 'creditsAttempted')),
    gradingTasks: tasks,
  };
}

function toTranscriptRow(r) {
  return {
    id: String(first(r, 'transcriptCourseID', 'id') ??
      hashId(first(r, 'courseName'), first(r, 'endYear'), first(r, 'termName'))),
    courseName: String(first(r, 'courseName', 'courseNumber') ?? 'Unknown'),
    courseNumber: first(r, 'courseNumber') ? String(first(r, 'courseNumber')) : null,
    score: first(r, 'score', 'grade', 'letterGrade'),
    percent: num(first(r, 'percent', 'scorePercent')),
    creditsEarned: num(first(r, 'creditsEarned', 'credits')) ?? 0,
    creditsAttempted: num(first(r, 'creditsAttempted', 'credits')),
    gpaValue: num(first(r, 'gpaValue', 'unweightedGPAValue')),
    weightedGpaValue: num(first(r, 'weightedGPAValue', 'bonusGPAValue')),
    bonusPoints: num(r.bonusPoints),
    gradeLevel: first(r, 'grade', 'gradeLevel') ? String(first(r, 'grade', 'gradeLevel')) : null,
    endYear: num(first(r, 'endYear', 'schoolYear')),
    termName: first(r, 'termName') ? String(first(r, 'termName')) : null,
    schoolName: first(r, 'schoolName', 'school'),
    rigor: rigorOf(String(first(r, 'courseName') ?? '')),
  };
}

function toScheduleRow(s) {
  return {
    id: String(first(s, 'sectionID', 'courseID', 'id') ??
      hashId(first(s, 'courseName', 'name'), first(s, 'periodName'), first(s, 'termName'))),
    courseName: String(first(s, 'courseName', 'name') ?? 'Unnamed'),
    teacher: first(s, 'teacherDisplay', 'teacherName', 'primaryTeacherName'),
    period: first(s, 'periodName', 'period'),
    periodSeq: num(first(s, 'periodSequence', 'seq')),
    room: first(s, 'roomName', 'room'),
    termName: first(s, 'termName', 'term'),
    startTime: first(s, 'startTime'),
    endTime: first(s, 'endTime'),
    dayName: first(s, 'dayName', 'day'),
  };
}

// ------------------------------------------------------------------- public

export const assignmentCount = (course) =>
  (course.gradingTasks || []).reduce(
    (s, t) => s + (t.categories || []).reduce((n, c) => n + (c.assignments ? c.assignments.length : 0), 0), 0);

/**
 * @param {Array<{url:string, ts:number, json:any}>} payloads
 * @returns canonical dataset
 */
export function extract(payloads) {
  const courses = [];
  const transcript = [];
  const schedule = [];
  let student = null;
  let gpaSummary = null;
  const sources = [];

  for (const p of payloads) {
    if (!p || !p.json) continue;
    let touched = false;

    walk(p.json, (o) => {
      if (looksLikeCourse(o)) { courses.push(toCourse(o)); touched = true; return; }
      if (looksLikeTranscriptRow(o)) { transcript.push(toTranscriptRow(o)); touched = true; return; }
      if (looksLikeScheduleRow(o)) { schedule.push(toScheduleRow(o)); touched = true; return; }

      if (!student && looksLikeStudent(o)) {
        student = {
          personID: o.personID != null ? String(o.personID) : null,
          firstName: o.firstName ?? null,
          lastName: o.lastName ?? null,
          grade: first(o, 'grade', 'gradeLevel'),
          schoolName: first(o, 'schoolName', 'school'),
        };
        touched = true;
      }

      if (o.cumulativeGPA !== undefined || o.unweightedGPA !== undefined ||
          o.weightedGPA !== undefined || o.classRank !== undefined) {
        gpaSummary = {
          unweighted: num(first(o, 'unweightedGPA', 'cumulativeGPA', 'gpa')),
          weighted: num(first(o, 'weightedGPA', 'weightedCumulativeGPA')),
          classRank: num(o.classRank),
          classSize: num(first(o, 'classSize', 'totalStudents')),
          totalCredits: num(first(o, 'totalCredits', 'creditsEarned')),
        };
        touched = true;
      }
    });

    if (touched) sources.push({ url: p.url, ts: p.ts });
  }

  // Merge duplicate courses (the same section often arrives from several
  // endpoints); keep whichever copy carries the most assignment detail.
  const byCourse = new Map();
  for (const c of courses) {
    const prev = byCourse.get(c.id);
    if (!prev || assignmentCount(c) > assignmentCount(prev)) byCourse.set(c.id, c);
  }

  return {
    student,
    gpaSummary,
    courses: [...byCourse.values()],
    transcript: uniqueBy(transcript, (t) => t.id),
    schedule: uniqueBy(schedule, (s) => s.id),
    sources,
    capturedAt: Date.now(),
  };
}

/** Merge a fresh extract into the stored one without losing earlier detail. */
export function mergeDataset(oldData, fresh) {
  if (!oldData) return fresh;
  const byId = new Map((oldData.courses || []).map((c) => [c.id, c]));
  for (const c of fresh.courses) {
    const prev = byId.get(c.id);
    byId.set(c.id, !prev || assignmentCount(c) >= assignmentCount(prev) ? c : prev);
  }
  return {
    student: fresh.student ?? oldData.student,
    gpaSummary: fresh.gpaSummary ?? oldData.gpaSummary,
    courses: [...byId.values()],
    transcript: uniqueBy([...(fresh.transcript || []), ...(oldData.transcript || [])], (t) => t.id),
    schedule: fresh.schedule && fresh.schedule.length ? fresh.schedule : oldData.schedule,
    sources: [...(fresh.sources || []), ...(oldData.sources || [])].slice(0, 60),
    capturedAt: Date.now(),
  };
}
