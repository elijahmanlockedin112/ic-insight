// Synthetic payloads shaped like Infinite Campus portal responses.
// Field names follow what Campus Student actually emits; the values are made up.

export const identityPayload = {
  url: 'https://demo.infinitecampus.org/campus/api/portal/students',
  ts: Date.now(),
  json: [
    {
      personID: 987654,
      studentNumber: '2200418',
      firstName: 'Jordan',
      lastName: 'Okafor',
      grade: '11',
      schoolName: 'Riverbend High School',
      enrollments: [
        {
          enrollmentID: 55501,
          calendarID: 3301,
          structureID: 7701,
          schoolName: 'Riverbend High School',
          grade: '11',
          endYear: 2026,
        },
      ],
    },
  ],
};

// The district feature allow-list. Anything false here is never requested.
export const displayOptionsPayload = {
  url: 'https://demo.infinitecampus.org/campus/api/portal/displayOptions/7701?personID=987654',
  ts: Date.now(),
  json: {
    grades: true,
    schedule: true,
    attendance: true,
    documents: true,
    assessment: true,
    behavior: false,
    foodService: false,
    academicPlanner: true,
    progressReport: true,
    customForms: false,
    plan: false,
    documentsIEP: false,
    fees: true,
    portalHomeOnly: false,
    newMessage: false,
    lockers: true,
    transportation: false,
    healthOffice: false,
  },
};

// Transcripts arrive as downloadable files, not as structured JSON.
export const documentsPayload = {
  url: 'https://demo.infinitecampus.org/campus/resources/portal/report/all?personID=987654',
  ts: Date.now(),
  json: [
    {
      name: 'Official Transcript',
      type: 'transcript',
      moduleLabel: 'Grades',
      url: '/campus/resources/portal/report/transcript?personID=987654',
      endYear: 2026,
    },
    {
      name: 'Report Card Q1',
      type: 'reportCard',
      moduleLabel: 'Grades',
      url: '/campus/resources/portal/report/reportCard?personID=987654&termID=1',
      endYear: 2026,
    },
  ],
};

// Weighted-category course with one missing assignment and a downward slide.
const apCalc = {
  sectionID: 1001,
  courseID: 4411,
  courseName: 'AP Calculus AB',
  courseNumber: 'MA430',
  teacherDisplay: 'Ramirez, J',
  periodName: '3',
  roomName: '212',
  termName: 'Q1',
  gradingTasks: [
    {
      taskName: 'Quarter Grade',
      termName: 'Q1',
      groupWeighted: true,
      progressScore: 'B-',
      progressPercent: 80.27,
      categories: [
        {
          groupActivityID: 11,
          name: 'Tests',
          weight: 60,
          assignments: [
            a(5001, 'Unit 1 Test', '2025-09-05', 100, '88'),
            a(5002, 'Unit 2 Test', '2025-09-26', 100, '79'),
          ],
        },
        {
          groupActivityID: 12,
          name: 'Homework',
          weight: 25,
          assignments: [
            a(5010, 'HW 1.1-1.4', '2025-09-02', 10, '10'),
            a(5011, 'HW 2.1-2.3', '2025-09-12', 10, '10'),
            { ...a(5012, 'HW 2.4-2.6', '2025-09-19', 10, '0'), missing: true, turnedIn: false },
            // Assigned but not yet graded: must be excluded from the average.
            { objectSectionID: 5013, assignmentName: 'HW 3.1', dueDate: '2025-10-03', totalPoints: 10 },
          ],
        },
        {
          groupActivityID: 13,
          name: 'Quizzes',
          weight: 15,
          assignments: [a(5020, 'Quiz 2A', '2025-09-16', 20, '18')],
        },
      ],
    },
  ],
};

// Total-points course: no weights at all.
const english = {
  sectionID: 1002,
  courseID: 4412,
  courseName: 'English 11',
  courseNumber: 'EN310',
  teacherDisplay: 'Byrne, P',
  periodName: '1',
  termName: 'Q1',
  gradingTasks: [
    {
      taskName: 'Quarter Grade',
      termName: 'Q1',
      groupWeighted: false,
      categories: [
        {
          groupActivityID: 21,
          name: 'All work',
          weight: 0,
          assignments: [
            a(6001, 'Rhetoric essay', '2025-09-08', 50, '45'),
            { ...a(6002, 'Socratic seminar', '2025-09-18', 50, '38'), late: true },
            a(6003, 'Annotation set', '2025-09-24', 50, '50'),
          ],
        },
      ],
    },
  ],
};

// A course in real trouble, to exercise the risk flags.
const chem = {
  sectionID: 1003,
  courseID: 4413,
  courseName: 'Honors Chemistry',
  courseNumber: 'SC220',
  teacherDisplay: 'Nakamura, L',
  periodName: '5',
  termName: 'Q1',
  gradingTasks: [
    {
      taskName: 'Quarter Grade',
      termName: 'Q1',
      groupWeighted: true,
      categories: [
        {
          groupActivityID: 31,
          name: 'Labs',
          weight: 40,
          assignments: [
            a(7001, 'Density lab', '2025-09-04', 25, '24'),
            a(7002, 'Stoichiometry lab', '2025-09-15', 25, '20'),
            { ...a(7003, 'Gas laws lab', '2025-09-25', 25, '0'), missing: true, turnedIn: false },
          ],
        },
        {
          groupActivityID: 32,
          name: 'Exams',
          weight: 45,
          assignments: [
            a(7010, 'Exam 1', '2025-09-09', 100, '82'),
            a(7011, 'Exam 2', '2025-09-23', 100, '64'),
            a(7012, 'Exam 3', '2025-09-30', 100, '58'),
          ],
        },
        {
          groupActivityID: 33,
          name: 'Practice',
          weight: 15,
          assignments: [
            { ...a(7020, 'Problem set 3', '2025-09-11', 20, '12'), late: true },
            { ...a(7021, 'Problem set 4', '2025-09-22', 20, '0'), missing: true },
          ],
        },
      ],
    },
  ],
};

function a(id, name, due, totalPoints, scorePoints) {
  return {
    objectSectionID: id,
    assignmentName: name,
    dueDate: `${due}T00:00:00.000-05:00`,
    totalPoints,
    scorePoints,
    missing: false,
    late: false,
    turnedIn: true,
  };
}

export const rosterPayload = {
  url: 'https://demo.infinitecampus.org/campus/resources/portal/roster?personID=987654',
  ts: Date.now(),
  json: [apCalc, english, chem],
};

export const schedulePayload = {
  url: 'https://demo.infinitecampus.org/campus/resources/portal/roster?personID=987654&view=schedule',
  ts: Date.now(),
  json: [
    { sectionID: 1002, courseName: 'English 11', periodName: '1', periodSequence: 1, teacherDisplay: 'Byrne, P', roomName: '104', termName: 'Q1', startTime: '08:05', endTime: '08:55' },
    { sectionID: 1001, courseName: 'AP Calculus AB', periodName: '3', periodSequence: 3, teacherDisplay: 'Ramirez, J', roomName: '212', termName: 'Q1', startTime: '10:00', endTime: '10:50' },
    { sectionID: 1003, courseName: 'Honors Chemistry', periodName: '5', periodSequence: 5, teacherDisplay: 'Nakamura, L', roomName: '308', termName: 'Q1', startTime: '12:40', endTime: '13:30' },
  ],
};

export const transcriptPayload = {
  url: 'https://demo.infinitecampus.org/campus/resources/portal/grades?personID=987654',
  ts: Date.now(),
  json: {
    summary: { unweightedGPA: 3.62, weightedGPA: 3.94, classRank: 41, classSize: 388, totalCredits: 11 },
    courses: [
      t('Algebra II', 'A-', 1, 2024, '9'),
      t('Honors Biology', 'B+', 1, 2024, '9'),
      t('English 9', 'A', 1, 2024, '9'),
      t('World History', 'B', 1, 2024, '9'),
      t('Spanish II', 'A', 1, 2024, '9'),
      t('Pre-Calculus', 'B+', 1, 2025, '10'),
      t('Honors Physics', 'B', 1, 2025, '10'),
      t('English 10', 'A-', 1, 2025, '10'),
      t('AP Human Geography', 'A', 1, 2025, '10'),
      t('Spanish III', 'A-', 1, 2025, '10'),
      t('Health', 'A', 0.5, 2025, '10'),
      t('PE', 'A', 0.5, 2025, '10'),
    ],
  },
};

function t(courseName, score, credits, endYear, grade) {
  const points = {
    'A+': 4, A: 4, 'A-': 3.7, 'B+': 3.3, B: 3, 'B-': 2.7,
    'C+': 2.3, C: 2, 'C-': 1.7, D: 1, F: 0,
  }[score];
  return {
    transcriptCourseID: `${courseName}-${endYear}`,
    courseName,
    courseNumber: 'X',
    score,
    creditsEarned: credits,
    creditsAttempted: credits,
    gpaValue: points,
    endYear,
    grade,
    termName: 'Year',
    schoolName: 'Riverbend High School',
  };
}

// The real shape of /campus/api/portal/assignment/listView: a FLAT array, each
// item carrying its own sectionID rather than being nested under a course.
// Section 1004 has no roster entry at all, so it also exercises stub creation.
export const listViewPayload = {
  url: 'https://demo.infinitecampus.org/campus/api/portal/assignment/listView?personID=987654',
  ts: Date.now(),
  json: [
    lv(9001, 'Reading quiz 4', 'US History', 1004, '2025-09-10', 20, '17', 'Quizzes'),
    lv(9002, 'DBQ essay', 'US History', 1004, '2025-09-20', 50, '41', 'Essays'),
    { ...lv(9003, 'Map worksheet', 'US History', 1004, '2025-09-27', 10, '0', 'Practice'),
      missing: true, turnedIn: false },
    // Already present nested in the roster payload: must not be double-counted.
    lv(5001, 'Unit 1 Test', 'AP Calculus AB', 1001, '2025-09-05', 100, '88', 'Tests'),
  ],
};

function lv(id, name, courseName, sectionID, due, totalPoints, scorePoints, categoryName) {
  return {
    objectSectionID: id,
    assignmentName: name,
    courseName,
    sectionID,
    categoryName,
    dueDate: `${due}T00:00:00.000-05:00`,
    totalPoints,
    scorePoints,
    scorePercentage: (Number(scorePoints) / totalPoints) * 100,
    missing: false,
    late: false,
    turnedIn: true,
    dropped: false,
    comments: null,
  };
}

// The /campus/resources/portal/grades payload for the same section listView
// knows about. It carries IC's authoritative weighted percentage but no
// assignments, so a record-level dedupe would discard it in favour of the
// assignment-rich listView stub - and the grade would be recomputed unweighted.
export const gradesPayload = {
  url: 'https://demo.infinitecampus.org/campus/resources/portal/grades?personID=987654&view=byCourse',
  ts: Date.now(),
  json: [
    {
      sectionID: 1004,
      courseName: 'US History',
      teacherDisplay: 'Whitfield, T',
      periodName: '2',
      termName: 'Q1',
      gradingTasks: [
        {
          taskName: 'Grade',
          termName: 'Q1',
          groupWeighted: true,
          progressScore: 'A',
          progressPercent: 94.2,
        },
      ],
    },
  ],
};

export const allPayloads = [
  identityPayload,
  displayOptionsPayload,
  rosterPayload,
  schedulePayload,
  transcriptPayload,
  documentsPayload,
  listViewPayload,
  gradesPayload,
];
