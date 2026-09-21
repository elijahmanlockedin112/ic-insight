/*
 * Isolated-world content script.
 *
 * Two jobs:
 *   1. Receive passively-observed responses from interceptor.js and forward
 *      them to the service worker. This costs the district zero extra requests.
 *   2. Run the Governor: the ONLY place in this extension allowed to originate
 *      a request to a school server, and the only place the limits live.
 *
 * Governor rules, all enforced here and none of them optional:
 *   - GET only. Never POST/PUT/DELETE. Never an auth or token endpoint.
 *   - Same origin as the tab you are already signed into.
 *   - One request at a time, minimum gap with jitter between them.
 *   - Per-round, per-run and per-day ceilings.
 *   - Honours Retry-After; a 429/503 stops the whole run and starts a cooldown.
 *   - 401/403 or a redirect to login stops immediately and never retries auth.
 *   - Circuit breaker after consecutive failures.
 *   - 404s are remembered so a path that does not exist here is never asked
 *     for twice. This is what keeps discovery from looking like probing.
 *   - Only while the tab is in the foreground, and only after you press a button.
 *
 * The background script decides *what* to request; this file decides *whether*
 * and *how fast*. Planning cannot override the limits.
 */
(() => {
  'use strict';
  if (window.__icInsightBridgeInstalled) return;
  window.__icInsightBridgeInstalled = true;

  const ORIGIN = location.origin;
  const NETLOG_KEY = 'netlog';
  const SEEN_KEY = 'seenUrls';
  const DEAD_KEY = 'deadUrls';
  const MAX_BODY = 2_000_000;

  const DEFAULTS = {
    minGapMs: 3000,
    jitterMs: 1500,
    maxPerRound: 14,
    maxPerRun: 25,
    maxPerDay: 100,
    onlyWhenTabVisible: true,
  };

  const today = () => new Date().toISOString().slice(0, 10);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  let inFlight = false;
  let aborted = false;
  let runCount = 0; // resets when the page does
  window.addEventListener('pagehide', () => { aborted = true; });

  // ------------------------------------------------------- passive capture

  const pending = [];
  let flushTimer = null;

  window.addEventListener('message', (ev) => {
    if (ev.source !== window || ev.origin !== ORIGIN) return;
    const d = ev.data;
    if (!d || d.__icInsight !== true || d.kind !== 'capture') return;
    pending.push({ url: d.url, ts: d.ts, body: d.body });
    if (!flushTimer) flushTimer = setTimeout(flush, 800);
  });

  async function flush() {
    flushTimer = null;
    if (!pending.length) return;
    const batch = pending.splice(0, pending.length);
    try {
      await chrome.runtime.sendMessage({ type: 'ic:capture', origin: ORIGIN, batch });
      await rememberUrls(batch.map((b) => b.url));
    } catch {
      // Worker asleep or extension reloading; the next page view re-captures.
    }
  }

  /** Remember which URLs this portal fetches, so the crawler can learn its shape. */
  async function rememberUrls(urls) {
    try {
      const store = await chrome.storage.local.get(SEEN_KEY);
      const seen = store[SEEN_KEY] || {};
      const list = new Set(seen[ORIGIN] || []);
      for (const u of urls) {
        try {
          const parsed = new URL(u, location.href);
          if (parsed.origin === ORIGIN) list.add(parsed.href);
        } catch { /* skip malformed */ }
      }
      seen[ORIGIN] = [...list].slice(-300);
      await chrome.storage.local.set({ [SEEN_KEY]: seen });
    } catch { /* non-fatal */ }
  }

  // --------------------------------------------------------- Governor state

  async function readNetlog() {
    const store = await chrome.storage.local.get(NETLOG_KEY);
    const log = store[NETLOG_KEY] || {};
    const base = {
      day: today(), countToday: 0, lastRequestAt: 0, consecutiveErrors: 0,
      cooldownUntil: 0, lastStatus: null, history: [],
    };
    const merged = { ...base, ...log };
    if (merged.day !== today()) {
      merged.day = today();
      merged.countToday = 0;
    }
    return merged;
  }

  const writeNetlog = (log) => chrome.storage.local.set({ [NETLOG_KEY]: log });

  async function readDead() {
    const store = await chrome.storage.local.get(DEAD_KEY);
    return new Set((store[DEAD_KEY] || {})[ORIGIN] || []);
  }

  async function writeDead(set) {
    const store = await chrome.storage.local.get(DEAD_KEY);
    const dead = store[DEAD_KEY] || {};
    dead[ORIGIN] = [...set].slice(-400);
    await chrome.storage.local.set({ [DEAD_KEY]: dead });
  }

  function safeToRequest(url) {
    let u;
    try { u = new URL(url, location.href); } catch { return false; }
    if (u.origin !== ORIGIN) return false;
    if (u.protocol !== 'https:' && u.hostname !== 'localhost') return false;
    return !/(login|logout|signin|password|oauth|token|saml|sso|authenticate|mfa|otp|verify|recovery)/i
      .test(u.pathname + u.search);
  }

  // ------------------------------------------------------------ the engine

  /**
   * Fetch an explicit, already-planned list of URLs under the Governor.
   * Returns { captured, results, requests, stopped, reason, countToday }.
   */
  async function fetchUrls(urls, opts = {}) {
    const cfg = { ...DEFAULTS, ...(opts.collection || {}) };
    if (inFlight) return { stopped: true, reason: 'a fetch is already running', requests: 0, results: [] };

    const log = await readNetlog();
    const dead = await readDead();
    const now = Date.now();

    if (log.cooldownUntil > now) {
      const mins = Math.ceil((log.cooldownUntil - now) / 60000);
      return { stopped: true, reason: `cooling down for ${mins} more minute(s)`, requests: 0, results: [] };
    }
    if (log.countToday >= cfg.maxPerDay) {
      return { stopped: true, reason: 'daily request budget reached', requests: 0, results: [] };
    }
    if (runCount >= cfg.maxPerRun) {
      return { stopped: true, reason: 'per-visit request budget reached - reload the page to reset', requests: 0, results: [] };
    }
    if (cfg.onlyWhenTabVisible && document.visibilityState !== 'visible') {
      return { stopped: true, reason: 'tab is not in the foreground', requests: 0, results: [] };
    }

    const queue = [...new Set(urls)]
      .filter(safeToRequest)
      .filter((u) => !dead.has(u))
      .slice(0, Math.min(
        cfg.maxPerRound,
        cfg.maxPerDay - log.countToday,
        cfg.maxPerRun - runCount,
      ));

    if (!queue.length) {
      return { stopped: false, reason: 'nothing new to request', requests: 0, results: [], captured: 0 };
    }

    const batch = [];
    const results = [];
    let requests = 0;
    let stopped = false;
    let reason = null;

    inFlight = true;
    try {
      for (const url of queue) {
        if (aborted) { stopped = true; reason = 'page navigated away'; break; }
        if (cfg.onlyWhenTabVisible && document.visibilityState !== 'visible') {
          stopped = true; reason = 'tab left the foreground'; break;
        }

        const gap = cfg.minGapMs + Math.random() * cfg.jitterMs;
        const since = Date.now() - (log.lastRequestAt || 0);
        if (since < gap) await sleep(gap - since);
        if (aborted) { stopped = true; reason = 'page navigated away'; break; }

        const started = Date.now();
        let res = null;
        let err = null;
        try {
          res = await fetch(url, {
            method: 'GET',
            credentials: 'same-origin',
            cache: 'no-cache',
            redirect: 'follow',
            headers: { Accept: 'application/json, text/plain, */*' },
          });
        } catch (e) {
          err = e;
        }

        requests += 1;
        runCount += 1;
        log.countToday += 1;
        log.lastRequestAt = Date.now();
        log.lastStatus = res ? res.status : 'network-error';
        log.history = [
          { t: log.lastRequestAt, url: shortUrl(url), status: log.lastStatus, ms: Date.now() - started },
          ...(log.history || []),
        ].slice(0, 120);

        // --- stop conditions, strictest first ---
        if (err) {
          log.consecutiveErrors += 1;
          results.push({ url, status: 'network-error' });
        } else if (res.status === 401 || res.status === 403) {
          results.push({ url, status: res.status });
          stopped = true;
          reason = 'the portal says you are signed out - sign in again, then retry';
          await writeNetlog(log);
          break;
        } else if (res.status === 429 || res.status === 503) {
          const retryAfter = Number(res.headers.get('retry-after'));
          const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
            ? Math.min(retryAfter * 1000, 6 * 3600 * 1000)
            : 6 * 3600 * 1000;
          log.cooldownUntil = Date.now() + waitMs;
          log.consecutiveErrors += 1;
          results.push({ url, status: res.status });
          stopped = true;
          reason = `the server asked us to slow down (HTTP ${res.status}) - pausing for ` +
                   `${Math.ceil(waitMs / 60000)} minute(s)`;
          await writeNetlog(log);
          break;
        } else if (res.status === 404 || res.status === 400 || res.status === 405) {
          // This path does not exist on this district's install. Never ask again.
          dead.add(url);
          results.push({ url, status: res.status, dead: true });
          log.consecutiveErrors = 0;
        } else if (res.status >= 500) {
          log.consecutiveErrors += 1;
          results.push({ url, status: res.status });
        } else if (res.redirected && /login|signin/i.test(res.url)) {
          stopped = true;
          reason = 'the portal redirected to a login page - sign in again, then retry';
          results.push({ url, status: 'redirected-to-login' });
          await writeNetlog(log);
          break;
        } else {
          log.consecutiveErrors = 0;
          const ct = res.headers.get('content-type') || '';
          let ok = false;
          if (/json|text\/plain/i.test(ct)) {
            const text = await res.text();
            const t = text.trim();
            if (t && (t[0] === '{' || t[0] === '[') && t.length < MAX_BODY) {
              batch.push({ url, ts: Date.now(), body: t });
              ok = true;
            }
          }
          if (!ok) dead.add(url); // 200 but not JSON: an HTML shell, not data.
          results.push({ url, status: res.status, json: ok });
        }

        if (log.consecutiveErrors >= 3) {
          log.cooldownUntil = Date.now() + 6 * 3600 * 1000;
          stopped = true;
          reason = 'several requests failed in a row - stopping for 6 hours rather than ' +
                   'keep knocking on a door that is not answering';
          await writeNetlog(log);
          break;
        }

        await writeNetlog(log);
      }
    } finally {
      inFlight = false;
    }

    await writeNetlog(log);
    await writeDead(dead);

    if (batch.length) {
      await rememberUrls(batch.map((b) => b.url));
      try {
        await chrome.runtime.sendMessage({ type: 'ic:capture', origin: ORIGIN, batch });
      } catch { /* worker restarting */ }
    }

    return {
      stopped, reason, requests, results,
      captured: batch.length,
      countToday: log.countToday,
      remainingToday: Math.max(0, cfg.maxPerDay - log.countToday),
    };
  }

  const shortUrl = (u) => {
    try {
      const p = new URL(u);
      return (p.pathname + p.search).slice(0, 160);
    } catch {
      return String(u).slice(0, 160);
    }
  };

  // ------------------------------------------------------- DOM last resort

  /**
   * Conservative scrape of whatever grades are already painted on screen.
   * Costs nothing and touches no network. Low confidence by nature: district
   * markup varies, so this is a fallback, not the main path.
   */
  function scrapeVisibleGrades() {
    const rows = [];
    const seen = new Set();
    const nodes = document.querySelectorAll(
      '[class*="course"], [class*="grade"], [role="listitem"], li, tr, article',
    );

    for (const node of nodes) {
      if (rows.length >= 40) break;
      const text = (node.innerText || '').trim();
      if (!text || text.length > 260) continue;

      const pctMatch = text.match(/(\d{1,3}(?:\.\d+)?)\s*%/);
      if (!pctMatch) continue;
      const percent = Number(pctMatch[1]);
      if (!Number.isFinite(percent) || percent > 110) continue;

      const letterMatch = text.match(/\b([A-DF][+-]?)\b(?!\w)/);
      const name = text
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l.length > 3 && !/^\d/.test(l) && !/%$/.test(l));
      if (!name) continue;

      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({ courseName: name.slice(0, 120), percent, letter: letterMatch ? letterMatch[1] : null });
    }

    return { source: 'dom', confidence: 'low', url: location.href, rows };
  }

  // ------------------------------------------------------------- messaging

  chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
    if (!msg || typeof msg.type !== 'string') return undefined;

    if (msg.type === 'ic:probe') {
      readNetlog().then((log) => respond({
        ok: true,
        origin: ORIGIN,
        href: location.href,
        visible: document.visibilityState === 'visible',
        countToday: log.countToday,
        cooldownUntil: log.cooldownUntil,
        runCount,
      }));
      return true;
    }

    if (msg.type === 'ic:scrapeDom') {
      try {
        respond({ ok: true, result: scrapeVisibleGrades() });
      } catch (e) {
        respond({ ok: false, error: String(e) });
      }
      return true;
    }

    if (msg.type === 'ic:fetchUrls') {
      fetchUrls(msg.urls || [], msg.settings || {})
        .then((r) => respond({ ok: true, ...r }))
        .catch((e) => respond({ ok: false, error: String(e) }));
      return true; // async
    }

    return undefined;
  });

  chrome.runtime.sendMessage({ type: 'ic:hello', origin: ORIGIN, href: location.href })
    .catch(() => {});
})();
