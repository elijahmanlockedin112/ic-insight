// End-to-end check of the parts that do not need a browser:
// IC payload -> canonical dataset -> deterministic report.
// Run: node test/run.mjs

import { extract } from '../src/common/normalize.js';
import { analyze } from '../src/common/analysis.js';
import { DEFAULT_SETTINGS } from '../src/common/storage.js';
import { buildBrief, redactReport, systemPrompt } from '../src/background/prompt.js';
import { deriveBases, planRound, gapsIn } from '../src/background/crawler.js';
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

check('courses found', data.courses.length, 3);
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
check('AP Calculus method', rCalc.method, 'weighted');
check('AP Calculus cushion above dropping', rCalc.cushionToDrop, 0.27, 0.02);
check('AP Calculus gap to a B', rCalc.nextLetter.gap, 2.73, 0.02);

// Making up the 0/10 homework: HW becomes 30/30.
//   0.6(0.835) + 0.25(1.0) + 0.15(0.9) = 88.6
check('AP Calculus missing count', rCalc.missing.count, 1);
check('AP Calculus grade if made up', rCalc.missing.allFixedPercent, 88.6, 0.02);
check('AP Calculus gain if made up', rCalc.missing.allFixedDelta, 8.33, 0.02);

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

// ------------------------------------------------------------------ prompt

console.log('\n== prompt ==');
const redacted = redactReport(report, data, settings);
const asText = JSON.stringify(redacted);
truthy('student first name removed', !asText.includes('Jordan'));
truthy('teacher name removed', !asText.includes('Ramirez'));
truthy('course names preserved', asText.includes('AP Calculus AB'));

const brief = buildBrief(redacted, settings);
truthy('brief carries per-assignment detail',
  brief.courses.some((c) => (c.trend.recentAssignments || []).length > 0));
truthy('brief carries ranked actions', brief.rankedActions.length > 0);
truthy('brief carries goal math', brief.goalMath !== null);
console.log(`  info brief size: ${(JSON.stringify(brief).length / 1024).toFixed(1)} KB`);

const sys = systemPrompt(settings);
truthy('system prompt mentions the chosen goal', sys.includes('Ivy'));
truthy('system prompt forbids recomputation', sys.includes('Do not recompute'));

// ----------------------------------------------------------------- crawler

console.log('\n== crawler ==');
const origin = 'https://demo.infinitecampus.org';
const seen = allPayloads.map((p) => p.url);
const bases = deriveBases(seen, origin);
truthy('learned the resources base from observed traffic',
  bases.includes('/campus/resources/portal/'));
truthy('learned the api base from observed traffic',
  bases.includes('/campus/api/portal/'));

check('no gaps once everything is captured', gapsIn(data), []);

const emptyPlan = planRound({ round: 0, origin, data: null, seenUrls: seen, deadUrls: [] });
truthy('bootstrap round plans identity + roster requests', emptyPlan.urls.length > 0);
truthy('bootstrap respects the per-round cap', emptyPlan.urls.length <= 14);
truthy('planned URLs stay on the portal origin',
  emptyPlan.urls.every((u) => u.startsWith(origin)));

const deadAll = planRound({
  round: 0, origin, data: null, seenUrls: seen, deadUrls: emptyPlan.urls,
});
check('known-dead URLs are never requested again', deadAll.urls.length, 0);

// -------------------------------------------------------------------- done

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
