import { GOAL_PRESETS } from '../background/prompt.js';

const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);

let state = null;

// ------------------------------------------------------------------ populate

function fillSelect(el, items, selected) {
  el.textContent = '';
  for (const it of items) {
    const opt = document.createElement('option');
    opt.value = it.value ?? it.id;
    opt.textContent = it.label;
    if (opt.value === String(selected)) opt.selected = true;
    el.appendChild(opt);
  }
}

async function load() {
  state = await send({ type: 'ui:getState' });
  if (!state?.ok) return;
  const s = state.settings;

  fillSelect(
    $('provider'),
    Object.entries(state.providers).map(([id, p]) => ({ value: id, label: p.label })),
    s.provider,
  );
  fillSelect(
    $('preset'),
    Object.entries(GOAL_PRESETS).map(([id, p]) => ({ value: id, label: p.label })),
    s.goal.preset,
  );

  applyProviderChrome(s.provider);
  await refreshModels(s.provider, s.model);

  $('effort').value = s.effort;
  $('maxTokens').value = s.maxTokens;

  $('targetGpaUnweighted').value = s.goal.targetGpaUnweighted ?? '';
  $('targetGpaWeighted').value = s.goal.targetGpaWeighted ?? '';
  $('gradeLevel').value = String(s.goal.gradeLevel ?? 11);
  $('graduationYear').value = s.goal.graduationYear ?? '';
  $('weeklyStudyHours').value = s.goal.weeklyStudyHours ?? 10;
  $('tone').value = s.goal.tone;
  $('colleges').value = (s.goal.colleges || []).join(', ');
  $('intendedMajor').value = s.goal.intendedMajor || '';
  $('strengths').value = s.goal.strengths || '';
  $('struggles').value = s.goal.struggles || '';
  $('constraints').value = s.goal.constraints || '';

  $('scale').value = s.scale;
  $('weightedGpa').value = String(s.weightedGpa);

  $('redactNames').checked = s.redactNames;
  $('shareAssignmentTitles').checked = s.shareAssignmentTitles;

  $('minGapMs').value = s.collection.minGapMs;
  $('maxPerRound').value = s.collection.maxPerRound;
  $('maxPerRun').value = s.collection.maxPerRun;
  $('maxPerDay').value = s.collection.maxPerDay;
  $('onlyWhenTabVisible').checked = s.collection.onlyWhenTabVisible;

  if (state.hasKey[s.provider]) $('apiKey').placeholder = 'Key saved — paste a new one to replace it';

  renderOrigins(s.districtOrigins || []);
}

function applyProviderChrome(provider) {
  const spec = state.providers[provider];
  $('keyHint').textContent = spec?.keyHint ? `(${spec.keyHint})` : '';
  $('keyLink').href = spec?.keyUrl || '#';
  $('effortWrap').style.display = spec?.supportsEffort ? '' : 'none';
  $('apiKey').value = '';
  $('apiKey').placeholder = state.hasKey[provider]
    ? 'Key saved — paste a new one to replace it'
    : 'Paste your key';
}

async function refreshModels(provider, selected) {
  const status = $('modelStatus');
  status.textContent = 'Loading models…';
  const res = await send({ type: 'ui:listModels', provider });
  const models = res?.models || [];
  fillSelect($('model'), models.map((m) => ({ value: m.id, label: m.label })), selected);
  const note = models.find((m) => m.note);
  status.textContent = note
    ? `Showing a built-in list (${note.note})`
    : `${models.length} model(s) available`;
}

function renderOrigins(origins) {
  $('originList').textContent = origins.length
    ? `Granted: ${origins.join(', ')}`
    : 'No extra districts added.';
}

// -------------------------------------------------------------------- events

$('provider').addEventListener('change', async (e) => {
  applyProviderChrome(e.target.value);
  const spec = state.providers[e.target.value];
  await refreshModels(e.target.value, spec?.defaultModel);
});

$('loadModels').addEventListener('click', async () => {
  const provider = $('provider').value;
  const key = $('apiKey').value.trim();
  if (key) {
    await send({ type: 'ui:saveKey', provider, apiKey: key });
    state.hasKey[provider] = true;
    $('apiKey').value = '';
    $('apiKey').placeholder = 'Key saved — paste a new one to replace it';
  }
  await refreshModels(provider, $('model').value);
});

$('addOrigin').addEventListener('click', async () => {
  const raw = $('districtOrigin').value.trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^/\s]+$/.test(raw)) {
    $('originList').textContent = 'Enter just the origin, e.g. https://campus.mydistrict.org';
    return;
  }
  // Must be requested from a user gesture on an extension page.
  const granted = await chrome.permissions.request({ origins: [`${raw}/*`] });
  if (!granted) {
    $('originList').textContent = 'Permission declined, so that site was not added.';
    return;
  }
  const res = await send({ type: 'ui:registerOrigin', origin: raw });
  if (res?.ok) {
    $('districtOrigin').value = '';
    renderOrigins(res.origins);
  } else {
    $('originList').textContent = res?.error || 'Could not register that site.';
  }
});

$('export').addEventListener('click', async () => {
  const res = await send({ type: 'ui:exportData' });
  if (!res?.ok) return;
  const blob = new Blob([JSON.stringify(res.bundle, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `ic-insight-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
});

$('clear').addEventListener('click', async () => {
  if (!confirm('Delete every stored grade, snapshot, analysis and API key? This cannot be undone.')) return;
  await send({ type: 'ui:clearData' });
  location.reload();
});

$('save').addEventListener('click', async () => {
  const patch = {
    setupComplete: true,
    provider: $('provider').value,
    model: $('model').value,
    effort: $('effort').value,
    maxTokens: Number($('maxTokens').value) || 16000,
    scale: $('scale').value,
    weightedGpa: $('weightedGpa').value === 'true',
    redactNames: $('redactNames').checked,
    shareAssignmentTitles: $('shareAssignmentTitles').checked,
    goal: {
      preset: $('preset').value,
      targetGpaUnweighted: numOrNull($('targetGpaUnweighted').value) ?? 4.0,
      targetGpaWeighted: numOrNull($('targetGpaWeighted').value),
      gradeLevel: Number($('gradeLevel').value),
      graduationYear: numOrNull($('graduationYear').value),
      weeklyStudyHours: numOrNull($('weeklyStudyHours').value) ?? 10,
      tone: $('tone').value,
      colleges: $('colleges').value.split(',').map((s) => s.trim()).filter(Boolean),
      intendedMajor: $('intendedMajor').value.trim(),
      strengths: $('strengths').value.trim(),
      struggles: $('struggles').value.trim(),
      constraints: $('constraints').value.trim(),
    },
    collection: {
      minGapMs: clampNum($('minGapMs').value, 1000, 30000, 3000),
      maxPerRound: clampNum($('maxPerRound').value, 1, 30, 14),
      maxPerRun: clampNum($('maxPerRun').value, 1, 60, 25),
      maxPerDay: clampNum($('maxPerDay').value, 1, 400, 100),
      onlyWhenTabVisible: $('onlyWhenTabVisible').checked,
    },
  };

  const key = $('apiKey').value.trim();
  if (key) {
    await send({ type: 'ui:saveKey', provider: patch.provider, apiKey: key });
    $('apiKey').value = '';
  }

  await send({ type: 'ui:saveSettings', patch });
  const status = $('saveStatus');
  status.textContent = 'Saved.';
  setTimeout(() => { status.textContent = ''; }, 2500);
});

const numOrNull = (v) => (v === '' || v === null ? null : Number(v));
const clampNum = (v, lo, hi, dflt) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
};

load();
