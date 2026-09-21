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

/**
 * A grading task: the object holding a course's actual grade for a term.
 * Matched structurally rather than by key name, because districts disagree
 * about what to call both the object and the array holding it.
 */
const looksLikeGradingTask = (o) =>
  isObj(o) &&
  !looksLikeAssignment(o) &&
  (o.taskName !== undefined || o.gradingTaskName !== undefined ||
   o.taskID !== undefined || o.name !== undefined) &&
  (o.score !== undefined || o.progressScore !== undefined ||
   o.percent !== undefined || o.progressPercent !== undefined ||
   o.letterGrade !== undefined || o.gradeLetter !== undefined ||
   Array.isArray(o.categories) || Array.isArray(o.categoryList));

/**
 * The array of grading tasks on a course, whatever the district named it.
 * Falls back to scanning the course's own arrays for one whose first element
 * looks like a grading task - which is how a course keyed under an unexpected
 * name still yields its real grade instead of falling back to an estimate.
 */
function findTaskArray(c) {
  const known = c.gradingTasks ?? c.gradingTaskList ?? c.grades;
  if (Array.isArray(known)) return known;
  for (const [key, v] of Object.entries(c)) {
    if (key === 'sectionPlacements' || key === 'assignments') continue;
    if (Array.isArray(v) && v.length && looksLikeGradingTask(v[0])) return v;
  }
  return null;
}

const looksLikeCourse = (o) =>
  isObj(o) &&
  (o.courseName !== undefined || (o.name !== undefined && (o.sectionID !== undefined || o.courseID !== undefined))) &&
  (findTaskArray(o) !== null || Array.isArray(o.categories) || Array.isArray(o.standards));

/**
 * A section object with no recognised grading-task array. The roster endpoint
 * returns these: courseName + sectionID + periodName, with the grades living in
 * a separate payload. They used to fall through to the schedule predicate and
 * the course was never built at all, so every course ended up as a listView-only
 * stub with no official grade. Metadata only - it merges with whatever carries
 * the real grading tasks.
 */
const looksLikeCourseShell = (o) =>
  isObj(o) &&
  !looksLikeAssignment(o) &&
  (o.courseName !== undefined || o.name !== undefined) &&
  (o.sectionID !== undefined || o.courseID !== undefined);

const looksLikeTranscriptRow = (o) =>
  isObj(o) &&
  (o.creditsEarned !== undefined || o.creditsAttempted !== undefined || o.credits !== undefined) &&
  (o.courseName !== undefined || o.courseNumber !== undefined) &&
  (o.score !== undefined || o.grade !== undefined || o.gpaValue !== undefined);

const looksLikeScheduleRow = (o) =>
  isObj(o) &&
  (o.periodName !== undefined || o.periodSequence !== undefined || o.startTime !== undefined) &&
  (o.courseName !== undefined || o.name !== undefined);

const looksLikeEnrollment = (o) =>
  isObj(o) &&
  o.enrollmentID !== undefined &&
  (o.calendarID !== undefined || o.structureID !== undefined);

const looksLikeDocument = (o) =>
  isObj(o) &&
  typeof o.url === 'string' &&
  (o.name !== undefined || o.fileName !== undefined) &&
  (o.moduleLabel !== undefined || o.type !== undefined || o.endYear !== undefined);

/**
 * The displayOptions payload is a flat bag of ~90 feature booleans. Detect it
 * structurally rather than by key name, since the exact flags vary by release.
 */
const looksLikeDisplayOptions = (o) => {
  if (!isObj(o)) return false;
  const values = Object.values(o);
  if (values.length < 15) return false;
  const bools = values.filter((v) => typeof v === 'boolean').length;
  return bools >= values.length * 0.6;
};

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
    num(first(a, 'percent', 'scorePercentage')) ??
    (earned !== null && possible ? pct(earned, possible) : null);

  return {
    id: String(first(a, 'objectSectionID', 'assignmentID', 'id') ??
        hashId(ctx.courseId, a.assignmentName, a.dueDate)),
    name: String(first(a, 'assignmentName', 'name', 'title') ?? 'Untitled'),
    courseId: ctx.courseId ?? String(first(a, 'sectionID', 'courseID') ?? ''),
    // listView carries the course name on the assignment itself; it is the only
    // way to name a course that has no roster entry.
    courseName: first(a, 'courseName') ? String(first(a, 'courseName')) : null,
    categoryId: ctx.categoryId ?? (a.groupActivityID != null ? String(a.groupActivityID) : null),
    categoryName: ctx.categoryName ?? first(a, 'categoryName', 'groupName') ?? null,
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

/**
 * `consumed` records the raw nodes turned into assignments here, so a later
 * pass can tell a course-nested assignment from a standalone one.
 */
function collectAssignments(node, ctx, consumed) {
  const out = [];
  walk(node, (o) => {
    if (!looksLikeAssignment(o)) return;
    consumed?.add(o);
    out.push(toAssignment(o, ctx));
  });
  return out;
}

function toCategory(c, ctx, consumed) {
  const categoryId = String(first(c, 'groupActivityID', 'categoryID', 'id') ??
    hashId(ctx.courseId, ctx.taskName, first(c, 'name', 'groupName')));
  const categoryName = String(first(c, 'name', 'groupName', 'categoryName') ?? 'Uncategorized');

  const assignments = collectAssignments(
    c.assignments ?? c.assignmentList ?? c,
    { ...ctx, categoryId, categoryName },
    consumed,
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


const LETTER_RE = /^[A-F][+-]?$/i;

/**
 * Find Infinite Campus's own grade on a grading task when it is not under one
 * of the usual field names. Districts and Campus releases disagree about what
 * to call it, and a wrong local recomputation is worse than none, so this looks
 * at the task's OWN top-level keys only - never deeper, which would pick up an
 * individual assignment's score by mistake.
 */
function sniffReportedPercent(t) {
  let best = null;
  for (const [key, value] of Object.entries(t)) {
    if (!/percent|pct/i.test(key)) continue;
    const n = num(value);
    if (n === null || n < 0 || n > 150) continue;
    // Prefer the field that names itself as the progress/current figure.
    const rank = /progress|current|cumulative/i.test(key) ? 2 : 1;
    if (!best || rank > best.rank) best = { rank, value: n };
  }
  return best ? best.value : null;
}

function sniffReportedScore(t) {
  for (const [key, value] of Object.entries(t)) {
    if (!/score|grade|letter/i.test(key)) continue;
    if (typeof value === 'string' && LETTER_RE.test(value.trim())) return value.trim();
  }
  return null;
}

function toGradingTask(t, ctx, consumed) {
  const taskName = String(first(t, 'taskName', 'name', 'gradingTaskName') ?? 'Grade');
  const inner = { ...ctx, taskName };

  const rawCats = t.categories ?? t.categoryList ?? t.groups ?? null;
  let categories = Array.isArray(rawCats) ? rawCats.map((c) => toCategory(c, inner, consumed)) : [];

  // Total-points courses have no categories, so synthesise one bucket.
  if (!categories.length) {
    const assignments = collectAssignments(t, inner, consumed);
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
    reportedScore:
      first(t, 'score', 'progressScore', 'letterGrade', 'gradeLetter') ?? sniffReportedScore(t),
    reportedPercent:
      num(first(t, 'percent', 'progressPercent', 'scorePercentage', 'progressScorePercent')) ??
      sniffReportedPercent(t),
    weighted,
    categories,
  };
}

function toCourse(c, consumed) {
  const courseId = String(first(c, 'sectionID', 'courseID', 'id') ??
    hashId(first(c, 'courseName', 'name'), first(c, 'courseNumber')));
  const name = String(first(c, 'courseName', 'name') ?? 'Unnamed course');

  const rawTasks = findTaskArray(c);
  let tasks = Array.isArray(rawTasks)
    ? rawTasks.map((t) => toGradingTask(t, { courseId }, consumed))
    : [];

  if (!tasks.length &&
      (Array.isArray(c.categories) || collectAssignments(c, { courseId }, null).length)) {
    tasks = [toGradingTask(c, { courseId }, consumed)];
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


/**
 * `/campus/api/portal/assignment/listView` returns a FLAT array of assignments,
 * each carrying its own sectionID rather than being nested under a course. They
 * are the richest source of per-assignment detail, so they must be folded back
 * onto the matching course instead of being dropped.
 *
 * A task built purely from these is marked `approximate`, because listView does
 * not carry category weights. Analysis then keeps IC's own reported percentage
 * as the headline grade and uses the assignments for trends and missing work.
 */
function attachOrphans(courses, orphans) {
  const byCourse = new Map();
  for (const a of orphans) {
    if (!a.courseId) continue;
    if (!byCourse.has(a.courseId)) byCourse.set(a.courseId, []);
    byCourse.get(a.courseId).push(a);
  }

  for (const [courseId, items] of byCourse) {
    let course = courses.find((c) => c.id === courseId);

    if (!course) {
      course = {
        id: courseId,
        name: items[0].courseName || 'Unnamed course',
        courseNumber: null,
        teacher: null,
        period: null,
        room: null,
        termName: null,
        rigor: rigorOf(items[0].courseName || ''),
        credits: null,
        gradingTasks: [],
      };
      courses.push(course);
    }

    const existingIds = new Set();
    for (const t of course.gradingTasks || []) {
      for (const c of t.categories || []) {
        for (const a of c.assignments || []) existingIds.add(a.id);
      }
    }

    const fresh = items.filter((a) => !existingIds.has(a.id));
    if (!fresh.length) continue;

    // Group by whatever category label the payload carried, if any.
    const groups = new Map();
    for (const a of fresh) {
      const key = a.categoryName || 'All assignments';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(a);
    }

    const categories = [...groups.entries()].map(([name, list]) => {
      const graded = list.filter((a) => !a.dropped && !a.notGraded && a.possible > 0);
      return {
        id: hashId(courseId, name),
        name,
        weight: null,
        earned: graded.reduce((sum, a) => sum + (a.earned ?? 0), 0),
        possible: graded.reduce((sum, a) => sum + a.possible, 0),
        assignments: list,
      };
    });

    const target = (course.gradingTasks || []).find((t) => (t.categories || []).length === 0)
      ?? (course.gradingTasks || [])[0];

    if (target && (target.categories || []).length === 0) {
      target.categories = categories;
      target.approximate = true;
    } else if (target) {
      // The course already has a real (often weighted) structure. Fold each
      // orphan into the existing category with the same name where possible.
      // Anything left over goes into a bucket flagged excludeFromGrade, because
      // an unweighted bucket sitting alongside weighted ones would otherwise
      // break the weighted calculation and silently drag the grade down.
      const leftovers = [];
      for (const group of categories) {
        const match = (target.categories || []).find(
          (c) => c.name.toLowerCase() === group.name.toLowerCase(),
        );
        if (match) match.assignments.push(...group.assignments);
        else leftovers.push(...group.assignments);
      }

      if (leftovers.length) {
        const other = (target.categories || []).find((c) => c.excludeFromGrade);
        if (other) other.assignments.push(...leftovers);
        else {
          target.categories.push({
            id: hashId(courseId, 'other'),
            name: 'Other assignments',
            weight: null,
            earned: 0,
            possible: 0,
            excludeFromGrade: true,
            assignments: leftovers,
          });
        }
      }
    } else {
      course.gradingTasks.push({
        name: 'Grade',
        termName: null,
        isPosted: false,
        reportedScore: null,
        reportedPercent: null,
        weighted: false,
        approximate: true,
        categories,
      });
    }
  }

  return courses;
}


/**
 * Combine two records for the same section, field by field.
 *
 * The same course arrives from several endpoints with different strengths:
 * `roster` and `grades` carry Infinite Campus's own reported percentage and the
 * weighted category structure, while `listView` carries far more assignments but
 * no weights. Picking one whole record and discarding the other loses whichever
 * strength the loser had - and when that was the reported percentage, the grade
 * got recomputed unweighted and came out lower than the student's real grade.
 */
function mergeCourses(a, b) {
  if (!a) return b;
  if (!b) return a;

  const prefer = (x, y) => (x !== null && x !== undefined && x !== '' ? x : y);

  const tasks = new Map();
  for (const task of [...(a.gradingTasks || []), ...(b.gradingTasks || [])]) {
    const key = task.name || 'Grade';
    const prev = tasks.get(key);
    if (!prev) { tasks.set(key, { ...task }); continue; }

    // Keep the richer category set, but never lose a reported grade.
    const prevCount = countIn(prev);
    const nextCount = countIn(task);
    tasks.set(key, {
      ...prev,
      ...task,
      categories: nextCount > prevCount ? task.categories : prev.categories,
      weighted: prev.weighted || task.weighted,
      // An approximate task stops being approximate once a weighted structure
      // for the same task turns up.
      approximate: Boolean(prev.approximate && task.approximate),
      reportedPercent: prefer(prev.reportedPercent, task.reportedPercent),
      reportedScore: prefer(prev.reportedScore, task.reportedScore),
      termName: prefer(prev.termName, task.termName),
    });
  }

  return {
    ...a,
    ...b,
    name: prefer(a.name !== 'Unnamed course' ? a.name : null, b.name),
    teacher: prefer(a.teacher, b.teacher),
    period: prefer(a.period, b.period),
    room: prefer(a.room, b.room),
    termName: prefer(a.termName, b.termName),
    courseNumber: prefer(a.courseNumber, b.courseNumber),
    credits: prefer(a.credits, b.credits),
    gradingTasks: [...tasks.values()],
  };
}

const countIn = (task) =>
  (task.categories || []).reduce((n, c) => n + (c.assignments?.length ?? 0), 0);

/**
 * Key names and nesting of a payload, with no values. This is what makes a
 * district's actual response shape diagnosable instead of guessable.
 */
export function describeShape(node, depth = 0) {
  if (depth > 4) return '...';
  if (Array.isArray(node)) {
    return { type: 'array', length: node.length,
             item: node.length ? describeShape(node[0], depth + 1) : null };
  }
  if (node === null || typeof node !== 'object') return typeof node;

  const out = { type: 'object', keys: Object.keys(node).sort(), nested: {} };
  for (const [k, v] of Object.entries(node)) {
    if (v && typeof v === 'object') out.nested[k] = describeShape(v, depth + 1);
  }
  if (!Object.keys(out.nested).length) delete out.nested;
  return out;
}

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
  const enrollments = [];
  const documents = [];
  let student = null;
  let gpaSummary = null;
  let displayOptions = null;
  const sources = [];
  const consumed = new Set();

  // Field names only, never values. Districts differ in what they call things,
  // and guessing at key names is how the reported-grade bug happened. This makes
  // a mismatch diagnosable from a copy-paste instead of from speculation.
  const sampleKeys = {};
  const noteKeys = (label, o) => {
    if (!sampleKeys[label] && isObj(o)) sampleKeys[label] = Object.keys(o).sort();
  };

  for (const p of payloads) {
    if (!p || !p.json) continue;
    let touched = false;

    walk(p.json, (o) => {
      if (looksLikeAssignment(o)) { noteKeys('assignment', o); return; }

      if (!looksLikeCourse(o) && looksLikeCourseShell(o)) {
        noteKeys('courseShell', o);
        courses.push(toCourse(o, consumed));
        touched = true;
        // Deliberately no return: the same object is usually the schedule row.
      }

      if (looksLikeCourse(o)) {
        noteKeys('course', o);
        const rawTask = (o.gradingTasks || o.gradingTaskList || o.grades || [])[0];
        if (rawTask) {
          noteKeys('gradingTask', rawTask);
          const rawCat = (rawTask.categories || rawTask.categoryList || rawTask.groups || [])[0];
          if (rawCat) noteKeys('category', rawCat);
        }
        courses.push(toCourse(o, consumed));
        touched = true;
        return;
      }
      if (looksLikeTranscriptRow(o)) { transcript.push(toTranscriptRow(o)); touched = true; return; }
      if (looksLikeScheduleRow(o)) { schedule.push(toScheduleRow(o)); touched = true; return; }

      if (looksLikeEnrollment(o)) {
        enrollments.push({
          enrollmentID: String(o.enrollmentID),
          calendarID: o.calendarID != null ? String(o.calendarID) : null,
          structureID: o.structureID != null ? String(o.structureID) : null,
          schoolName: first(o, 'schoolName', 'school'),
          grade: first(o, 'grade', 'gradeLevel'),
          endYear: num(first(o, 'endYear', 'schoolYear')),
        });
        touched = true;
      }

      if (looksLikeDocument(o)) {
        documents.push({
          name: String(first(o, 'name', 'fileName')),
          type: first(o, 'type', 'moduleLabel'),
          url: o.url,
          endYear: num(o.endYear),
        });
        touched = true;
      }

      if (!displayOptions && looksLikeDisplayOptions(o)) {
        displayOptions = { ...o };
        touched = true;
      }

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

  // Merge duplicate courses field by field. Never discard a whole record: one
  // copy may hold the reported grade and another the assignment detail.
  const byCourse = new Map();
  for (const c of courses) {
    byCourse.set(c.id, mergeCourses(byCourse.get(c.id), c));
  }

  // Second pass: assignments that were never nested inside a course. These come
  // from listView and are dropped entirely if we do not claim them here.
  const orphans = [];
  for (const p of payloads) {
    if (!p || !p.json) continue;
    walk(p.json, (o) => {
      if (looksLikeAssignment(o) && !consumed.has(o)) orphans.push(toAssignment(o, {}));
    });
  }
  const merged = attachOrphans([...byCourse.values()], uniqueBy(orphans, (a) => a.courseId + ':' + a.id));

  return {
    student,
    gpaSummary,
    displayOptions,
    sampleKeys,
    enrollments: uniqueBy(enrollments, (e) => e.enrollmentID),
    documents: uniqueBy(documents, (d) => d.url),
    courses: merged,
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
    byId.set(c.id, mergeCourses(byId.get(c.id), c));
  }
  return {
    student: fresh.student ?? oldData.student,
    gpaSummary: fresh.gpaSummary ?? oldData.gpaSummary,
    displayOptions: fresh.displayOptions ?? oldData.displayOptions,
    sampleKeys: { ...(oldData.sampleKeys || {}), ...(fresh.sampleKeys || {}) },
    fetchedAt: { ...(oldData.fetchedAt || {}), ...(fresh.fetchedAt || {}) },
    enrollments: uniqueBy(
      [...(fresh.enrollments || []), ...(oldData.enrollments || [])], (e) => e.enrollmentID),
    documents: uniqueBy(
      [...(fresh.documents || []), ...(oldData.documents || [])], (d) => d.url),
    courses: [...byId.values()],
    transcript: uniqueBy([...(fresh.transcript || []), ...(oldData.transcript || [])], (t) => t.id),
    schedule: fresh.schedule && fresh.schedule.length ? fresh.schedule : oldData.schedule,
    sources: [...(fresh.sources || []), ...(oldData.sources || [])].slice(0, 60),
    capturedAt: Date.now(),
  };
}
