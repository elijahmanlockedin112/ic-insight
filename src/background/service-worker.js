// Coordinator. Owns storage, orchestrates crawl rounds, runs the model call.
// It never talks to a school server directly - only the content-script Governor
// can do that, so the rate limits cannot be bypassed from here.

import {
  getSettings, saveSettings, getSecrets, saveSecret,
  getData, saveData, getSnapshots, pushSnapshot,
  getNetlog, getAnalyses, pushAnalysis, clearEverything, storageFootprint,
} from '../common/storage.js';
import { extract, mergeDataset } from '../common/normalize.js';
import { analyze, snapshotOf } from '../common/analysis.js';
import { planRound, gapsIn, describeGaps, kindOfUrl } from './crawler.js';
import { streamCompletion, listModels, PROVIDERS } from './providers.js';
import { redactReport, buildBrief, systemPrompt, userPrompt, followUpPrompt } from './prompt.js';

const SEEN_KEY = 'seenUrls';
const DEAD_KEY = 'deadUrls';

// ------------------------------------------------------------------ capture

async function ingest(origin, batch) {
  const payloads = [];
  for (const item of batch || []) {
    try {
      payloads.push({ url: item.url, ts: item.ts, json: JSON.parse(item.body) });
    } catch {
      // Not JSON after all; drop it.
    }
  }
  if (!payloads.length) return { added: 0 };

  const fresh = extract(payloads);
  const merged = mergeDataset(await getData(), fresh);
  merged.origin = origin;

  // Record when each kind of data last arrived, so a repeat Fetch can skip
  // anything still fresh instead of re-requesting the whole sequence.
  merged.fetchedAt = { ...(merged.fetchedAt || {}) };
  for (const p of payloads) {
    const kind = kindOfUrl(p.url);
    if (kind) merged.fetchedAt[kind] = p.ts || Date.now();
  }
  await saveData(merged);

  // Keep a daily snapshot so trends survive even if IC drops old terms.
  try {
    const settings = await getSettings();
    const report = analyze(merged, settings, await getSnapshots());
    if (report.courses.length) await pushSnapshot(snapshotOf(report));
  } catch {
    // Snapshotting is best-effort; never let it break capture.
  }

  return { added: payloads.length, courses: merged.courses.length };
}

// -------------------------------------------------------------- tab plumbing

function askTab(tabId, message, timeoutMs = 180_000) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) { settled = true; resolve({ ok: false, error: 'timed out' }); }
    }, timeoutMs);
    try {
      chrome.tabs.sendMessage(tabId, message, (res) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
        else resolve(res || { ok: false, error: 'no response' });
      });
    } catch (e) {
      if (!settled) { settled = true; clearTimeout(timer); resolve({ ok: false, error: String(e) }); }
    }
  });
}

/**
 * Find an open tab where our content script is alive.
 * Queried by host pattern rather than with the broad "tabs" permission, so the
 * extension can only ever see tabs on portals you have already granted.
 */
async function findPortalTab() {
  const settings = await getSettings();
  const patterns = [
    '*://*.infinitecampus.org/*',
    ...(settings.districtOrigins || []).map((o) => `${o}/*`),
  ];

  const tabs = [];
  for (const pattern of patterns) {
    try {
      tabs.push(...(await chrome.tabs.query({ url: pattern })));
    } catch {
      // Pattern not permitted (user revoked it); skip.
    }
  }
  if (!tabs.length) return null;

  // Prefer whatever the student is actually looking at.
  const ordered = [
    ...tabs.filter((t) => t.active),
    ...tabs.filter((t) => !t.active),
  ];

  for (const tab of ordered) {
    const res = await askTab(tab.id, { type: 'ic:probe' }, 800);
    if (res && res.ok) return { tab, info: res };
  }
  return null;
}

// ------------------------------------------------------------------- crawl

async function runCrawl(onProgress, { force = false } = {}) {
  const settings = await getSettings();
  const found = await findPortalTab();
  if (!found) {
    return {
      ok: false,
      error: 'No Infinite Campus tab found. Open your portal, sign in, and try again.',
    };
  }

  const { tab, info } = found;
  const origin = info.origin;
  const summary = { rounds: [], requests: 0, captured: 0, stopped: false, reason: null, origin };

  // Four ordered rounds: identity -> features+roster+grades -> assignments+
  // documents -> per-section detail. Each depends on ids the last one returned.
  for (let round = 0; round < 4; round++) {
    const data = await getData();
    const store = await chrome.storage.local.get([SEEN_KEY, DEAD_KEY]);
    const seenUrls = (store[SEEN_KEY] || {})[origin] || [];
    const deadUrls = (store[DEAD_KEY] || {})[origin] || [];

    const plan = planRound({
      round, origin, data, seenUrls, deadUrls,
      perRound: settings.collection.maxPerRound ?? 14,
      fetchedAt: data?.fetchedAt || null,
      ttlMinutes: settings.collection.cacheTtlMinutes ?? 360,
      force,
    });

    if (!plan.urls.length) {
      summary.rounds.push({ round, focus: plan.focus, requests: 0, note: 'nothing left to try' });
      continue;
    }

    onProgress?.({
      phase: 'round',
      round,
      focus: plan.focus,
      planned: plan.urls.length,
      prefixes: plan.prefixes,
    });

    const res = await askTab(tab.id, {
      type: 'ic:fetchUrls',
      urls: plan.urls,
      settings: { collection: settings.collection },
    });

    if (!res.ok) {
      summary.stopped = true;
      summary.reason = res.error || 'the page stopped responding';
      break;
    }

    summary.requests += res.requests || 0;
    summary.captured += res.captured || 0;
    summary.rounds.push({
      round,
      focus: plan.focus,
      requests: res.requests || 0,
      captured: res.captured || 0,
      hits: (res.results || []).filter((r) => r.json).map((r) => r.url),
    });

    onProgress?.({
      phase: 'round-done',
      round,
      requests: res.requests || 0,
      captured: res.captured || 0,
      remainingToday: res.remainingToday,
    });

    if (res.stopped) {
      summary.stopped = true;
      summary.reason = res.reason;
      break;
    }
  }

  const data = await getData();
  summary.gaps = describeGaps(gapsIn(data));
  summary.courses = (data?.courses || []).length;
  summary.upToDate = summary.requests === 0 && !summary.stopped;
  return { ok: true, ...summary };
}

// ----------------------------------------------------------------- analysis

const conversations = new Map(); // portName -> { brief, messages }

async function runAnalysis(port, { question, reset }) {
  const settings = await getSettings();
  const secrets = await getSecrets();
  const apiKey = secrets[settings.provider];

  if (!apiKey) {
    port.postMessage({
      type: 'error',
      error: `No API key saved for ${PROVIDERS[settings.provider]?.label || settings.provider}. ` +
             'Add one in the extension options.',
    });
    return;
  }

  const data = await getData();
  if (!data || !(data.courses || []).length) {
    port.postMessage({
      type: 'error',
      error: 'No gradebook data captured yet. Open your Infinite Campus portal and visit Grades, ' +
             'or press "Fetch my data" to let the extension collect it.',
    });
    return;
  }

  let state = conversations.get(port.name);
  if (reset || !state) {
    const snapshots = await getSnapshots();
    const report = analyze(data, settings, snapshots);
    await pushSnapshot(snapshotOf(report));

    const redacted = redactReport(report, data, settings);
    const brief = buildBrief(redacted, settings);
    state = { brief, report, messages: [{ role: 'user', content: userPrompt(brief, question) }] };
    conversations.set(port.name, state);
    port.postMessage({ type: 'report', report });
  } else {
    state.messages.push({ role: 'user', content: followUpPrompt(question) });
  }

  port.postMessage({
    type: 'start',
    provider: settings.provider,
    model: settings.model,
    redacted: settings.redactNames,
  });

  let text = '';
  try {
    const result = await streamCompletion(
      {
        provider: settings.provider,
        apiKey,
        model: settings.model,
        system: systemPrompt(settings),
        messages: state.messages,
        maxTokens: settings.maxTokens,
        effort: PROVIDERS[settings.provider]?.supportsEffort ? settings.effort : null,
      },
      (delta) => {
        text += delta;
        port.postMessage({ type: 'delta', delta });
      },
    );

    state.messages.push({ role: 'assistant', content: result.text });
    port.postMessage({ type: 'done', usage: result.usage, stopReason: result.stopReason });

    await pushAnalysis({
      ts: Date.now(),
      provider: settings.provider,
      model: settings.model,
      goal: settings.goal.preset,
      question: question || null,
      markdown: result.text,
      usage: result.usage || null,
    });
  } catch (e) {
    port.postMessage({ type: 'error', error: String(e.message || e), partial: text });
  }
}

// ------------------------------------------------------------------ routing

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (!msg || typeof msg.type !== 'string') return undefined;

  const handle = async () => {
    switch (msg.type) {
      case 'ic:hello':
        return { ok: true };

      case 'ic:capture':
        return { ok: true, ...(await ingest(msg.origin || sender.origin, msg.batch)) };

      case 'ui:getState': {
        const [settings, data, netlog, analyses, bytes] = await Promise.all([
          getSettings(), getData(), getNetlog(), getAnalyses(), storageFootprint(),
        ]);
        const secrets = await getSecrets();
        return {
          ok: true,
          settings,
          hasKey: Object.fromEntries(Object.keys(PROVIDERS).map((p) => [p, Boolean(secrets[p])])),
          data: data
            ? {
                origin: data.origin,
                capturedAt: data.capturedAt,
                courses: data.courses.length,
                transcript: (data.transcript || []).length,
                schedule: (data.schedule || []).length,
                hasStudent: Boolean(data.student),
                gaps: describeGaps(gapsIn(data)),
                documents: data.documents || [],
              }
            : null,
          documents: data?.documents || [],
          netlog,
          analyses: analyses.slice(0, 10).map((a) => ({
            ts: a.ts, model: a.model, provider: a.provider, question: a.question,
          })),
          bytes,
          providers: PROVIDERS,
        };
      }

      case 'ui:getReport': {
        const [settings, data, snapshots] = await Promise.all([
          getSettings(), getData(), getSnapshots(),
        ]);
        if (!data || !(data.courses || []).length) return { ok: false, error: 'no data yet' };
        return { ok: true, report: analyze(data, settings, snapshots) };
      }

      case 'ui:getAnalysis': {
        const all = await getAnalyses();
        return { ok: true, analysis: all[msg.index ?? 0] || null };
      }

      case 'ui:saveSettings':
        return { ok: true, settings: await saveSettings(msg.patch || {}) };

      case 'ui:saveKey':
        await saveSecret(msg.provider, msg.apiKey);
        return { ok: true };

      case 'ui:listModels': {
        const secrets = await getSecrets();
        const key = msg.apiKey || secrets[msg.provider];
        return { ok: true, models: await listModels(msg.provider, key) };
      }

      case 'ui:crawl':
        return runCrawl(undefined, { force: Boolean(msg.force) });

      case 'ui:scrapeDom': {
        const found = await findPortalTab();
        if (!found) return { ok: false, error: 'No Infinite Campus tab found.' };
        const res = await askTab(found.tab.id, { type: 'ic:scrapeDom' }, 5000);
        return res;
      }

      case 'ui:registerOrigin': {
        const origin = String(msg.origin || '').replace(/\/+$/, '');
        if (!/^https?:\/\/[^/]+$/.test(origin)) return { ok: false, error: 'Not a valid origin.' };
        await registerForOrigin(origin);
        const settings = await getSettings();
        const list = new Set(settings.districtOrigins || []);
        list.add(origin);
        await saveSettings({ districtOrigins: [...list] });
        return { ok: true, origins: [...list] };
      }

      case 'ui:clearData':
        await clearEverything();
        conversations.clear();
        return { ok: true };

      case 'ui:diagnostic': {
        // Structure only: field names, weights, counts and percentages.
        // No assignment titles, no course-independent identifiers, no student
        // or teacher names - safe to paste into a bug report.
        const [settings, data, snapshots] = await Promise.all([
          getSettings(), getData(), getSnapshots(),
        ]);
        if (!data) return { ok: false, error: 'no data yet' };
        const report = analyze(data, settings, snapshots);
        return {
          ok: true,
          diagnostic: {
            generatedAt: new Date().toISOString(),
            fieldNamesSeen: data.sampleKeys || {},
            endpointsFetched: Object.keys(data.fetchedAt || {}),
            districtFeatureFlags: data.displayOptions
              ? Object.fromEntries(Object.entries(data.displayOptions).filter(([, v2]) => v2 === false))
              : null,
            counts: {
              courses: (data.courses || []).length,
              schedule: (data.schedule || []).length,
              transcriptRows: (data.transcript || []).length,
              documents: (data.documents || []).length,
              enrollments: (data.enrollments || []).length,
            },
            courses: report.courses.map((c) => ({
              rigor: c.rigor,
              icReportedPercent: c.percent,
              icReportedScore: c.reportedByIC,
              locallyComputedPercent: c.computedPercent,
              drift: c.driftFromIC,
              method: c.method,
              approximate: c.approximate,
              gradedAssignments: c.trend.n,
              missing: c.missing.count,
              categories: c.categories.map((k) => ({
                weightShare: k.weightShare,
                percent: k.percent,
                possible: k.possible,
                graded: k.graded,
              })),
            })),
          },
        };
      }

      case 'ui:exportData': {
        const [settings, data, snapshots, analyses] = await Promise.all([
          getSettings(), getData(), getSnapshots(), getAnalyses(),
        ]);
        // Keys are deliberately excluded from the export.
        return { ok: true, bundle: { settings, data, snapshots, analyses, exportedAt: Date.now() } };
      }

      default:
        return { ok: false, error: `Unknown message type: ${msg.type}` };
    }
  };

  // Always answer, so a caller is never left waiting on a dropped port.
  handle()
    .then((r) => respond(r ?? { ok: false, error: 'no result' }))
    .catch((e) => respond({ ok: false, error: String(e?.message || e) }));
  return true;
});

// Streaming analysis runs over a port so the UI can render tokens as they land.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name.startsWith('analysis')) {
    port.onMessage.addListener((msg) => {
      if (msg.type === 'run') runAnalysis(port, msg);
    });
    port.onDisconnect.addListener(() => conversations.delete(port.name));
  }

  if (port.name === 'crawl') {
    port.onMessage.addListener(async (msg) => {
      if (msg.type !== 'run') return;
      const res = await runCrawl((p) => {
        try { port.postMessage({ type: 'progress', ...p }); } catch { /* closed */ }
      }, { force: Boolean(msg.force) });
      try { port.postMessage({ type: 'done', ...res }); } catch { /* closed */ }
    });
  }
});

// ----------------------------------------------- custom district registration

async function registerForOrigin(origin) {
  const pattern = `${origin}/*`;
  const id = `ici-${origin.replace(/[^a-z0-9]/gi, '')}`;

  try {
    await chrome.scripting.unregisterContentScripts({ ids: [`${id}-main`, `${id}-iso`] });
  } catch {
    // Nothing registered yet.
  }

  await chrome.scripting.registerContentScripts([
    {
      id: `${id}-main`,
      matches: [pattern],
      js: ['src/content/interceptor.js'],
      world: 'MAIN',
      runAt: 'document_start',
      persistAcrossSessions: true,
    },
    {
      id: `${id}-iso`,
      matches: [pattern],
      js: ['src/content/bridge.js'],
      world: 'ISOLATED',
      runAt: 'document_start',
      persistAcrossSessions: true,
    },
  ]);
}

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === 'install') chrome.runtime.openOptionsPage();
  // Re-register any district origins the user granted previously.
  const settings = await getSettings();
  for (const origin of settings.districtOrigins || []) {
    try {
      const granted = await chrome.permissions.contains({ origins: [`${origin}/*`] });
      if (granted) await registerForOrigin(origin);
    } catch { /* skip */ }
  }
});
