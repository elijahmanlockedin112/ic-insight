/*
 * Passive response observer. Runs in the page's own JavaScript world.
 *
 * This makes ZERO network requests of its own. It only looks at responses the
 * Infinite Campus portal already asked for as you click around, copies the JSON
 * body, and hands it to the extension. That is the whole point: normal browsing
 * generates exactly the traffic it would have generated anyway, so there is no
 * extra load on the district's servers and nothing that looks like scraping.
 *
 * It never reads, stores or forwards anything from an authentication endpoint.
 */
(() => {
  'use strict';
  if (window.__icInsightInterceptorInstalled) return;
  window.__icInsightInterceptorInstalled = true;

  const MAX_BODY_BYTES = 2_000_000;

  // Anything that could carry credentials or session material is off limits.
  const DENY = /(login|logout|signin|sign-in|password|passwd|oauth|token|saml|sso|authenticate|authorization|security|mfa|otp|verify|recovery|session\b|\.js$|\.css$|\.png$|\.jpg$|\.svg$|\.woff)/i;

  // IC portal data lives under these path shapes across district deployments.
  const ALLOW = /\/(campus|api|resources|prism|portal|student)\//i;

  function interesting(url) {
    if (typeof url !== 'string' || !url) return false;
    let u;
    try {
      u = new URL(url, location.href);
    } catch {
      return false;
    }
    if (u.origin !== location.origin) return false;
    const path = u.pathname + u.search;
    if (DENY.test(path)) return false;
    return ALLOW.test(u.pathname);
  }

  /*
   * A URL blocklist cannot be complete: districts expose endpoints we have
   * never seen, and one of them turned out to return the signed-in user's
   * account record - salt, TOTP token, session id - from a path that looked
   * perfectly ordinary. So the body is inspected too, and any response that
   * carries credential-shaped keys is dropped whole. Being over-eager here only
   * costs a little grade data; being under-eager copies secrets.
   */
  const SENSITIVE_KEY = new RegExp(
    '"[A-Za-z0-9_]*(?:salt|password|passwd|secret|totp|sessionid|session_id'
    + '|apikey|api_key|privatekey|private_key|jwt|bearer|oauth)[A-Za-z0-9_]*"\s*:',
    'i',
  );

  function publish(url, text) {
    if (!text || text.length > MAX_BODY_BYTES) return;
    const trimmed = text.trim();
    if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) return;
    if (SENSITIVE_KEY.test(trimmed)) return;
    try {
      window.postMessage(
        { __icInsight: true, kind: 'capture', url, ts: Date.now(), body: trimmed },
        location.origin,
      );
    } catch {
      /* page navigated away mid-post; nothing to do */
    }
  }

  function urlOf(input) {
    if (typeof input === 'string') return input;
    if (input && typeof input.url === 'string') return input.url;
    try {
      return String(input);
    } catch {
      return '';
    }
  }

  // ---------------------------------------------------------------- fetch
  const nativeFetch = window.fetch;
  if (typeof nativeFetch === 'function') {
    window.fetch = function icInsightFetch(input, init) {
      const promise = nativeFetch.apply(this, arguments);
      try {
        const requested = urlOf(input);
        promise
          .then((res) => {
            try {
              if (!res || !res.ok) return;
              const url = res.url || requested;
              if (!interesting(url)) return;
              const ct = res.headers.get('content-type') || '';
              if (!/json|javascript|text\/plain/i.test(ct)) return;
              res.clone().text().then((t) => publish(url, t)).catch(() => {});
            } catch {
              /* observation must never break the page */
            }
          })
          .catch(() => {});
      } catch {
        /* ignore */
      }
      return promise;
    };
    // Keep the wrapper indistinguishable to feature-detection code.
    try {
      Object.defineProperty(window.fetch, 'name', { value: 'fetch' });
      window.fetch.toString = () => nativeFetch.toString();
    } catch {
      /* non-fatal */
    }
  }

  // ------------------------------------------------------------------ XHR
  const XHR = window.XMLHttpRequest;
  if (XHR && XHR.prototype) {
    const nativeOpen = XHR.prototype.open;
    const nativeSend = XHR.prototype.send;

    XHR.prototype.open = function icInsightOpen(method, url) {
      try {
        this.__icUrl = url;
        this.__icMethod = String(method || 'GET').toUpperCase();
      } catch {
        /* ignore */
      }
      return nativeOpen.apply(this, arguments);
    };

    XHR.prototype.send = function icInsightSend() {
      try {
        if (this.__icMethod === 'GET' && interesting(this.__icUrl)) {
          this.addEventListener('load', function onLoad() {
            try {
              if (this.status < 200 || this.status >= 300) return;
              const type = this.responseType;
              let text = null;
              if (type === '' || type === 'text') text = this.responseText;
              else if (type === 'json' && this.response) text = JSON.stringify(this.response);
              if (text) publish(new URL(this.__icUrl, location.href).href, text);
            } catch {
              /* ignore */
            }
          });
        }
      } catch {
        /* ignore */
      }
      return nativeSend.apply(this, arguments);
    };
  }

  // The isolated world asks for a same-origin GET only when the user explicitly
  // pressed "Fill gaps". Everything about rate limiting is enforced there.
  window.addEventListener('message', (ev) => {
    if (ev.source !== window || ev.origin !== location.origin) return;
    const d = ev.data;
    if (!d || d.__icInsight !== true || d.kind !== 'ping') return;
    window.postMessage(
      { __icInsight: true, kind: 'pong', href: location.href, ts: Date.now() },
      location.origin,
    );
  });
})();
