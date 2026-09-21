// Deterministic grade math.
//
// The AI never does arithmetic here. Everything numeric (grades, GPA, points
// needed, trend slopes, what-if deltas) is computed locally and handed to the
// model as settled facts, so it can spend its effort on strategy instead of
// getting a percentage wrong.

import {
  round, slope, mean, letterFor, nextLetterUp, cushion,
  SCALES, GPA_POINTS, RIGOR_BUMP, rigorOf, isoDay,
} from './util.js';

// --------------------------------------------------------------- course math

/** The grading task that best represents "my grade right now". */
export function primaryTask(course) {
  const tasks = course.gradingTasks || [];
  if (!tasks.length) return null;
  const scored = tasks.map((t) => {
    const n = (t.categories || []).reduce((s, c) => s + (c.assignments?.length ?? 0), 0);
    let score = n;
    if (/quarter|progress|term/i.test(t.name)) score += 500;
    if (/semester|final/i.test(t.name)) score += 250;
    if (t.reportedPercent != null) score += 100;
    return { t, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0].t;
}

/** Live category totals recomputed from assignments (ignores dropped/ungraded). */
function categoryTotals(category) {
  const graded = (category.assignments || []).filter(
    (a) => !a.dropped && !a.notGraded && a.possible > 0 && a.earned !== null,
  );
  const earned = graded.reduce((s, a) => s + a.earned, 0);
  const possible = graded.reduce((s, a) => s + a.possible, 0);
  return { earned, possible, count: graded.length };
}

/**
 * Compute a course percentage from its assignments.
 * Returns { percent, method, categories } or null when there is nothing to compute.
 */
export function computeTaskPercent(task, overrides = {}) {
  if (!task) return null;
  const cats = (task.categories || []).map((c) => {
    const t = categoryTotals(c);
    const key = c.id;
    const earned = overrides[key]?.earned ?? t.earned;
    const possible = overrides[key]?.possible ?? t.possible;
    return {
      id: c.id,
      name: c.name,
      weight: c.weight,
      earned,
      possible,
      count: t.count,
      percent: possible > 0 ? (earned / possible) * 100 : null,
    };
  });

  // Categories flagged excludeFromGrade hold assignments we recovered from
  // listView that do not belong to any real category. They are shown, but they
  // never participate in the grade.
  const active = cats.filter((c) => c.possible > 0 && !c.excludeFromGrade);
  if (!active.length) {
    return task.reportedPercent != null
      ? { percent: task.reportedPercent, method: 'reported', categories: cats }
      : null;
  }

  // A task assembled from listView has no category weights, so recomputing it
  // would disagree with a weighted gradebook. Where IC gave us its own figure,
  // that stays the headline grade; the assignments are still used for trends,
  // missing work and what-ifs.
  if (task.approximate && task.reportedPercent != null) {
    for (const c of cats) {
      c.weightShare = null;
      c.dragPoints = null;
    }
    return { percent: task.reportedPercent, method: 'reported', categories: cats, approximate: true };
  }

  // Use every weighted category there is. Previously a single category without
  // a weight made this check fail and flipped the whole course to total-points,
  // which for a weighted gradebook reports a grade well below the real one.
  const weightedCats = active.filter((c) => c.weight !== null && c.weight > 0);
  const useWeights = task.weighted && weightedCats.length > 0;

  if (useWeights) {
    const W = weightedCats.reduce((s, c) => s + c.weight, 0);
    const percent = weightedCats.reduce((s, c) => s + c.weight * (c.earned / c.possible), 0) / W * 100;
    for (const c of cats) {
      c.weightShare = c.weight && c.possible > 0 && !c.excludeFromGrade ? c.weight / W : 0;
      // How many percentage points this category costs the overall grade.
      c.dragPoints = c.possible > 0 ? round(c.weightShare * (100 - c.percent), 2) : 0;
    }
    return { percent, method: 'weighted', categories: cats, weightSum: W };
  }

  const earned = active.reduce((s, c) => s + c.earned, 0);
  const possible = active.reduce((s, c) => s + c.possible, 0);
  for (const c of cats) {
    c.weightShare = possible > 0 ? c.possible / possible : 0;
    c.dragPoints = c.possible > 0 ? round(c.weightShare * (100 - c.percent), 2) : 0;
  }
  return { percent: (earned / possible) * 100, method: 'total-points', categories: cats };
}

/**
 * Minimum points you must earn on a hypothetical `addedPossible`-point
 * assignment in `categoryId` to land at `targetPercent`.
 * Returns { needed, addedPossible, achievable, resultingIfPerfect, resultingIfZero }.
 */
export function pointsNeededForTarget(task, targetPercent, addedPossible, categoryId) {
  const current = computeTaskPercent(task);
  if (!current || !addedPossible || addedPossible <= 0) return null;

  const cats = current.categories;
  const target = targetPercent;

  const withOverride = (earnedDelta) => {
    const cat = cats.find((c) => c.id === categoryId) || cats[0];
    if (!cat) return null;
    return computeTaskPercent(task, {
      [cat.id]: { earned: cat.earned + earnedDelta, possible: cat.possible + addedPossible },
    });
  };

  const best = withOverride(addedPossible);
  const worst = withOverride(0);
  if (!best || !worst) return null;

  // The mapping from points earned to final percent is linear, so two probes
  // are enough to invert it exactly.
  const span = best.percent - worst.percent;
  let needed;
  if (Math.abs(span) < 1e-9) {
    needed = target <= worst.percent ? 0 : Infinity;
  } else {
    needed = ((target - worst.percent) / span) * addedPossible;
  }

  return {
    addedPossible,
    categoryId: (cats.find((c) => c.id === categoryId) || cats[0])?.id ?? null,
    categoryName: (cats.find((c) => c.id === categoryId) || cats[0])?.name ?? null,
    needed: Number.isFinite(needed) ? round(Math.max(0, needed), 1) : null,
    neededPercent: Number.isFinite(needed)
      ? round((Math.max(0, needed) / addedPossible) * 100, 1) : null,
    achievable: Number.isFinite(needed) && needed <= addedPossible + 1e-9,
    resultingIfPerfect: round(best.percent, 2),
    resultingIfZero: round(worst.percent, 2),
  };
}

/** Missing / zero-scored work, ranked by how much fixing it would move the grade. */
export function missingWorkImpact(task) {
  const current = computeTaskPercent(task);
  if (!current) return { items: [], allFixedPercent: null, allFixedDelta: null };

  const items = [];
  const perCategoryRecovery = new Map();

  for (const cat of task.categories || []) {
    for (const a of cat.assignments || []) {
      if (a.dropped || !a.possible || a.possible <= 0) continue;
      const isZeroish = a.missing || (a.earned !== null && a.earned === 0);
      if (!isZeroish) continue;

      const gain = a.possible - (a.earned ?? 0);
      const overrides = {
        [cat.id]: {
          earned: (current.categories.find((c) => c.id === cat.id)?.earned ?? 0) + gain,
          possible: (current.categories.find((c) => c.id === cat.id)?.possible ?? 0) +
            (a.earned === null ? a.possible : 0),
        },
      };
      const after = computeTaskPercent(task, overrides);
      items.push({
        name: a.name,
        categoryName: cat.name,
        dueDate: a.dueDate,
        possible: a.possible,
        earned: a.earned,
        missing: a.missing,
        late: a.late,
        deltaIfFullCredit: after ? round(after.percent - current.percent, 2) : null,
      });
      perCategoryRecovery.set(cat.id, (perCategoryRecovery.get(cat.id) ?? 0) + gain);
    }
  }

  items.sort((a, b) => (b.deltaIfFullCredit ?? 0) - (a.deltaIfFullCredit ?? 0));

  const allOverrides = {};
  for (const [catId, gain] of perCategoryRecovery) {
    const c = current.categories.find((x) => x.id === catId);
    if (c) allOverrides[catId] = { earned: c.earned + gain, possible: c.possible };
  }
  const allFixed = Object.keys(allOverrides).length
    ? computeTaskPercent(task, allOverrides) : null;

  return {
    items: items.slice(0, 25),
    count: items.length,
    allFixedPercent: allFixed ? round(allFixed.percent, 2) : null,
    allFixedDelta: allFixed ? round(allFixed.percent - current.percent, 2) : null,
  };
}

/** Assignment-level trend for one course: is this grade rising or sliding? */
export function assignmentTrend(task) {
  const graded = [];
  for (const cat of task?.categories || []) {
    for (const a of cat.assignments || []) {
      if (a.dropped || a.notGraded || !a.possible || a.earned === null) continue;
      graded.push({ ...a, categoryName: cat.name, pct: (a.earned / a.possible) * 100 });
    }
  }
  graded.sort((a, b) => {
    const da = a.dueDate ? Date.parse(a.dueDate) : 0;
    const db = b.dueDate ? Date.parse(b.dueDate) : 0;
    return da - db;
  });

  if (graded.length < 3) {
    return { n: graded.length, direction: 'insufficient-data', series: graded.map(sparse) };
  }

  const ys = graded.map((a) => a.pct);
  const s = slope(ys);
  const tail = ys.slice(-5);
  const head = ys.slice(0, -5);
  const tailMean = mean(tail);
  const headMean = head.length ? mean(head) : null;
  const shift = headMean === null ? null : tailMean - headMean;

  let direction = 'steady';
  if (s !== null && s <= -0.6 && (shift === null || shift < -2)) direction = 'declining';
  else if (s !== null && s >= 0.6 && (shift === null || shift > 2)) direction = 'improving';
  if (shift !== null && shift <= -8) direction = 'declining';
  if (shift !== null && shift >= 8) direction = 'improving';

  // Which category is dragging relative to the course's own average?
  const byCat = new Map();
  for (const a of graded) {
    if (!byCat.has(a.categoryName)) byCat.set(a.categoryName, []);
    byCat.get(a.categoryName).push(a.pct);
  }
  const overall = mean(ys);
  const categoryGaps = [...byCat.entries()]
    .map(([name, arr]) => ({ name, n: arr.length, mean: round(mean(arr), 1), gap: round(mean(arr) - overall, 1) }))
    .sort((a, b) => a.gap - b.gap);

  return {
    n: graded.length,
    direction,
    slopePerAssignment: round(s, 3),
    last5Mean: round(tailMean, 1),
    priorMean: round(headMean, 1),
    shift: round(shift, 1),
    zeroCount: graded.filter((a) => a.earned === 0).length,
    lateCount: graded.filter((a) => a.late).length,
    // `recent` drives the dashboard sparkline only. `all` is what the model
    // gets: sending a tail invited it to infer a grade from a partial sample.
    worst: graded.slice().sort((a, b) => a.pct - b.pct).slice(0, 5).map(sparse),
    recent: graded.slice(-8).map(sparse),
    all: graded.map(sparse),
    categoryGaps,
  };
}

const sparse = (a) => ({
  name: a.name,
  category: a.categoryName,
  due: a.dueDate ? a.dueDate.slice(0, 10) : null,
  earned: a.earned,
  possible: a.possible,
  pct: round(a.pct, 1),
  late: a.late || undefined,
  missing: a.missing || undefined,
});

// ------------------------------------------------------------------- GPA

export function gpaFromCourses(courses, settings) {
  const scale = settings.scale;
  let totalPts = 0;
  let totalWPts = 0;
  let credits = 0;

  const rows = [];
  let excluded = 0;
  for (const c of courses) {
    if (c.percent === null || c.percent === undefined) continue;
    // A course the school reported no grade for would otherwise contribute a
    // letter derived from our own unweighted estimate, quietly moving the GPA.
    if (c.isEstimate) { excluded += 1; continue; }
    const letter = letterFor(c.percent, scale);
    const base = GPA_POINTS[letter] ?? 0;
    const rigor = settings.rigorOverrides?.[c.id] ?? c.rigor ?? 'regular';
    const bump = letter === 'F' ? 0 : (RIGOR_BUMP[rigor] ?? 0);
    const cr = c.credits && c.credits > 0 ? c.credits : 1;

    totalPts += base * cr;
    totalWPts += (base + bump) * cr;
    credits += cr;
    rows.push({ id: c.id, name: c.name, percent: round(c.percent, 2), letter, base, weighted: base + bump, rigor, credits: cr });
  }

  return {
    unweighted: credits ? round(totalPts / credits, 3) : null,
    weighted: credits ? round(totalWPts / credits, 3) : null,
    credits,
    rows,
    excludedNoReportedGrade: excluded,
  };
}

export function gpaFromTranscript(transcript, settings) {
  let pts = 0;
  let wpts = 0;
  let credits = 0;
  const byYear = new Map();

  for (const r of transcript || []) {
    const cr = r.creditsEarned || r.creditsAttempted || 0;
    if (!cr) continue;
    const letter = typeof r.score === 'string' ? r.score.trim().toUpperCase() : null;
    const base = r.gpaValue ?? (letter && GPA_POINTS[letter] !== undefined ? GPA_POINTS[letter] : null);
    if (base === null) continue;

    const rigor = settings.rigorOverrides?.[r.id] ?? r.rigor ?? rigorOf(r.courseName);
    const w = r.weightedGpaValue ?? base + (base === 0 ? 0 : (RIGOR_BUMP[rigor] ?? 0));

    pts += base * cr;
    wpts += w * cr;
    credits += cr;

    const y = r.endYear ?? 'unknown';
    if (!byYear.has(y)) byYear.set(y, { pts: 0, wpts: 0, credits: 0, courses: 0 });
    const bucket = byYear.get(y);
    bucket.pts += base * cr;
    bucket.wpts += w * cr;
    bucket.credits += cr;
    bucket.courses += 1;
  }

  const years = [...byYear.entries()]
    .map(([year, b]) => ({
      year,
      gpa: b.credits ? round(b.pts / b.credits, 3) : null,
      weightedGpa: b.credits ? round(b.wpts / b.credits, 3) : null,
      credits: round(b.credits, 2),
      courses: b.courses,
    }))
    .sort((a, b) => String(a.year).localeCompare(String(b.year)));

  return {
    unweighted: credits ? round(pts / credits, 3) : null,
    weighted: credits ? round(wpts / credits, 3) : null,
    credits: round(credits, 2),
    byYear: years,
  };
}

/** What a target cumulative GPA demands of the remaining terms. */
export function gpaRunway(cumulative, target, remainingCredits) {
  if (!cumulative || cumulative.unweighted === null || !remainingCredits) return null;
  const have = cumulative.unweighted * cumulative.credits;
  const needTotal = target * (cumulative.credits + remainingCredits);
  const needed = (needTotal - have) / remainingCredits;
  return {
    target,
    remainingCredits,
    requiredGpaGoingForward: round(needed, 3),
    possible: needed <= 4.0 + 1e-9,
    verdict:
      needed <= 0 ? 'already-locked-in'
      : needed <= 4.0 ? 'reachable'
      : 'not-reachable-on-unweighted-4.0',
  };
}

// ------------------------------------------------------------------ top level

export function analyze(data, settings, snapshots = []) {
  const scale = settings.scale;
  const courseReports = [];

  for (const course of data.courses || []) {
    const task = primaryTask(course);
    if (!task) continue;

    const computed = computeTaskPercent(task);

    // Infinite Campus's own figure always wins the headline. It accounts for
    // dropped scores, curves, exemptions and weighting the API never exposes,
    // so a locally recomputed number that disagrees with it is wrong, not
    // more accurate. The computed value is kept for what-ifs and shown beside
    // it when the two disagree.
    const reported = task.reportedPercent;
    const percent = reported ?? computed?.percent ?? null;
    if (percent === null) continue;

    const computedPercent = computed?.percent ?? null;
    const drift = reported !== null && reported !== undefined && computedPercent !== null
      ? round(computedPercent - reported, 2)
      : null;

    const letter = letterFor(percent, scale);
    const up = nextLetterUp(percent, scale);
    const trend = assignmentTrend(task);
    const missing = missingWorkImpact(task);

    // A representative "next assignment" probe: the median size of graded work
    // in the heaviest category, so the what-if is realistic rather than arbitrary.
    const heaviest = (computed?.categories || [])
      .filter((c) => c.possible > 0)
      .sort((a, b) => (b.weightShare ?? 0) - (a.weightShare ?? 0))[0];
    const probeSize = medianAssignmentSize(task, heaviest?.id) ?? 100;

    const toNextLetter = up
      ? pointsNeededForTarget(task, up.floor, probeSize, heaviest?.id)
      : null;
    const toHoldLetter = pointsNeededForTarget(
      task,
      (scaleFloorFor(percent, scale)),
      probeSize,
      heaviest?.id,
    );

    courseReports.push({
      id: course.id,
      name: course.name,
      teacher: course.teacher,
      period: course.period,
      term: task.termName ?? course.termName,
      task: task.name,
      rigor: settings.rigorOverrides?.[course.id] ?? course.rigor,
      credits: course.credits,
      percent: round(percent, 2),
      letter,
      method: reported !== null && reported !== undefined ? 'reported' : (computed?.method ?? 'reported'),
      approximate: Boolean(task.approximate),
      // True only when IC reported nothing and the figure shown is our own
      // unweighted estimate. The UI must never call this "your grade".
      isEstimate: (reported === null || reported === undefined) && Boolean(task.approximate),
      computedPercent: round(computedPercent, 2),
      // Big drift means our category model does not match the real gradebook.
      // Surfaced rather than hidden, because it tells the student the what-if
      // numbers below are estimates.
      driftFromIC: drift,
      modelDisagrees: drift !== null && Math.abs(drift) > 1.5,
      reportedByIC: task.reportedScore ?? null,
      // The school's own percentage, or null when it did not supply one. Kept
      // separate from `percent`, which falls back to our estimate.
      schoolReportedPercent: reported ?? null,
      cushionToDrop: cushion(percent, scale),
      nextLetter: up ? { letter: up.letter, atPercent: up.floor, gap: round(up.floor - percent, 2) } : null,
      categories: (computed?.categories || []).map((c) => ({
        name: c.name,
        weightShare: round(c.weightShare, 3),
        percent: round(c.percent, 1),
        earned: round(c.earned, 1),
        possible: round(c.possible, 1),
        graded: c.count,
        dragPoints: c.dragPoints,
      })),
      trend,
      missing,
      whatIf: {
        probeAssignmentPoints: probeSize,
        probeCategory: heaviest?.name ?? null,
        toReachNextLetter: toNextLetter,
        toStayAtCurrentLetter: toHoldLetter,
      },
    });
  }

  courseReports.sort((a, b) => a.percent - b.percent);

  const termGpa = gpaFromCourses(courseReports, settings);
  const cumulative = gpaFromTranscript(data.transcript, settings);
  const goal = settings.goal || {};
  const targetGpa = goal.targetGpaUnweighted ?? 4.0;

  // Rough remaining credits: 6 credits/year for the years left before graduation.
  const yearsLeft = Math.max(0, 12 - (Number(goal.gradeLevel) || 11) + 1);
  const runway = gpaRunway(cumulative, targetGpa, yearsLeft * 6);

  const actions = rankActions(courseReports, termGpa, settings);
  const risks = findRisks(courseReports, settings);
  const history = gradeHistory(snapshots, courseReports);

  return {
    generatedAt: Date.now(),
    scale,
    termGpa,
    cumulative,
    icReportedGpa: data.gpaSummary ?? null,
    runway,
    courses: courseReports,
    actions,
    risks,
    history,
    coverage: {
      courses: courseReports.length,
      coursesWithAssignments: courseReports.filter((c) => c.trend.n > 0).length,
      transcriptRows: (data.transcript || []).length,
      scheduleRows: (data.schedule || []).length,
      documentCount: (data.documents || []).length,
      capturedAt: data.capturedAt,
    },
    documents: (data.documents || []).map((d) => ({
      name: d.name, type: d.type, endYear: d.endYear,
    })),
    // The actual prior-year courses. Aggregates alone cannot answer "which
    // subjects am I strong in" or "where did my GPA slip".
    transcriptCourses: (data.transcript || []).map((t) => ({
      courseName: t.courseName,
      score: t.score,
      credits: t.creditsEarned,
      gradeLevel: t.gradeLevel,
      endYear: t.endYear,
      rigor: t.rigor,
      school: t.schoolName || null,
    })),
    transcriptSource: data.transcriptSource || (data.transcript || []).length ? 'available' : 'none',
  };
}

/** The cutoff of the letter grade currently held, i.e. the floor to defend. */
function scaleFloorFor(percent, scaleName) {
  const table = SCALES[scaleName] || SCALES.standard;
  const letter = letterFor(percent, scaleName);
  const row = table.find(([l]) => l === letter);
  return row ? row[1] : 0;
}

function medianAssignmentSize(task, categoryId) {
  const sizes = [];
  for (const cat of task.categories || []) {
    if (categoryId && cat.id !== categoryId) continue;
    for (const a of cat.assignments || []) {
      if (a.possible > 0 && !a.dropped) sizes.push(a.possible);
    }
  }
  if (!sizes.length) return null;
  sizes.sort((a, b) => a - b);
  return sizes[Math.floor(sizes.length / 2)];
}

/** Rank concrete moves by how much GPA each one buys. */
function rankActions(courses, termGpa, settings) {
  const credits = termGpa.credits || courses.length || 1;
  const out = [];

  for (const c of courses) {
    const cr = c.credits && c.credits > 0 ? c.credits : 1;

    if (c.missing.allFixedDelta && c.missing.allFixedDelta > 0.01) {
      const after = c.percent + c.missing.allFixedDelta;
      const gain = gpaPointsFor(after, settings, c) - gpaPointsFor(c.percent, settings, c);
      out.push({
        type: 'recover-missing',
        course: c.name,
        detail: `Turn in / make up ${c.missing.count} missing or zero-scored item(s)`,
        gradeDelta: c.missing.allFixedDelta,
        newPercent: round(after, 2),
        newLetter: letterFor(after, settings.scale),
        gpaDelta: round((gain * cr) / credits, 3),
        topItems: c.missing.items.slice(0, 5),
      });
    }

    if (c.nextLetter && c.nextLetter.gap <= 6) {
      const after = c.nextLetter.atPercent;
      const gain = gpaPointsFor(after, settings, c) - gpaPointsFor(c.percent, settings, c);
      out.push({
        type: 'reach-next-letter',
        course: c.name,
        detail: `Only ${c.nextLetter.gap} points from a ${c.nextLetter.letter}`,
        gradeDelta: c.nextLetter.gap,
        newPercent: after,
        newLetter: c.nextLetter.letter,
        gpaDelta: round((gain * cr) / credits, 3),
        how: c.whatIf.toReachNextLetter,
      });
    }

    const weakest = c.categories
      .filter((k) => k.graded >= 2 && k.percent !== null)
      .sort((a, b) => (b.dragPoints ?? 0) - (a.dragPoints ?? 0))[0];
    if (weakest && weakest.dragPoints > 2) {
      out.push({
        type: 'fix-category',
        course: c.name,
        detail: `"${weakest.name}" is at ${weakest.percent}% and costs about ${weakest.dragPoints} points of the course grade`,
        gradeDelta: weakest.dragPoints,
        gpaDelta: null,
        category: weakest,
      });
    }
  }

  return out
    .sort((a, b) => (b.gpaDelta ?? 0) - (a.gpaDelta ?? 0) || (b.gradeDelta ?? 0) - (a.gradeDelta ?? 0))
    .slice(0, 15);
}

function gpaPointsFor(percent, settings, course) {
  const letter = letterFor(percent, settings.scale);
  const base = GPA_POINTS[letter] ?? 0;
  if (!settings.weightedGpa) return base;
  const rigor = settings.rigorOverrides?.[course.id] ?? course.rigor ?? 'regular';
  return letter === 'F' ? base : base + (RIGOR_BUMP[rigor] ?? 0);
}

function findRisks(courses, settings) {
  const risks = [];
  for (const c of courses) {
    if (c.cushionToDrop !== null && c.cushionToDrop <= 1.5) {
      risks.push({ level: 'high', course: c.name, why: `${c.cushionToDrop} points above dropping from ${c.letter}` });
    }
    if (c.trend.direction === 'declining') {
      risks.push({ level: 'high', course: c.name, why: `Scores sliding: last 5 average ${c.trend.last5Mean}% vs ${c.trend.priorMean}% before` });
    }
    if (c.missing.count >= 3) {
      risks.push({ level: 'high', course: c.name, why: `${c.missing.count} missing or zero-scored assignments` });
    }
    if (c.percent < 70) {
      risks.push({ level: 'critical', course: c.name, why: `Course grade is ${c.percent}% (${c.letter})` });
    }
    if (c.trend.lateCount >= 3) {
      risks.push({ level: 'medium', course: c.name, why: `${c.trend.lateCount} assignments marked late` });
    }
    for (const k of c.categories) {
      if (k.graded >= 2 && k.percent !== null && k.percent < 65) {
        risks.push({ level: 'medium', course: c.name, why: `Category "${k.name}" at ${k.percent}%` });
      }
    }
  }
  const order = { critical: 0, high: 1, medium: 2, low: 3 };
  return risks.sort((a, b) => order[a.level] - order[b.level]).slice(0, 25);
}

/** Day-over-day movement, from the local snapshot log. */
function gradeHistory(snapshots, courses) {
  if (!snapshots?.length) return { days: 0, courses: [] };
  const byCourse = new Map(courses.map((c) => [c.id, []]));
  for (const snap of snapshots) {
    for (const row of snap.courses || []) {
      if (byCourse.has(row.id)) byCourse.get(row.id).push({ day: snap.day, percent: row.percent });
    }
  }
  const out = [];
  for (const [id, series] of byCourse) {
    if (series.length < 2) continue;
    const c = courses.find((x) => x.id === id);
    const delta = series[series.length - 1].percent - series[0].percent;
    out.push({
      id,
      name: c?.name,
      from: series[0],
      to: series[series.length - 1],
      change: round(delta, 2),
      series: series.slice(-30),
    });
  }
  return { days: snapshots.length, courses: out.sort((a, b) => a.change - b.change) };
}

/** The per-day row we persist so trends survive across terms. */
export function snapshotOf(report) {
  return {
    day: isoDay(),
    ts: Date.now(),
    gpa: report.termGpa?.unweighted ?? null,
    weightedGpa: report.termGpa?.weighted ?? null,
    courses: report.courses.map((c) => ({
      id: c.id, name: c.name, percent: c.percent, letter: c.letter,
      missing: c.missing.count ?? 0,
    })),
  };
}
