// Turns transcript TEXT into the same row shape the grades endpoint produces,
// so cumulative GPA, credits and year-over-year trends all work off it without
// any other part of the extension knowing where the text came from.
//
// Infinite Campus publishes transcripts as PDFs and exposes no endpoint that
// returns their data, so text is the only way in. It arrives either from the
// PDF extractor or from the student pasting it - this file does not care which.
//
// Transcript layouts differ by district, so every row carries a confidence and
// nothing is committed until the student has seen the parse and approved it.

import { num, rigorOf } from './util.js';

const GRADE_TOKEN = /^(A\+|A|A-|B\+|B|B-|C\+|C|C-|D\+|D|D-|F|P|NP|CR|NC|I|W|WP|WF)$/i;

// Lines that are furniture rather than courses.
const NOISE = /^(total|cumulative|weighted|unweighted|gpa|credits?|earned|attempted|summary|transcript|official|student|school|address|phone|date|page|printed|signature|class rank|rank|graduation|state id|birth|dob|course\s*(#|number|title)|grade\s*level|term|year|semester|quarter|marking period)\b/i;

const YEAR_RANGE = /\b(20\d{2})\s*[-‐-―]\s*(20\d{2})\b/;
const GRADE_LEVEL = /\bgrade\s*(?:level)?\s*:?\s*(0?[6-9]|1[0-2])\b/i;

/**
 * Candidate row patterns, tried in order. Each must capture a course name, a
 * letter grade and a credit figure; extra numeric columns (quality points, GPA
 * value) are tolerated and ignored.
 */
const PATTERNS = [
  // MAT200  Algebra II            A-    1.000   4.000
  {
    re: /^\s*([A-Z]{2,6}[\s-]?\d{2,5}[A-Z]?)\s+(.+?)\s+([A-Za-z][+-]?)\s+(\d{1,2}(?:\.\d{1,3})?)(?:\s+\d+(?:\.\d+)?)*\s*$/,
    map: (m) => ({ courseNumber: m[1], courseName: m[2], score: m[3], credits: m[4] }),
  },
  // Algebra II                    A-    1.000
  {
    re: /^\s*(.+?)\s+([A-Za-z][+-]?)\s+(\d{1,2}(?:\.\d{1,3})?)(?:\s+\d+(?:\.\d+)?)*\s*$/,
    map: (m) => ({ courseName: m[1], score: m[2], credits: m[3] }),
  },
  // Algebra II            1.000    A-        (credits before grade)
  {
    re: /^\s*(.+?)\s+(\d{1,2}(?:\.\d{1,3})?)\s+([A-Za-z][+-]?)\s*$/,
    map: (m) => ({ courseName: m[1], credits: m[2], score: m[3] }),
  },
];

/**
 * @param {string} text
 * @returns {{rows: Array, warnings: string[], yearsSeen: number[], lineCount: number}}
 */
export function parseTranscriptText(text) {
  const warnings = [];
  const rows = [];
  const yearsSeen = new Set();

  if (!text || !text.trim()) {
    return { rows, warnings: ['Nothing to parse - the text was empty.'], yearsSeen: [], lineCount: 0 };
  }

  // Normalise the whitespace PDFs love to scatter around.
  const lines = String(text)
    .replace(/\r/g, '\n')
    .replace(/ /g, ' ')
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  let endYear = null;
  let gradeLevel = null;
  let schoolName = null;

  for (const line of lines) {
    // Year and grade-level headers set the context for the rows beneath them.
    const yr = line.match(YEAR_RANGE);
    if (yr) {
      endYear = Number(yr[2]);
      yearsSeen.add(endYear);
    }
    const gl = line.match(GRADE_LEVEL);
    if (gl) gradeLevel = String(Number(gl[1]));
    if (/high school|middle school|academy|\bH\.?S\.?\b/i.test(line) && line.length < 80) {
      schoolName = line;
    }

    if (NOISE.test(line)) continue;
    if (line.length < 5 || line.length > 160) continue;

    const parsed = matchRow(line);
    if (!parsed) continue;

    const credits = num(parsed.credits);
    const score = parsed.score.toUpperCase();
    const courseName = parsed.courseName.replace(/[.\s]+$/, '').trim();

    // A course name that is mostly digits is a stray numeric column, not a course.
    if (!courseName || courseName.replace(/[^A-Za-z]/g, '').length < 3) continue;
    if (!GRADE_TOKEN.test(score)) continue;
    if (credits === null || credits < 0 || credits > 20) continue;

    rows.push({
      id: `tx-${rows.length}-${courseName.slice(0, 20).replace(/\W/g, '')}`,
      courseName,
      courseNumber: parsed.courseNumber ? parsed.courseNumber.trim() : null,
      score,
      percent: null,
      creditsEarned: credits,
      creditsAttempted: credits,
      gpaValue: null,       // derived from the letter by analysis.js
      weightedGpaValue: null,
      bonusPoints: null,
      gradeLevel,
      endYear,
      termName: null,
      schoolName,
      rigor: rigorOf(courseName),
      source: 'transcript-import',
      confidence: parsed.courseNumber ? 'high' : 'medium',
    });
  }

  if (!rows.length) {
    warnings.push(
      'No course rows were recognised. Transcript layouts vary a lot - check that the text ' +
      'includes course names with their letter grades and credits on the same line.',
    );
  }
  if (rows.length && !yearsSeen.size) {
    warnings.push(
      'No school years were found, so every course is filed under one period. ' +
      'Year-over-year trends will not be available, but cumulative GPA still works.',
    );
  }
  const noCredit = rows.filter((r) => r.creditsEarned === 0).length;
  if (noCredit) {
    warnings.push(`${noCredit} course(s) parsed with zero credits; they will not affect GPA.`);
  }

  return { rows, warnings, yearsSeen: [...yearsSeen].sort(), lineCount: lines.length };
}

function matchRow(line) {
  for (const { re, map } of PATTERNS) {
    const m = line.match(re);
    if (m) {
      const out = map(m);
      // The second pattern happily eats a trailing word as the "grade", so make
      // sure what it captured is actually a grade token before accepting it.
      if (GRADE_TOKEN.test(out.score)) return out;
    }
  }
  return null;
}

/** A short human summary for the confirmation step. */
export function summariseParse(result) {
  const byYear = new Map();
  for (const r of result.rows) {
    const key = r.endYear ?? 'unknown';
    byYear.set(key, (byYear.get(key) || 0) + 1);
  }
  const credits = result.rows.reduce((s, r) => s + (r.creditsEarned || 0), 0);
  return {
    courses: result.rows.length,
    credits: Math.round(credits * 100) / 100,
    years: [...byYear.entries()]
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
      .map(([year, n]) => ({ year, courses: n })),
  };
}
