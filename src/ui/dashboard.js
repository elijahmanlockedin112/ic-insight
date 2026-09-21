import { renderMarkdown } from './md.js';

const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

let state = null;
let report = null;
let analysisPort = null;
let conversationStarted = false;

// ---------------------------------------------------------------------- tabs

for (const btn of document.querySelectorAll('nav button')) {
  btn.addEventListener('click', () => selectTab(btn.dataset.tab));
}

function selectTab(name) {
  for (const btn of document.querySelectorAll('nav button')) {
    btn.setAttribute('aria-selected', String(btn.dataset.tab === name));
  }
  for (const sec of document.querySelectorAll('section')) {
    sec.classList.toggle('hidden', sec.id !== `tab-${name}`);
  }
  location.hash = name;
}

// --------------------------------------------------------------------- load

async function load() {
  state = await send({ type: 'ui:getState' });
  if (!state?.ok) {
    $('banner').innerHTML = '';
    $('banner').appendChild(el('div', 'notice bad', 'Could not reach the extension background.'));
    return;
  }

  const s = state.settings;
  $('subtitle').textContent = `${state.providers[s.provider]?.label} · ${s.model} · goal: ${s.goal.preset}`;
  $('coachMeta').textContent = `${s.model}${s.effort && state.providers[s.provider]?.supportsEffort ? ` · effort ${s.effort}` : ''}`;
  $('privacyNote').textContent = s.redactNames
    ? 'Your name, student ID and teacher names are removed before anything is sent.'
    : 'Name redaction is OFF — your name and teacher names will be sent to the provider.';

  renderBanner();
  renderRequests();
  renderAnalysisHistory();

  const r = await send({ type: 'ui:getReport' });
  if (r?.ok) {
    report = r.report;
    renderOverview();
    renderCourses();
  } else {
    $('stats').textContent = '';
    $('stats').appendChild(el('p', 'muted', 'No gradebook data yet.'));
  }
}

function renderBanner() {
  const box = $('banner');
  box.textContent = '';
  const { data, settings, netlog, hasKey } = state;

  if (!hasKey[settings.provider]) {
    box.appendChild(el('div', 'notice warn',
      `No API key saved for ${state.providers[settings.provider]?.label}. Open Settings to add one.`));
  }
  if (!data) {
    box.appendChild(el('div', 'notice info',
      'No data captured yet. Open your Infinite Campus portal and browse Grades, or press ' +
      '"Fetch my data" above.'));
  } else if (data.gaps?.length) {
    box.appendChild(el('div', 'notice info',
      `Still missing: ${data.gaps.join(', ')}. Opening those pages in your portal captures them for free.`));
  }
  if (netlog.cooldownUntil > Date.now()) {
    const mins = Math.ceil((netlog.cooldownUntil - Date.now()) / 60000);
    box.appendChild(el('div', 'notice warn',
      `Fetching is paused for ${mins} more minute(s). The server signalled that it wanted fewer ` +
      'requests, so the extension backed off.'));
  }
}

// ----------------------------------------------------------------- overview

function stat(value, label, kind) {
  const wrap = el('div', 'stat');
  const v = el('span', 'value', value);
  if (kind) v.style.color = `var(--${kind})`;
  wrap.appendChild(v);
  wrap.appendChild(el('span', 'label', label));
  return wrap;
}

function renderOverview() {
  const stats = $('stats');
  stats.textContent = '';
  const missing = report.courses.reduce((s, c) => s + (c.missing.count ?? 0), 0);
  const declining = report.courses.filter((c) => c.trend.direction === 'declining').length;

  stats.appendChild(stat(fmt(report.termGpa?.unweighted), 'Term GPA'));
  stats.appendChild(stat(fmt(report.termGpa?.weighted), 'Weighted'));
  stats.appendChild(stat(fmt(report.cumulative?.unweighted), 'Cumulative'));
  stats.appendChild(stat(String(report.courses.length), 'Courses'));
  stats.appendChild(stat(String(missing), 'Missing', missing ? 'danger' : null));
  stats.appendChild(stat(String(declining), 'Sliding', declining ? 'warn' : null));

  // Makes it obvious when a course arrived without assignment-level detail.
  const withDetail = report.coverage?.coursesWithAssignments ?? 0;
  const total = report.courses.length;
  stats.appendChild(stat(
    `${withDetail}/${total}`, 'With detail',
    withDetail < total ? 'warn' : null,
  ));

  // --- goal ---
  const goalCard = $('goalCard');
  goalCard.textContent = '';
  goalCard.appendChild(el('h2', null, 'Goal check'));
  const runway = report.runway;
  if (!runway) {
    goalCard.appendChild(el('p', 'muted small',
      'Not enough transcript data to project a cumulative GPA yet. Open Reports → Transcript in your ' +
      'portal, or press Fetch my data.'));
  } else {
    const verdictClass = runway.verdict === 'not-reachable-on-unweighted-4.0' ? 'bad'
      : runway.verdict === 'already-locked-in' ? 'good' : 'info';
    const msg = runway.verdict === 'already-locked-in'
      ? `You are already at or above a ${runway.target} cumulative GPA.`
      : runway.verdict === 'reachable'
        ? `To reach a ${runway.target} cumulative GPA you need about a ${runway.requiredGpaGoingForward} ` +
          `average across your remaining ~${runway.remainingCredits} credits.`
        : `A ${runway.target} cumulative GPA would require a ${runway.requiredGpaGoingForward} average ` +
          'going forward, which is above a 4.0. It is not reachable on an unweighted scale — aim at the ' +
          'best achievable number instead.';
    goalCard.appendChild(el('div', `notice ${verdictClass}`, msg));
  }

  // --- risks ---
  const risksCard = $('risksCard');
  risksCard.textContent = '';
  risksCard.appendChild(el('h2', null, 'What needs attention'));
  if (!report.risks.length) {
    risksCard.appendChild(el('p', 'muted small', 'Nothing flagged. Good place to be.'));
  } else {
    for (const risk of report.risks.slice(0, 10)) {
      const row = el('div', 'row', null);
      row.style.marginBottom = '6px';
      const kind = risk.level === 'critical' || risk.level === 'high' ? 'bad'
        : risk.level === 'medium' ? 'warn' : '';
      row.appendChild(el('span', `pill ${kind}`, risk.level));
      row.appendChild(el('span', 'small', `${risk.course} — ${risk.why}`));
      risksCard.appendChild(row);
    }
  }

  // --- actions ---
  const actionsCard = $('actionsCard');
  actionsCard.textContent = '';
  actionsCard.appendChild(el('h2', null, 'Highest-leverage moves'));
  actionsCard.appendChild(el('p', 'small muted',
    'Computed locally from your actual point totals — not the AI\'s guess.'));
  if (!report.actions.length) {
    actionsCard.appendChild(el('p', 'muted small', 'No specific levers found right now.'));
  } else {
    const table = el('table');
    table.innerHTML =
      '<thead><tr><th>Course</th><th>Move</th><th class="num">Grade</th><th class="num">GPA</th></tr></thead>';
    const body = el('tbody');
    for (const a of report.actions.slice(0, 10)) {
      const tr = el('tr');
      tr.appendChild(el('td', null, a.course));
      tr.appendChild(el('td', 'small', a.detail));
      tr.appendChild(el('td', 'num', a.gradeDelta != null ? `+${a.gradeDelta}` : '—'));
      tr.appendChild(el('td', 'num', a.gpaDelta ? `+${a.gpaDelta}` : '—'));
      body.appendChild(tr);
    }
    table.appendChild(body);
    actionsCard.appendChild(table);
  }

  // --- documents (transcript, report cards) ---
  const docsCard = $('docsCard');
  docsCard.textContent = '';
  docsCard.appendChild(el('h2', null, 'Transcript and report cards'));
  const docs = state.documents || [];

  if (!docs.length) {
    docsCard.appendChild(el('p', 'small muted',
      'No documents captured yet. Press "Fetch my data", or open Reports in your portal once.'));
  } else {
    docsCard.appendChild(el('p', 'small muted',
      'Infinite Campus publishes these as files, not as data. There is no portal endpoint that ' +
      'returns a parsed transcript, so the extension links them rather than reading grades out ' +
      'of them - which is why cumulative GPA below covers only the terms the grades endpoint exposes.'));
    for (const d of docs) {
      const row = el('div', 'row');
      row.style.marginBottom = '4px';
      const link = el('a', null, d.name);
      link.href = d.url.startsWith('http') ? d.url : (state.data?.origin || '') + d.url;
      link.target = '_blank';
      link.rel = 'noopener';
      row.appendChild(link);
      if (d.type) row.appendChild(el('span', 'pill', String(d.type)));
      if (d.endYear) row.appendChild(el('span', 'small muted', String(d.endYear)));
      docsCard.appendChild(row);
    }
  }

  // --- history ---
  const historyCard = $('historyCard');
  historyCard.textContent = '';
  historyCard.appendChild(el('h2', null, 'Movement since the extension started watching'));
  if (!report.history.courses.length) {
    historyCard.appendChild(el('p', 'muted small',
      `Tracking started ${report.history.days} day(s) ago. Come back tomorrow for day-over-day trends.`));
  } else {
    const table = el('table');
    table.innerHTML = '<thead><tr><th>Course</th><th class="num">Then</th><th class="num">Now</th><th class="num">Change</th></tr></thead>';
    const body = el('tbody');
    for (const h of report.history.courses) {
      const tr = el('tr');
      tr.appendChild(el('td', null, h.name || h.id));
      tr.appendChild(el('td', 'num', `${h.from.percent}%`));
      tr.appendChild(el('td', 'num', `${h.to.percent}%`));
      const change = el('td', 'num', `${h.change > 0 ? '+' : ''}${h.change}`);
      change.style.color = h.change < 0 ? 'var(--danger)' : h.change > 0 ? 'var(--good)' : '';
      tr.appendChild(change);
      body.appendChild(tr);
    }
    table.appendChild(body);
    historyCard.appendChild(table);
  }
}

const fmt = (n) => (n === null || n === undefined ? '—' : Number(n).toFixed(2));

// ------------------------------------------------------------------ courses

function renderCourses() {
  const list = $('courseList');
  list.textContent = '';

  for (const c of report.courses) {
    const card = el('div', 'card');

    const head = el('div', 'course-head');
    const left = el('div');
    left.appendChild(el('h2', null, c.name));
    const meta = [c.teacher, c.period ? `Period ${c.period}` : null, c.term, c.task]
      .filter(Boolean).join(' · ');
    left.appendChild(el('div', 'small muted', meta));
    head.appendChild(left);

    const right = el('div');
    right.style.textAlign = 'right';
    right.appendChild(el('div', 'pct', `${c.percent}%`));
    const badges = el('div', 'row');
    badges.style.justifyContent = 'flex-end';
    badges.appendChild(el('span', 'pill', c.letter));
    if (c.rigor !== 'regular') badges.appendChild(el('span', 'pill', c.rigor.toUpperCase()));
    if (c.trend.direction === 'declining') badges.appendChild(el('span', 'pill bad', 'sliding'));
    if (c.trend.direction === 'improving') badges.appendChild(el('span', 'pill good', 'improving'));
    if (c.approximate) {
      const pill = el('span', 'pill warn', 'approx');
      pill.title = 'Assignment detail came from listView, which carries no category ' +
                   'weights. The headline grade is the one Infinite Campus reported.';
      badges.appendChild(pill);
    }
    right.appendChild(badges);
    head.appendChild(right);
    card.appendChild(head);

    // cushion / next letter
    const line = [];
    if (c.cushionToDrop !== null) line.push(`${c.cushionToDrop} pts above dropping to the next letter down`);
    if (c.nextLetter) line.push(`${c.nextLetter.gap} pts from a ${c.nextLetter.letter}`);
    if (line.length) card.appendChild(el('p', 'small muted', line.join(' · ')));

    if (!c.trend.n) {
      card.appendChild(el('div', 'notice warn small',
        'No assignment-level detail for this course yet. Open it once in the portal, ' +
        'or press Fetch my data.'));
    }

    // categories
    if (c.categories.length) {
      const wrap = el('div');
      wrap.style.margin = '12px 0';
      for (const k of c.categories) {
        if (k.percent === null) continue;
        const row = el('div', 'catbar');
        row.style.marginBottom = '5px';
        const nameCell = el('div');
        nameCell.appendChild(el('div', null, k.name));
        const bar = el('div', 'bar');
        const fill = el('span');
        fill.style.width = `${Math.max(0, Math.min(100, k.percent))}%`;
        if (k.percent < 70) fill.style.background = 'var(--danger)';
        else if (k.percent < 85) fill.style.background = 'var(--warn)';
        bar.appendChild(fill);
        nameCell.appendChild(bar);
        row.appendChild(nameCell);
        row.appendChild(el('div', 'num mono', `${k.percent}%`));
        row.appendChild(el('div', 'small muted', `${Math.round((k.weightShare ?? 0) * 100)}% of grade`));
        wrap.appendChild(row);
      }
      card.appendChild(wrap);
    }

    // Sparkline over EVERY graded assignment, not a tail of the last handful.
    const series = c.trend.all?.length ? c.trend.all : (c.trend.recent || []);
    if (series.length) {
      const wrap = el('div');
      wrap.style.margin = '10px 0';
      wrap.appendChild(el('div', 'small muted',
        `All ${series.length} graded — ${c.trend.direction}` +
        (c.trend.last5Mean !== null ? ` (last 5 average ${c.trend.last5Mean}%)` : '')));
      const spark = el('div', 'spark');
      // Bars thin out as the term fills up so a long series still fits.
      const width = series.length > 60 ? 2 : series.length > 30 ? 4 : 6;
      for (const a of series) {
        const bar = el('i');
        bar.style.height = `${Math.max(2, Math.min(100, a.pct)) * 0.3}px`;
        bar.style.width = `${width}px`;
        if (a.pct < 70) bar.className = 'bad';
        bar.title = `${a.due || ''} ${a.name}: ${a.earned}/${a.possible} (${a.pct}%)`;
        spark.appendChild(bar);
      }
      wrap.appendChild(spark);
      card.appendChild(wrap);

      // And the full list, so nothing is hidden behind a hover.
      const det = el('details');
      det.appendChild(el('summary', null, `All ${series.length} graded assignments`));
      const table = el('table');
      table.innerHTML = '<thead><tr><th>Due</th><th>Assignment</th><th>Category</th>' +
                        '<th class="num">Score</th><th class="num">%</th></tr></thead>';
      const body = el('tbody');
      for (const a of series.slice().reverse()) {
        const tr = el('tr');
        tr.appendChild(el('td', 'small muted', a.due || ''));
        tr.appendChild(el('td', null, a.name));
        tr.appendChild(el('td', 'small muted', a.category || ''));
        tr.appendChild(el('td', 'num', `${a.earned}/${a.possible}`));
        const pctCell = el('td', 'num', String(a.pct));
        if (a.pct < 70) pctCell.style.color = 'var(--danger)';
        tr.appendChild(pctCell);
        body.appendChild(tr);
      }
      table.appendChild(body);
      const scroll = el('div', 'scroll');
      scroll.appendChild(table);
      det.appendChild(scroll);
      card.appendChild(det);
    }

    // When our category model disagrees with the gradebook, say so rather than
    // quietly presenting an estimate as the grade.
    if (c.modelDisagrees) {
      card.appendChild(el('div', 'notice warn small',
        `Infinite Campus reports ${c.percent}%. Recomputing from the assignments gives ` +
        `${c.computedPercent}%, so the category weights here are incomplete. The grade above ` +
        `is IC's; the what-if numbers below are estimates.`));
    }

    // what-if
    const wi = c.whatIf?.toReachNextLetter;
    if (wi && wi.achievable && c.nextLetter) {
      card.appendChild(el('div', 'notice info small',
        `A ${c.whatIf.probeAssignmentPoints}-point ${c.whatIf.probeCategory ?? ''} assignment: ` +
        `score ${wi.needed}/${wi.addedPossible} (${wi.neededPercent}%) to reach a ${c.nextLetter.letter}. ` +
        `A perfect score puts you at ${wi.resultingIfPerfect}%; a zero drops you to ${wi.resultingIfZero}%.`));
    }

    // missing work
    if (c.missing.count) {
      const det = el('details');
      det.appendChild(el('summary', null,
        `${c.missing.count} missing or zero-scored item(s) — worth +${c.missing.allFixedDelta ?? 0} points if all made up`));
      const table = el('table');
      table.innerHTML = '<thead><tr><th>Assignment</th><th>Category</th><th class="num">Points</th><th class="num">Gain</th></tr></thead>';
      const body = el('tbody');
      for (const m of c.missing.items) {
        const tr = el('tr');
        tr.appendChild(el('td', null, m.name));
        tr.appendChild(el('td', 'small muted', m.categoryName));
        tr.appendChild(el('td', 'num', `${m.earned ?? 0}/${m.possible}`));
        tr.appendChild(el('td', 'num', `+${m.deltaIfFullCredit ?? 0}`));
        body.appendChild(tr);
      }
      table.appendChild(body);
      det.appendChild(table);
      card.appendChild(det);
    }

    // rigor override
    const rigorRow = el('div', 'row small');
    rigorRow.style.marginTop = '10px';
    rigorRow.appendChild(el('span', 'muted', 'Weighting:'));
    const sel = el('select');
    sel.style.width = 'auto';
    for (const [value, label] of [['regular', 'Regular'], ['honors', 'Honors (+0.5)'], ['ap', 'AP/IB/DE (+1.0)']]) {
      const opt = el('option', null, label);
      opt.value = value;
      if (value === c.rigor) opt.selected = true;
      sel.appendChild(opt);
    }
    sel.addEventListener('change', async () => {
      const overrides = { ...(state.settings.rigorOverrides || {}), [c.id]: sel.value };
      await send({ type: 'ui:saveSettings', patch: { rigorOverrides: overrides } });
      state.settings.rigorOverrides = overrides;
      const r = await send({ type: 'ui:getReport' });
      if (r?.ok) { report = r.report; renderOverview(); renderCourses(); }
    });
    rigorRow.appendChild(sel);
    card.appendChild(rigorRow);

    list.appendChild(card);
  }
}

// -------------------------------------------------------------------- coach

$('analyze').addEventListener('click', () => runAnalysis(true));
$('question').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') runAnalysis(!conversationStarted);
});

function runAnalysis(reset) {
  const question = $('question').value.trim();
  const answer = $('answer');
  const status = $('answerStatus');

  if (reset) answer.textContent = '';
  else if (question) {
    answer.appendChild(el('hr'));
    answer.appendChild(el('p', 'muted', `You asked: ${question}`));
  }

  status.textContent = '';
  status.appendChild(el('span', 'spinner'));
  status.appendChild(el('span', null, ' Thinking…'));
  $('analyze').disabled = true;

  if (!analysisPort) {
    analysisPort = chrome.runtime.connect({ name: `analysis-${Date.now()}` });
    let buffer = '';
    let liveNode = null;

    analysisPort.onMessage.addListener((msg) => {
      if (msg.type === 'start') {
        buffer = '';
        liveNode = el('div');
        answer.appendChild(liveNode);
        status.textContent = `Streaming from ${msg.model}${msg.redacted ? ' (names removed)' : ''}…`;
      } else if (msg.type === 'delta') {
        buffer += msg.delta;
        if (liveNode) liveNode.innerHTML = renderMarkdown(buffer);
      } else if (msg.type === 'done') {
        conversationStarted = true;
        $('analyze').disabled = false;
        $('analyze').textContent = 'Ask again';
        $('question').value = '';
        const tokens = msg.usage?.output_tokens ?? msg.usage?.completion_tokens ?? null;
        status.textContent = tokens ? `Done — ${tokens} output tokens.` : 'Done.';
        renderAnalysisHistory();
      } else if (msg.type === 'error') {
        $('analyze').disabled = false;
        status.textContent = '';
        answer.appendChild(el('div', 'notice bad', msg.error));
      } else if (msg.type === 'report') {
        report = msg.report;
        renderOverview();
        renderCourses();
      }
    });

    analysisPort.onDisconnect.addListener(() => { analysisPort = null; });
  }

  analysisPort.postMessage({ type: 'run', question, reset });
}

async function renderAnalysisHistory() {
  const box = $('historyList');
  box.textContent = '';
  const items = state.analyses || [];
  if (!items.length) {
    box.appendChild(el('span', 'muted', 'No analyses yet.'));
    return;
  }
  items.forEach((a, i) => {
    const row = el('div', 'row');
    row.style.marginBottom = '4px';
    const btn = el('button', 'ghost small', new Date(a.ts).toLocaleString());
    btn.addEventListener('click', async () => {
      const res = await send({ type: 'ui:getAnalysis', index: i });
      if (res?.ok && res.analysis) {
        $('answer').innerHTML = renderMarkdown(res.analysis.markdown);
        $('answerStatus').textContent = `Saved analysis from ${new Date(res.analysis.ts).toLocaleString()}`;
      }
    });
    row.appendChild(btn);
    row.appendChild(el('span', 'small muted', `${a.model}${a.question ? ` — "${a.question}"` : ''}`));
    box.appendChild(row);
  });
}

// ----------------------------------------------------------------- requests

function renderRequests() {
  const { netlog, settings } = state;
  const stats = $('netStats');
  stats.textContent = '';
  stats.appendChild(stat(String(netlog.countToday ?? 0), 'Requests today'));
  stats.appendChild(stat(String(settings.collection.maxPerDay), 'Daily cap'));
  stats.appendChild(stat(`${Math.round(settings.collection.minGapMs / 1000)}s`, 'Min gap'));
  stats.appendChild(stat(String(netlog.consecutiveErrors ?? 0), 'Errors in a row'));

  const notice = $('netNotice');
  notice.textContent = '';
  if (netlog.cooldownUntil > Date.now()) {
    notice.appendChild(el('div', 'notice warn',
      `Paused until ${new Date(netlog.cooldownUntil).toLocaleTimeString()}.`));
  } else {
    notice.appendChild(el('div', 'notice good',
      'Within limits. Requests are GET-only, one at a time, and stop immediately on any sign the ' +
      'server wants fewer.'));
  }

  const table = $('netTable');
  table.textContent = '';
  table.innerHTML = '<thead><tr><th>Time</th><th>Path</th><th class="num">Status</th><th class="num">ms</th></tr></thead>';
  const body = el('tbody');
  for (const h of (netlog.history || []).slice(0, 60)) {
    const tr = el('tr');
    tr.appendChild(el('td', 'small', new Date(h.t).toLocaleTimeString()));
    tr.appendChild(el('td', 'mono', h.url));
    const st = el('td', 'num', String(h.status));
    if (typeof h.status === 'number' && h.status >= 400) st.style.color = 'var(--danger)';
    tr.appendChild(st);
    tr.appendChild(el('td', 'num', String(h.ms ?? '')));
    body.appendChild(tr);
  }
  table.appendChild(body);
}

// ------------------------------------------------------------------- header

$('settings').addEventListener('click', () => chrome.runtime.openOptionsPage());

$('diagnostic').addEventListener('click', async () => {
  const btn = $('diagnostic');
  const res = await send({ type: 'ui:diagnostic' });
  if (!res?.ok) {
    btn.textContent = res?.error || 'No data yet';
    setTimeout(() => { btn.textContent = 'Copy diagnostic'; }, 2500);
    return;
  }
  try {
    await navigator.clipboard.writeText(JSON.stringify(res.diagnostic, null, 2));
    btn.textContent = 'Copied - no names included';
  } catch {
    btn.textContent = 'Could not copy';
  }
  setTimeout(() => { btn.textContent = 'Copy diagnostic'; }, 3000);
});

$('fetch').addEventListener('click', () => {
  const btn = $('fetch');
  btn.disabled = true;
  btn.textContent = 'Fetching…';
  const box = $('banner');
  box.textContent = '';
  const line = el('div', 'notice info', 'Looking for your portal tab…');
  box.appendChild(line);

  const port = chrome.runtime.connect({ name: 'crawl' });
  port.onMessage.addListener(async (msg) => {
    if (msg.type === 'progress' && msg.phase === 'round') {
      line.textContent = `Round ${msg.round + 1}: ${msg.focus.join(', ')} — ${msg.planned} request(s), ` +
                         `spaced ${Math.round(state.settings.collection.minGapMs / 1000)}s apart…`;
    } else if (msg.type === 'progress' && msg.phase === 'round-done') {
      line.textContent = `Round ${msg.round + 1}: ${msg.requests} request(s), ${msg.captured} useful.`;
    } else if (msg.type === 'done') {
      btn.disabled = false;
      btn.textContent = 'Fetch my data';
      port.disconnect();
      if (!msg.ok) {
        line.className = 'notice bad';
        line.textContent = msg.error;
      } else {
        line.className = msg.stopped ? 'notice warn' : 'notice good';
        line.textContent = msg.stopped
          ? `Stopped early: ${msg.reason} (${msg.requests} request(s) made).`
          : `Done — ${msg.requests} request(s), ${msg.courses} course(s) known.`;
      }
      await load();
    }
  });
  port.postMessage({ type: 'run' });
});

if (location.hash) selectTab(location.hash.slice(1));
load();
