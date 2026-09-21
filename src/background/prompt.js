// Builds what the model actually sees.
//
// Two principles:
//   - Every number in the brief was computed locally in analysis.js. The model
//     is told to treat them as settled and never to recompute them, because
//     language models are worse at arithmetic than a spreadsheet is.
//   - Identifying details are stripped by default. The provider sees grades and
//     course names, not who the student is.

export const GOAL_PRESETS = {
  'straight-a': {
    label: "Keep straight A's",
    brief: 'Hold an A in every course. Protect cushions; treat any course under 93% as the priority.',
  },
  ivy: {
    label: 'Highly selective colleges (Ivy / T20)',
    brief:
      'Aim for a near-perfect unweighted GPA with the most demanding course load the school offers. ' +
      'At this tier a single B is a real cost and rigor matters as much as the grade, so flag both ' +
      'grade risk and any place the schedule is less rigorous than it could be.',
  },
  'state-flagship': {
    label: 'State flagship / competitive public',
    brief:
      'Target roughly a 3.7+ unweighted with solid rigor. A stray B is survivable; a C is not. ' +
      'Prioritise consistency over perfection.',
  },
  'raise-gpa': {
    label: 'Raise my GPA to a specific number',
    brief: 'Focus entirely on the moves with the largest GPA effect per hour of work.',
  },
  pass: {
    label: 'Pass everything / stay eligible',
    brief:
      'The goal is credit, not excellence. Focus on anything below passing, on missing work, and on ' +
      'the smallest set of actions that clears each course above the line. Be practical and calm.',
  },
  custom: { label: 'Something else', brief: '' },
};

const TONE = {
  direct: 'Be direct and matter-of-fact. Skip praise that is not earned. Lead with the problem.',
  encouraging:
    'Be warm and encouraging without sugar-coating the numbers. Acknowledge real progress where the ' +
    'data shows it, then move to what is next.',
  blunt:
    'Be blunt. Say plainly what is going badly and why. No cheerleading. Still fair: do not ' +
    'exaggerate a problem the numbers do not support.',
};

// ------------------------------------------------------------------ redaction

function redactText(s, map) {
  if (typeof s !== 'string' || !s) return s;
  let out = s;
  for (const [real, fake] of map) {
    if (real && real.length > 2) {
      out = out.replace(new RegExp(escapeRe(real), 'gi'), fake);
    }
  }
  return out;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Strip names and IDs from the report before it leaves the machine. */
export function redactReport(report, data, settings) {
  if (!settings.redactNames) return report;

  const map = [];
  const student = data?.student;
  if (student?.firstName) map.push([student.firstName, 'the student']);
  if (student?.lastName) map.push([student.lastName, '']);

  const teachers = new Set();
  for (const c of data?.courses || []) if (c.teacher) teachers.add(String(c.teacher));
  let i = 0;
  for (const t of teachers) map.push([t, `Teacher ${String.fromCharCode(65 + (i++ % 26))}`]);

  const clone = JSON.parse(JSON.stringify(report));

  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node)) {
      if (typeof v === 'string') node[k] = redactText(v, map);
      else if (v && typeof v === 'object') walk(v);
    }
    if ('teacher' in node && node.teacher) node.teacher = redactText(String(node.teacher), map);
  };
  walk(clone);

  if (!settings.shareAssignmentTitles) {
    let n = 0;
    const blank = (list) => {
      for (const item of list || []) if (item && item.name) item.name = `Assignment ${++n}`;
    };
    for (const c of clone.courses || []) {
      blank(c.trend?.recent);
      blank(c.trend?.worst);
      blank(c.missing?.items);
    }
  }

  return clone;
}

// ------------------------------------------------------------------- brief

/** Trim the report to what is worth paying tokens for. */
export function buildBrief(report, settings) {
  const goal = settings.goal || {};
  return {
    gradingScale: report.scale,
    asOf: new Date(report.generatedAt).toISOString().slice(0, 10),
    dataCoverage: report.coverage,

    gpa: {
      currentTermUnweighted: report.termGpa?.unweighted ?? null,
      currentTermWeighted: report.termGpa?.weighted ?? null,
      cumulativeUnweighted: report.cumulative?.unweighted ?? null,
      cumulativeWeighted: report.cumulative?.weighted ?? null,
      cumulativeCredits: report.cumulative?.credits ?? null,
      byYear: report.cumulative?.byYear ?? [],
      reportedByInfiniteCampus: report.icReportedGpa ?? null,
    },

    goalMath: report.runway,

    courses: (report.courses || []).map((c) => ({
      name: c.name,
      rigor: c.rigor,
      term: c.term,
      // null when the school reported no grade. The assignment average is kept
      // separately so it can never be mistaken for the real figure.
      gradePercent: c.isEstimate ? null : c.percent,
      assignmentAverageEstimate: c.isEstimate ? c.percent : null,
      letter: c.isEstimate ? null : c.letter,
      howComputed: c.method,
      // The grade is an unweighted estimate, not the school's figure.
      gradeIsEstimateNotOfficial: c.isEstimate || false,
      gradeIsApproximate: c.approximate || false,
      locallyComputedPercent: c.computedPercent,
      driftFromSchoolGrade: c.driftFromIC,
      pointsAboveDroppingALetter: c.cushionToDrop,
      nextLetter: c.nextLetter,
      categories: c.categories,
      trend: {
        direction: c.trend.direction,
        gradedCount: c.trend.n,
        last5Average: c.trend.last5Mean,
        earlierAverage: c.trend.priorMean,
        shift: c.trend.shift,
        zeros: c.trend.zeroCount,
        lates: c.trend.lateCount,
        weakestCategories: (c.trend.categoryGaps || []).slice(0, 3),
        // Every graded assignment, oldest first. Capped only to bound a
        // pathological course; 400 is far beyond a normal term.
        allGradedAssignments: (c.trend.all || []).slice(-400),
      },
      missingWork: {
        count: c.missing.count,
        gradeIfAllMadeUp: c.missing.allFixedPercent,
        gainIfAllMadeUp: c.missing.allFixedDelta,
        items: (c.missing.items || []).slice(0, 8),
      },
      whatIf: c.whatIf,
    })),

    // Names and years only. The URLs carry the student's personID, and the
    // files are PDFs the extension cannot read, so there is nothing else to send.
    availableDocuments: {
      note: 'Infinite Campus publishes these as PDF files. Their CONTENTS are not ' +
            'available to you - only these titles. Do not infer grades, credits or ' +
            'GPA from them.',
      files: report.documents || [],
    },

    rankedActions: report.actions,
    risks: report.risks,
    dayOverDay: report.history,

    student: {
      gradeLevel: goal.gradeLevel ?? null,
      graduationYear: goal.graduationYear ?? null,
      intendedMajor: goal.intendedMajor || null,
      collegesOfInterest: goal.colleges || [],
      weeklyStudyHours: goal.weeklyStudyHours ?? null,
      statedStrengths: goal.strengths || null,
      statedStruggles: goal.struggles || null,
      constraints: goal.constraints || null,
    },
  };
}

// ------------------------------------------------------------------ prompts

export function systemPrompt(settings) {
  const goal = settings.goal || {};
  const preset = GOAL_PRESETS[goal.preset] || GOAL_PRESETS.custom;
  const tone = TONE[goal.tone] || TONE.direct;

  const targets = [];
  if (goal.targetGpaUnweighted) targets.push(`unweighted GPA ${goal.targetGpaUnweighted}`);
  if (goal.targetGpaWeighted) targets.push(`weighted GPA ${goal.targetGpaWeighted}`);

  return [
    'You are an academic coach for a high school student. You are reading a structured brief',
    'generated from their own Infinite Campus gradebook and schedule.',
    '',
    'Transcript CONTENTS are not in the brief. Infinite Campus publishes transcripts as PDF',
    'files and exposes no endpoint that returns their data, so `availableDocuments` lists only',
    'titles. Cumulative GPA, where present, covers only the terms the grades endpoint returned -',
    'usually the current year. Never present it as a full high-school GPA, never infer prior-year',
    'grades or credits, and when the student needs multi-year figures, say the transcript PDF has',
    'to be opened in the portal.',
    '',
    '## The student\'s goal',
    preset.label + (preset.brief ? ': ' + preset.brief : ''),
    targets.length ? `Stated target: ${targets.join(', ')}.` : '',
    goal.preset === 'custom' && goal.constraints ? `In their words: ${goal.constraints}` : '',
    '',
    '## Hard rules',
    '1. Every number in the brief was computed deterministically before you saw it. Treat percentages,',
    '   GPA figures, point requirements and trend values as settled fact. Do not recompute them, do not',
    '   round them differently, and never state a number that is not in the brief.',
    '2. `gradePercent` IS the course grade. Never derive, estimate or state a grade by averaging the',
    '   assignments in `allGradedAssignments`. Most gradebooks weight categories, so averaging raw',
    '   assignment scores gives a different - usually lower - number than the real grade. Use the',
    '   assignments to explain *why* the grade is what it is and where it is heading, never to',
    '   restate what it is. If `howComputed` is "reported", that figure came from Infinite Campus',
    '   itself and is authoritative. If `gradeIsApproximate` is true, the category weights were not',
    '   available, so say the breakdown is approximate rather than presenting it as exact. If',
    '   `gradeIsEstimateNotOfficial` is true, the school reported no grade at all and the figure is',
    '   our own unweighted estimate. In that case `gradePercent` and `letter` are null and the',
    '   figure sits in `assignmentAverageEstimate`. Never present that as the grade: say the school',
    '   has not posted one and point the student at the portal.',
    '3. Be specific. "Study more" is useless. Name the course, the category or the actual assignment,',
    '   and say what it is worth. The brief gives you per-assignment detail precisely so you can do this.',
    '4. Rank by leverage. The brief includes `rankedActions` with the GPA effect of each move already',
    '   computed. Lead with the actions that buy the most for the least work.',
    '5. Be honest about reachability. If `goalMath` says a target GPA is not reachable, say so plainly',
    '   and pivot to the best achievable outcome. Never imply that a college admission is guaranteed or',
    '   predictable from grades - talk about what is in the student\'s control.',
    '6. Say what you could not see. If `dataCoverage` shows zero transcript rows, no assignments for',
    '   a course, or few graded items, name that limitation instead of guessing around it. Zero',
    '   transcript rows is expected, not an error - say so plainly rather than implying the student',
    '   did something wrong.',
    '7. Do not invent school policies (retake rules, late-work policy, weighting) that are not in the',
    '   brief. Where a policy would change the advice, tell the student to ask the teacher.',
    '',
    '## Tone',
    tone,
    '',
    '## Output format',
    'Markdown. Use these sections, in this order, and keep it tight:',
    '',
    '### Where you stand',
    'Two or three sentences. The real headline, not a recap of every number.',
    '',
    '### Do this week',
    'Three to five numbered actions, highest leverage first. Each one names the course, the specific',
    'assignment or category, and the expected effect using the brief\'s own figures.',
    '',
    '### Course notes',
    'Only the courses that need attention. One short paragraph or a few bullets each. Include any course',
    'that is declining, close to dropping a letter, or carrying missing work.',
    '',
    '### Patterns worth noticing',
    'Assignment-level trends across courses: category weaknesses, late-work habits, a slide that started',
    'at a particular point, a strength worth leaning on.',
    '',
    '### Goal check',
    'What the goal demands from here, using `goalMath`, and whether current trajectory gets there.',
    '',
    '### What I could not see',
    'Data gaps. One or two lines. Omit this section entirely if coverage is complete.',
  ].filter(Boolean).join('\n');
}

export function userPrompt(brief, question) {
  const json = JSON.stringify(brief, null, 1);
  const trimmed = json.length > 500_000 ? json.slice(0, 500_000) + '\n... (truncated)' : json;
  return [
    question
      ? `The student asks: ${question}\n\nAnswer that question first, then give the full analysis below.`
      : 'Analyse this and coach me.',
    '',
    '```json',
    trimmed,
    '```',
  ].join('\n');
}

/** Follow-up turns reuse the same brief without re-sending it. */
export function followUpPrompt(question) {
  return `${question}\n\n(Use the brief already provided. Same rules: only cite numbers from it.)`;
}
