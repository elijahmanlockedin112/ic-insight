// End-to-end check of the parts that do not need a browser:
// IC payload -> canonical dataset -> deterministic report.
// Run: node test/run.mjs

import { extract, assignmentCount } from '../src/common/normalize.js';
import { analyze } from '../src/common/analysis.js';
import { DEFAULT_SETTINGS } from '../src/common/storage.js';
import { buildBrief, redactReport, systemPrompt } from '../src/background/prompt.js';
import { derivePrefixes, planRound } from '../src/background/crawler.js';
import { allPayloads } from './fixtures.mjs';

let passed = 0;
let failed = 0;

function check(label, actual, expected, tolerance = 0.01) {
  const ok = typeof expected === 'number'
    ? Math.abs(actual - expected) <= tolerance
    : JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passed++;
    console.log(`  ok   ${label} = ${fmt(actual)}`);
  } else {
    failed++;
    console.log(`  FAIL ${label}: got ${fmt(actual)}, expected ${fmt(expected)}`);
  }
}

function truthy(label, value) {
  if (value) { passed++; console.log(`  ok   ${label}`); }
  else { failed++; console.log(`  FAIL ${label}`); }
}

const fmt = (v) => (typeof v === 'object' ? JSON.stringify(v) : String(v));

// ---------------------------------------------------------------- normalize

console.log('\n== normalize ==');
const data = extract(allPayloads);

check('courses found', data.courses.length, 4);

// Regression: /campus/api/portal/assignment/listView returns a flat array of
// assignments, not assignments nested under courses. An earlier version matched
// them with looksLikeAssignment but had no branch to claim them, so every one
// was parsed and silently discarded - courses stayed empty and the crawler
// re-requested the same sections on every run.
const usHistory = data.courses.find((c) => c.name === 'US History');
truthy('a course known only from listView is created',
  usHistory !== undefined);
check('listView assignments are attached', assignmentCount(usHistory), 3);
truthy('a listView-only task is marked approximate',
  usHistory.gradingTasks[0].approximate === true);
truthy('a missing listView assignment keeps its flag',
  usHistory.gradingTasks[0].categories
    .flatMap((c) => c.assignments).some((a) => a.missing === true));
check('listView assignments group by their own category',
  usHistory.gradingTasks[0].categories.length, 3);

// The same assignment appearing in both the roster and listView must count once.
check('an assignment present in both payloads is not double-counted',
  assignmentCount(data.courses.find((c) => c.name === 'AP Calculus AB')), 7);
check('transcript rows', data.transcript.length, 12);
check('schedule rows', data.schedule.length, 3);
truthy('student identified', data.student?.personID === '987654');
truthy('GPA summary captured', data.gpaSummary?.unweighted === 3.62);

const calc = data.courses.find((c) => c.name === 'AP Calculus AB');
truthy('AP Calculus detected as AP rigor', calc.rigor === 'ap');
check('AP Calculus grading tasks', calc.gradingTasks.length, 1);
check('AP Calculus categories', calc.gradingTasks[0].categories.length, 3);

const hw = calc.gradingTasks[0].categories.find((c) => c.name === 'Homework');
check('Homework assignments parsed', hw.assignments.length, 4);
truthy('ungraded future assignment marked notGraded',
  hw.assignments.find((a) => a.name === 'HW 3.1').notGraded === true);
truthy('missing assignment flagged',
  hw.assignments.find((a) => a.name === 'HW 2.4-2.6').missing === true);

// ----------------------------------------------------------------- analysis

console.log('\n== analysis ==');
const settings = {
  ...DEFAULT_SETTINGS,
  goal: { ...DEFAULT_SETTINGS.goal, preset: 'ivy', targetGpaUnweighted: 3.9, gradeLevel: 11 },
};
const report = analyze(data, settings, []);

const rCalc = report.courses.find((c) => c.name === 'AP Calculus AB');
const rEng = report.courses.find((c) => c.name === 'English 11');
const rChem = report.courses.find((c) => c.name === 'Honors Chemistry');

// Weighted by hand:
//   Tests  167/200 = 83.5%  x 0.60
//   HW      20/30  = 66.667% x 0.25   (the ungraded HW 3.1 is excluded)
//   Quiz    18/20  = 90%    x 0.15
//   = 50.1 + 16.667 + 13.5 = 80.267
check('AP Calculus percent', rCalc.percent, 80.27, 0.02);
check('AP Calculus letter', rCalc.letter, 'B-');
// IC reported 80.27 for this course, so that is the headline. Our own weighted
// calculation lands on the same number, which is how we know the category math
// is right without ever letting it override the gradebook.
check('AP Calculus defers to the grade IC reported', rCalc.method, 'reported');
check('AP Calculus weighted math independently agrees', rCalc.computedPercent, 80.27, 0.02);
check('so there is no drift to warn about', rCalc.driftFromIC, 0, 0.02);
truthy('and the course is not flagged as disagreeing', rCalc.modelDisagrees === false);
check('AP Calculus cushion above dropping', rCalc.cushionToDrop, 0.27, 0.02);
check('AP Calculus gap to a B', rCalc.nextLetter.gap, 2.73, 0.02);

// Making up the 0/10 homework: HW becomes 30/30.
//   0.6(0.835) + 0.25(1.0) + 0.15(0.9) = 88.6
check('AP Calculus missing count', rCalc.missing.count, 1);
check('AP Calculus grade if made up', rCalc.missing.allFixedPercent, 88.6, 0.02);
check('AP Calculus gain if made up', rCalc.missing.allFixedDelta, 8.33, 0.02);

// Regression, reported by a real user: "it only looks at the last 8 graded and
// says that is my grade, when my real grade is higher".
//
// US History arrives twice - from the grades endpoint carrying IC's weighted
// 94.2%, and from listView carrying three assignments worth 58/80 = 72.5%
// unweighted. The old dedupe kept whichever record had more assignments, threw
// the reported percentage away, and reported 72.5%. The grade must stay 94.2.
const rHist = report.courses.find((c) => c.name === 'US History');
check('a weighted reported grade survives merging with a listView stub',
  rHist.percent, 94.2, 0.01);
check('and is labelled as IC-reported rather than recomputed', rHist.method, 'reported');
check('while the assignments are still attached for trend analysis',
  rHist.trend.n, 3);
truthy('the course keeps the teacher the grades payload supplied',
  rHist.teacher === 'Whitfield, T');
truthy('missing work is still detected on an approximate course',
  rHist.missing.count === 1);
truthy('a course with a reported grade is NOT flagged an estimate',
  rHist.isEstimate === false);

// A listView-only course with no reported grade anywhere: the number shown is
// our own unweighted estimate and must be labelled as such, never as the grade.
const estimateOnly = analyze(
  extract([{ url: 'https://demo.infinitecampus.org/campus/api/portal/assignment/listView?personID=1',
             ts: Date.now(),
             json: [{ objectSectionID: 1, assignmentName: 'Lab', courseName: 'Physics',
                      sectionID: 4242, totalPoints: 10, scorePoints: '6', dueDate: '2025-09-01' },
                    { objectSectionID: 2, assignmentName: 'Quiz', courseName: 'Physics',
                      sectionID: 4242, totalPoints: 10, scorePoints: '7', dueDate: '2025-09-08' },
                    { objectSectionID: 3, assignmentName: 'Test', courseName: 'Physics',
                      sectionID: 4242, totalPoints: 10, scorePoints: '8', dueDate: '2025-09-15' }] }]),
  settings, []);
const phys = estimateOnly.courses.find((c) => c.name === 'Physics');
truthy('a course IC reported no grade for is flagged as an estimate',
  phys.isEstimate === true);
check('and the estimate is the plain unweighted average', phys.percent, 70, 0.01);

// Total points: (45 + 38 + 50) / 150 = 88.667
check('English percent', rEng.percent, 88.67, 0.02);
check('English method', rEng.method, 'total-points');
check('English letter', rEng.letter, 'B+');

truthy('Chemistry flagged as declining', rChem.trend.direction === 'declining');
truthy('Chemistry has 2 missing items', rChem.missing.count === 2);
truthy('Chemistry appears in risks',
  report.risks.some((r) => r.course === 'Honors Chemistry'));

// What-if inversion. Tests is the heaviest category; a 100-point test:
//   score 0   -> 167/300 = 55.667% -> 63.567 overall
//   score 100 -> 267/300 = 89%     -> 83.567 overall
//   to hit 83 -> ((83 - 63.567) / 20) * 100 = 97.2 points
const wi = rCalc.whatIf.toReachNextLetter;
check('what-if probe size', rCalc.whatIf.probeAssignmentPoints, 100);
check('what-if resulting if perfect', wi.resultingIfPerfect, 83.57, 0.02);
check('what-if resulting if zero', wi.resultingIfZero, 63.57, 0.02);
check('what-if points needed for a B', wi.needed, 97.2, 0.2);
truthy('what-if is achievable', wi.achievable === true);

// GPA. Term: AP Calc B- (2.7 + 1.0 AP), English B+ (3.3), Chem (honors +0.5).
truthy('term GPA computed', report.termGpa.unweighted > 0);
truthy('weighted term GPA exceeds unweighted',
  report.termGpa.weighted > report.termGpa.unweighted);

// Transcript: 10 courses at 1.0 credit + 2 at 0.5 = 11.0 credits.
// Points: (3.7+3.3+4+3+4) + (3.3+3+3.7+4+3.7) + (4*0.5 + 4*0.5) = 39.7 -> 39.7/11 = 3.609
check('cumulative credits', report.cumulative.credits, 11);
check('cumulative unweighted GPA', report.cumulative.unweighted, 3.609, 0.005);
check('transcript years', report.cumulative.byYear.length, 2);

truthy('goal runway computed', report.runway !== null);
truthy('ranked actions produced', report.actions.length > 0);
truthy('top action is the highest-GPA move',
  report.actions[0].gpaDelta >= (report.actions[1]?.gpaDelta ?? 0));

// Regression from a real district's diagnostic: roster returned 200 and yielded
// 5 schedule rows but 0 courses. Its section objects carry courseName +
// sectionID + periodName but no gradingTasks array, so looksLikeCourse rejected
// them, they fell through to the schedule predicate, and every course ended up
// as a listView-only stub with no official grade.
console.log('\n== roster shells ==');
const rosterShellData = extract([
  {
    url: 'https://x.infinitecampus.org/campus/resources/portal/roster?personID=1',
    ts: Date.now(),
    json: [{
      sectionID: 296599, courseName: 'Biology', courseNumber: 'SC101',
      teacherDisplay: 'Alvarez, R', periodName: '4', roomName: '210', termName: 'Q1',
    }],
  },
  {
    url: 'https://x.infinitecampus.org/campus/api/portal/assignment/listView?personID=1',
    ts: Date.now(),
    json: [
      { objectSectionID: 11, assignmentName: 'Cell quiz', courseName: 'Biology',
        sectionID: 296599, totalPoints: 20, scorePoints: '18', dueDate: '2025-09-05' },
      { objectSectionID: 12, assignmentName: 'Lab write-up', courseName: 'Biology',
        sectionID: 296599, totalPoints: 30, scorePoints: '27', dueDate: '2025-09-12' },
    ],
  },
]);
check('a roster section with no gradingTasks still becomes a course',
  rosterShellData.courses.length, 1);
const bio = rosterShellData.courses[0];
check('and keeps its real name', bio.name, 'Biology');
truthy('and its teacher', bio.teacher === 'Alvarez, R');
truthy('and its period', String(bio.period) === '4');
check('and merges the listView assignments rather than duplicating the course',
  assignmentCount(bio), 2);
check('while still appearing in the schedule', rosterShellData.schedule.length, 1);

// ------------------------------------------------------------------ prompt

console.log('\n== prompt ==');
const redacted = redactReport(report, data, settings);
const asText = JSON.stringify(redacted);
truthy('student first name removed', !asText.includes('Jordan'));
truthy('teacher name removed', !asText.includes('Ramirez'));
truthy('course names preserved', asText.includes('AP Calculus AB'));

const brief = buildBrief(redacted, settings);
truthy('brief carries per-assignment detail',
  brief.courses.some((c) => (c.trend.allGradedAssignments || []).length > 0));

// Regression: the brief used to send only the last 8 graded assignments, which
// both starved the analysis and invited the model to average them into a
// "grade" that contradicted the real one.
const calcBrief = brief.courses.find((c) => c.name === 'AP Calculus AB');
check('every graded assignment reaches the model, not a tail',
  calcBrief.trend.allGradedAssignments.length, calcBrief.trend.gradedCount);
truthy('the brief marks when a grade is approximate',
  brief.courses.every((c) => typeof c.gradeIsApproximate === 'boolean'));
truthy('the system prompt forbids averaging assignments into a grade',
  systemPrompt(settings).includes('gradePercent` IS the course grade'));
truthy('brief carries ranked actions', brief.rankedActions.length > 0);
truthy('brief carries goal math', brief.goalMath !== null);

// Regression: 18 documents were being captured and none of them reached the
// model, while the system prompt claimed it was reading "their transcript".
truthy('the model is told which documents exist',
  brief.availableDocuments.files.some((f) => /transcript/i.test(f.name)));
truthy('document URLs are withheld (they carry the student personID)',
  brief.availableDocuments.files.every((f) => f.url === undefined));
truthy('and the model is told it cannot read their contents',
  /CONTENTS are not/.test(brief.availableDocuments.note));
truthy('document count reaches coverage', brief.dataCoverage.documentCount > 0);
truthy('the system prompt no longer claims to have the transcript',
  !systemPrompt(settings).includes('gradebook, schedule and transcript'));
truthy('and explains that zero transcript rows is expected',
  systemPrompt(settings).includes('expected, not an error'));
console.log(`  info brief size: ${(JSON.stringify(brief).length / 1024).toFixed(1)} KB`);

const sys = systemPrompt(settings);
truthy('system prompt mentions the chosen goal', sys.includes('Ivy'));
truthy('system prompt forbids recomputation', sys.includes('Do not recompute'));

// ----------------------------------------------------------------- crawler

console.log('\n== crawler ==');
const origin = 'https://demo.infinitecampus.org';
const seen = allPayloads.map((p) => p.url);

check('district prefix inferred as root', derivePrefixes(seen, origin)[0], '');
check('a sub-mounted district prefix is learned',
  derivePrefixes([origin + '/dist7/campus/api/portal/students'], origin)[0], '/dist7');

// Regression: an earlier version iterated template-major and burned its whole
// per-round budget on the first candidate, so the correct endpoint was never
// reached. Round 0 must always produce the confirmed identity path.
const bootstrap = planRound({ round: 0, origin, data: null, seenUrls: seen, deadUrls: [] });
truthy('round 0 requests the confirmed identity endpoint',
  bootstrap.urls.includes(origin + '/campus/api/portal/students'));
check('round 0 is a single request, not a sweep', bootstrap.urls.length, 1);
truthy('planned URLs stay on the portal origin',
  bootstrap.urls.every((u) => u.startsWith(origin)));

// Round 1 needs the personID that round 0 supplies.
const noId = planRound({ round: 1, origin, data: null, seenUrls: seen, deadUrls: [] });
check('round 1 plans nothing without a personID', noId.urls.length, 0);

const withId = planRound({ round: 1, origin, data, seenUrls: seen, deadUrls: [] });
truthy('round 1 requests the confirmed roster endpoint',
  withId.urls.some((u) => u.includes('/campus/resources/portal/roster?personID=987654')));
truthy('round 1 requests the confirmed grades endpoint',
  withId.urls.some((u) => u.includes('/campus/resources/portal/grades?personID=987654')));
truthy('round 1 fills structureID from the enrollment record',
  withId.urls.some((u) => u.includes('/displayOptions/7701')));

// Feature flags: disabled modules must never be requested at all.
truthy('district feature flags captured', data.displayOptions?.grades === true);
const gated = planRound({
  round: 2,
  origin,
  data: { ...data, displayOptions: { ...data.displayOptions, documents: false } },
  seenUrls: seen,
  deadUrls: [],
});
truthy('a disabled module is never requested',
  !gated.urls.some((u) => u.includes('report/all')));

const enabled = planRound({ round: 2, origin, data, seenUrls: seen, deadUrls: [] });
truthy('an enabled module is requested',
  enabled.urls.some((u) => u.includes('/campus/resources/portal/report/all')));

const deadAll = planRound({
  round: 0, origin, data: null, seenUrls: seen, deadUrls: bootstrap.urls,
});
check('known-dead URLs are never requested again', deadAll.urls.length, 0);

check('enrollment metadata extracted', data.enrollments.length, 1);
check('structureID extracted', data.enrollments[0].structureID, '7701');
check('documents extracted', data.documents.length, 2);
truthy('the transcript is found as a downloadable document',
  data.documents.some((d) => /transcript/i.test(d.name)));


// -------------------------------------------------------------------- done

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
