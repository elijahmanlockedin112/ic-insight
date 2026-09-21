// Bring-your-own-key model access. Four providers, one interface, all streaming.
//
// Your key is read from chrome.storage.local and sent only to the provider you
// picked. It is never logged, never bundled into the analysis record, and never
// touches any server belonging to this extension (there isn't one).

export const PROVIDERS = {
  anthropic: {
    label: 'Anthropic (Claude)',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    keyHint: 'starts with sk-ant-',
    defaultModel: 'claude-opus-5',
    supportsEffort: true,
    fallbackModels: [
      { id: 'claude-opus-5', label: 'Claude Opus 5 - best reasoning' },
      { id: 'claude-sonnet-5', label: 'Claude Sonnet 5 - faster, cheaper' },
      { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5 - cheapest' },
      { id: 'claude-opus-4-8', label: 'Claude Opus 4.8' },
    ],
  },
  openai: {
    label: 'OpenAI',
    keyUrl: 'https://platform.openai.com/api-keys',
    keyHint: 'starts with sk-',
    defaultModel: 'gpt-4o',
    supportsEffort: false,
    fallbackModels: [
      { id: 'gpt-4o', label: 'gpt-4o' },
      { id: 'gpt-4o-mini', label: 'gpt-4o-mini' },
    ],
  },
  google: {
    label: 'Google (Gemini)',
    keyUrl: 'https://aistudio.google.com/apikey',
    keyHint: 'from Google AI Studio',
    defaultModel: 'gemini-2.0-flash',
    supportsEffort: false,
    fallbackModels: [
      { id: 'gemini-2.0-flash', label: 'gemini-2.0-flash' },
      { id: 'gemini-1.5-pro', label: 'gemini-1.5-pro' },
    ],
  },
  openrouter: {
    label: 'OpenRouter (many models)',
    keyUrl: 'https://openrouter.ai/keys',
    keyHint: 'starts with sk-or-',
    defaultModel: 'anthropic/claude-opus-5',
    supportsEffort: false,
    fallbackModels: [
      { id: 'anthropic/claude-opus-5', label: 'Claude Opus 5 (via OpenRouter)' },
      { id: 'openai/gpt-4o', label: 'gpt-4o (via OpenRouter)' },
    ],
  },
};

const ANTHROPIC_VERSION = '2023-06-01';

/** Anthropic rejects sampling params on Claude 4.6+ models, so we never send them. */
const anthropicHeaders = (apiKey) => ({
  'content-type': 'application/json',
  'x-api-key': apiKey,
  'anthropic-version': ANTHROPIC_VERSION,
  // Required when calling the API from a browser-like context.
  'anthropic-dangerous-direct-browser-access': 'true',
});

// -------------------------------------------------------------- model lists

export async function listModels(provider, apiKey) {
  const spec = PROVIDERS[provider];
  if (!spec) throw new Error(`Unknown provider: ${provider}`);
  if (!apiKey) return spec.fallbackModels;

  try {
    if (provider === 'anthropic') {
      const r = await fetch('https://api.anthropic.com/v1/models?limit=100', {
        headers: anthropicHeaders(apiKey),
      });
      if (!r.ok) throw new Error(await errText(r));
      const j = await r.json();
      return (j.data || []).map((m) => ({ id: m.id, label: m.display_name || m.id }));
    }

    if (provider === 'openai') {
      const r = await fetch('https://api.openai.com/v1/models', {
        headers: { authorization: `Bearer ${apiKey}` },
      });
      if (!r.ok) throw new Error(await errText(r));
      const j = await r.json();
      return (j.data || [])
        .map((m) => ({ id: m.id, label: m.id }))
        .filter((m) => /^(gpt|o[0-9]|chatgpt)/i.test(m.id))
        .sort((a, b) => a.id.localeCompare(b.id));
    }

    if (provider === 'google') {
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`,
      );
      if (!r.ok) throw new Error(await errText(r));
      const j = await r.json();
      return (j.models || [])
        .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
        .map((m) => ({ id: String(m.name).replace(/^models\//, ''), label: m.displayName || m.name }));
    }

    if (provider === 'openrouter') {
      const r = await fetch('https://openrouter.ai/api/v1/models', {
        headers: { authorization: `Bearer ${apiKey}` },
      });
      if (!r.ok) throw new Error(await errText(r));
      const j = await r.json();
      return (j.data || []).map((m) => ({ id: m.id, label: m.name || m.id }));
    }
  } catch (e) {
    // A dead key or an offline moment should not block the settings page.
    return spec.fallbackModels.map((m) => ({ ...m, note: `live list unavailable: ${e.message}` }));
  }

  return spec.fallbackModels;
}

async function errText(res) {
  let body = '';
  try {
    body = await res.text();
  } catch { /* ignore */ }
  try {
    const j = JSON.parse(body);
    body = j.error?.message || j.message || body;
  } catch { /* leave as text */ }
  return `HTTP ${res.status}: ${String(body).slice(0, 400)}`;
}

// ---------------------------------------------------------------- streaming

/**
 * Stream a completion.
 * @param {object} opts { provider, apiKey, model, system, messages, maxTokens, effort, signal }
 * @param {(chunk:string)=>void} onDelta
 * @returns {Promise<{text:string, stopReason:string|null, usage:object|null}>}
 */
export async function streamCompletion(opts, onDelta) {
  const { provider } = opts;
  if (provider === 'anthropic') return streamAnthropic(opts, onDelta);
  if (provider === 'google') return streamGoogle(opts, onDelta);
  return streamOpenAiCompatible(opts, onDelta);
}

async function streamAnthropic(opts, onDelta) {
  const body = {
    model: opts.model,
    max_tokens: opts.maxTokens ?? 16000,
    stream: true,
    system: opts.system,
    messages: opts.messages,
    // Adaptive thinking is the current API shape; budget_tokens is rejected on
    // Claude 4.7+ and sampling params are rejected on Claude 4.6+.
    thinking: { type: 'adaptive' },
  };
  if (opts.effort) body.output_config = { effort: opts.effort };

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: anthropicHeaders(opts.apiKey),
    body: JSON.stringify(body),
    signal: opts.signal,
  });
  if (!res.ok) throw new Error(await errText(res));

  let text = '';
  let stopReason = null;
  let usage = null;
  let stopDetails = null;

  await readSse(res, (evt) => {
    if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
      text += evt.delta.text;
      onDelta?.(evt.delta.text);
    } else if (evt.type === 'message_delta') {
      stopReason = evt.delta?.stop_reason ?? stopReason;
      stopDetails = evt.delta?.stop_details ?? stopDetails;
      usage = evt.usage ?? usage;
    } else if (evt.type === 'message_start') {
      usage = evt.message?.usage ?? usage;
    } else if (evt.type === 'error') {
      throw new Error(evt.error?.message || 'Anthropic stream error');
    }
  });

  if (stopReason === 'refusal') {
    throw new Error(
      'The model declined this request' +
      (stopDetails?.category ? ` (${stopDetails.category})` : '') +
      '. Try rephrasing your question or switching models.',
    );
  }

  return { text, stopReason, usage };
}

async function streamOpenAiCompatible(opts, onDelta) {
  const isRouter = opts.provider === 'openrouter';
  const url = isRouter
    ? 'https://openrouter.ai/api/v1/chat/completions'
    : 'https://api.openai.com/v1/chat/completions';

  const headers = {
    'content-type': 'application/json',
    authorization: `Bearer ${opts.apiKey}`,
  };
  if (isRouter) headers['X-Title'] = 'IC Insight';

  // OpenAI renamed the cap for newer models; OpenRouter still takes max_tokens.
  const tokenCap = isRouter
    ? { max_tokens: opts.maxTokens ?? 16000 }
    : { max_completion_tokens: opts.maxTokens ?? 16000 };

  const res = await fetch(url, {
    method: 'POST',
    headers,
    signal: opts.signal,
    body: JSON.stringify({
      model: opts.model,
      stream: true,
      ...tokenCap,
      messages: [
        { role: 'system', content: opts.system },
        ...opts.messages.map((m) => ({ role: m.role, content: contentToText(m.content) })),
      ],
    }),
  });
  if (!res.ok) throw new Error(await errText(res));

  let text = '';
  let stopReason = null;
  let usage = null;

  await readSse(res, (evt) => {
    const delta = evt.choices?.[0]?.delta?.content;
    if (delta) {
      text += delta;
      onDelta?.(delta);
    }
    if (evt.choices?.[0]?.finish_reason) stopReason = evt.choices[0].finish_reason;
    if (evt.usage) usage = evt.usage;
  });

  return { text, stopReason, usage };
}

async function streamGoogle(opts, onDelta) {
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(opts.model)}` +
    `:streamGenerateContent?alt=sse&key=${encodeURIComponent(opts.apiKey)}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal: opts.signal,
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: opts.system }] },
      contents: opts.messages.map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: contentToText(m.content) }],
      })),
      generationConfig: { maxOutputTokens: opts.maxTokens ?? 16000 },
    }),
  });
  if (!res.ok) throw new Error(await errText(res));

  let text = '';
  let stopReason = null;
  let usage = null;

  await readSse(res, (evt) => {
    const parts = evt.candidates?.[0]?.content?.parts || [];
    for (const p of parts) {
      if (p.text) {
        text += p.text;
        onDelta?.(p.text);
      }
    }
    if (evt.candidates?.[0]?.finishReason) stopReason = evt.candidates[0].finishReason;
    if (evt.usageMetadata) usage = evt.usageMetadata;
  });

  return { text, stopReason, usage };
}

const contentToText = (c) =>
  typeof c === 'string' ? c : (c || []).map((b) => b.text || '').join('');

/** Minimal SSE reader shared by all providers. */
async function readSse(res, onEvent) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const SEPARATOR = /\r?\n\r?\n/;
  let buffer = '';

  const handleFrame = (frame) => {
    const dataLines = frame
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim());
    if (!dataLines.length) return false;

    const payload = dataLines.join('\n');
    if (payload === '[DONE]') return true; // stop
    try {
      onEvent(JSON.parse(payload));
    } catch { /* keep-alive comment or a partial frame */ }
    return false;
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // Events are separated by a blank line; tolerate both \n\n and \r\n\r\n.
    for (;;) {
      const match = SEPARATOR.exec(buffer);
      if (!match) break;
      const frame = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      if (handleFrame(frame)) return;
    }
  }

  if (buffer.trim()) handleFrame(buffer);
}
