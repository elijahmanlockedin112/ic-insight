const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);

let state = null;

async function refresh() {
  state = await send({ type: 'ui:getState' });
  if (!state?.ok) {
    $('status').textContent = 'Could not reach the extension background.';
    return;
  }

  const { settings, data, netlog, hasKey } = state;
  const remaining = Math.max(0, (settings.collection.maxPerDay ?? 100) - (netlog.countToday ?? 0));
  $('budget').textContent = `${remaining} requests left today`;

  if (!settings.setupComplete) {
    setStatus('warn', 'Finish setup first: pick a model and set your goal.');
    $('fetch').disabled = true;
  } else if (!data) {
    setStatus('info', 'No data yet. Open your Infinite Campus portal, then press Fetch my data.');
  } else if (netlog.cooldownUntil > Date.now()) {
    const mins = Math.ceil((netlog.cooldownUntil - Date.now()) / 60000);
    setStatus('warn', `Paused for ${mins} more minute(s) after a slow-down signal from the server.`);
    $('fetch').disabled = true;
  } else {
    const ago = data.capturedAt ? timeAgo(data.capturedAt) : 'unknown';
    setStatus('good', `${data.courses} course(s) captured, last updated ${ago}.`);
  }

  if (!hasKey[settings.provider]) {
    setStatus('warn', `No API key saved for ${state.providers[settings.provider]?.label}. Open Settings.`);
  }

  if (data) {
    $('stats').hidden = false;
    const report = await send({ type: 'ui:getReport' });
    if (report?.ok) {
      $('gpa').textContent = report.report.termGpa?.unweighted?.toFixed(2) ?? '—';
      $('courses').textContent = report.report.courses.length;
      const missing = report.report.courses.reduce((s, c) => s + (c.missing.count ?? 0), 0);
      $('missing').textContent = missing;
    }
    $('gaps').textContent = data.gaps?.length
      ? `Still missing: ${data.gaps.join(', ')}. Visiting those pages in the portal helps.`
      : '';
  }
}

function setStatus(kind, text) {
  const el = $('status');
  el.className = `notice ${kind}`;
  el.textContent = text;
}

const timeAgo = (ts) => {
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} h ago`;
  return `${Math.round(hrs / 24)} d ago`;
};

$('fetch').addEventListener('click', () => {
  const btn = $('fetch');
  btn.disabled = true;
  btn.textContent = 'Fetching…';

  const box = $('progress');
  box.style.display = 'block';
  box.textContent = 'Looking for your portal tab…';

  const port = chrome.runtime.connect({ name: 'crawl' });
  port.onMessage.addListener((msg) => {
    if (msg.type === 'progress') {
      if (msg.phase === 'round') {
        box.textContent = `Round ${msg.round + 1}: asking for ${msg.focus.join(', ')} ` +
                          `(${msg.planned} request(s), spaced out)…`;
      } else if (msg.phase === 'round-done') {
        box.textContent = `Round ${msg.round + 1} done — ${msg.requests} request(s), ` +
                          `${msg.captured} useful. ${msg.remainingToday ?? '?'} left today.`;
      }
    }
    if (msg.type === 'done') {
      btn.disabled = false;
      btn.textContent = 'Fetch my data';
      if (!msg.ok) {
        box.className = 'notice bad small';
        box.textContent = msg.error;
      } else if (msg.stopped) {
        box.className = 'notice warn small';
        box.textContent = `Stopped early: ${msg.reason}. Made ${msg.requests} request(s).`;
      } else {
        box.className = 'notice good small';
        box.textContent = `Done. ${msg.requests} request(s), ${msg.courses} course(s) known.` +
          (msg.gaps?.length ? ` Still missing: ${msg.gaps.join(', ')}.` : '');
      }
      port.disconnect();
      refresh();
    }
  });
  port.postMessage({ type: 'run' });
});

$('dashboard').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('src/ui/dashboard.html') });
  window.close();
});

$('options').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

$('safety').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('src/ui/dashboard.html#requests') });
  window.close();
});

refresh();
