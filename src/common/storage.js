// Everything lives in chrome.storage.local. Nothing is ever sent anywhere
// except to the AI provider you configure, and only when you click Analyze.

export const KEYS = {
  SETTINGS: 'settings',
  SECRETS: 'secrets',
  DATA: 'data',
  SNAPSHOTS: 'snapshots',
  NETLOG: 'netlog',
  ANALYSES: 'analyses',
};

export const DEFAULT_SETTINGS = {
  setupComplete: false,

  // --- AI ---
  provider: 'anthropic',
  model: 'claude-opus-5',
  effort: 'high',            // anthropic only: low | medium | high | xhigh | max
  maxTokens: 16000,

  // --- Grading ---
  scale: 'standard',         // 'standard' | 'tenPoint'
  weightedGpa: true,
  rigorOverrides: {},        // { [courseId]: 'regular' | 'honors' | 'ap' }

  // --- Goal profile (drives the coaching) ---
  goal: {
    preset: 'straight-a',    // straight-a | ivy | state-flagship | raise-gpa | pass | custom
    targetGpaUnweighted: 4.0,
    targetGpaWeighted: null,
    gradeLevel: 11,
    graduationYear: null,
    colleges: [],
    intendedMajor: '',
    weeklyStudyHours: 10,
    constraints: '',         // sports, job, IEP/504, mental health, whatever they want to share
    strengths: '',
    struggles: '',
    tone: 'direct',          // direct | encouraging | blunt
  },

  // --- Privacy ---
  redactNames: true,         // strip student/teacher names + IDs before the AI call
  shareAssignmentTitles: true,

  // --- Server politeness (see SAFETY.md) ---
  // Every one of these is a ceiling enforced in the content script. Raising
  // them is possible but it is the one place in this extension where you can
  // make yourself look unusual to a school network, so the defaults are low.
  collection: {
    minGapMs: 3000,          // floor between requests, before jitter
    jitterMs: 1500,          // randomised extra delay so traffic is not metronomic
    maxPerRound: 14,         // requests in one planning round
    maxPerRun: 25,           // requests per page visit
    maxPerDay: 100,          // hard daily ceiling across all tabs
    cacheTtlMinutes: 360,    // do not re-fetch data captured within this window
    onlyWhenTabVisible: true,
  },

  districtOrigins: [],       // extra origins granted for self-hosted districts
};

export const DEFAULT_NETLOG = {
  day: null,
  countToday: 0,
  lastRequestAt: 0,
  consecutiveErrors: 0,
  cooldownUntil: 0,
  lastStatus: null,
  history: [],               // [{t, url, status, ms, source}]
};

async function get(key, fallback) {
  const out = await chrome.storage.local.get(key);
  return out[key] === undefined ? fallback : out[key];
}

async function set(key, value) {
  await chrome.storage.local.set({ [key]: value });
  return value;
}

export async function getSettings() {
  const stored = await get(KEYS.SETTINGS, {});
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    goal: { ...DEFAULT_SETTINGS.goal, ...(stored.goal || {}) },
    collection: { ...DEFAULT_SETTINGS.collection, ...(stored.collection || {}) },
  };
}

export async function saveSettings(patch) {
  const current = await getSettings();
  const next = {
    ...current,
    ...patch,
    goal: { ...current.goal, ...(patch.goal || {}) },
    collection: { ...current.collection, ...(patch.collection || {}) },
  };
  return set(KEYS.SETTINGS, next);
}

export const getSecrets = () => get(KEYS.SECRETS, {});

export async function saveSecret(provider, apiKey) {
  const s = await getSecrets();
  if (apiKey) s[provider] = apiKey;
  else delete s[provider];
  return set(KEYS.SECRETS, s);
}

export const getData = () => get(KEYS.DATA, null);
export const saveData = (d) => set(KEYS.DATA, d);

export const getSnapshots = () => get(KEYS.SNAPSHOTS, []);

/** One snapshot per day; the latest write for a day wins. Keeps 120 days. */
export async function pushSnapshot(snapshot) {
  const all = await getSnapshots();
  const filtered = all.filter((s) => s.day !== snapshot.day);
  filtered.push(snapshot);
  filtered.sort((a, b) => a.day.localeCompare(b.day));
  return set(KEYS.SNAPSHOTS, filtered.slice(-120));
}

export const getNetlog = () => get(KEYS.NETLOG, DEFAULT_NETLOG);
export const saveNetlog = (n) => set(KEYS.NETLOG, n);

export const getAnalyses = () => get(KEYS.ANALYSES, []);

export async function pushAnalysis(entry) {
  const all = await getAnalyses();
  all.unshift(entry);
  return set(KEYS.ANALYSES, all.slice(0, 25));
}

export async function clearEverything() {
  await chrome.storage.local.clear();
}

export async function storageFootprint() {
  try {
    return await chrome.storage.local.getBytesInUse(null);
  } catch {
    return null;
  }
}
