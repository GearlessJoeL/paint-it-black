import { extractJsonObject } from './antigravity.mjs';

const SESSION_IDLE_TTL_MS = 10 * 60_000;
const MAX_SESSIONS = 6;
const MAX_TURNS_PER_SESSION = 12;

export const API_PROVIDER_DEFAULTS = {
  openai: {
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    requiresKey: true,
    envVar: 'OPENAI_API_KEY',
    models: [
      { id: 'gpt-4o-mini', label: 'gpt-4o-mini (Fast & low cost)' },
      { id: 'gpt-4o', label: 'gpt-4o (Balanced)' },
      { id: 'gpt-4.1-mini', label: 'gpt-4.1-mini (Fast)' },
      { id: 'gpt-4.1', label: 'gpt-4.1 (Strong)' },
      { id: 'o4-mini', label: 'o4-mini (Reasoning)' },
    ],
  },
  openrouter: {
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'google/gemini-2.5-flash',
    requiresKey: true,
    envVar: 'OPENROUTER_API_KEY',
    models: [
      { id: 'google/gemini-2.5-flash', label: 'google/gemini-2.5-flash (Fastest)' },
      { id: 'anthropic/claude-sonnet-4.5', label: 'anthropic/claude-sonnet-4.5 (Strong)' },
      { id: 'openai/gpt-4o-mini', label: 'openai/gpt-4o-mini (Low cost)' },
      { id: 'openai/gpt-4.1-mini', label: 'openai/gpt-4.1-mini (Fast)' },
      { id: 'deepseek/deepseek-chat-v3-0324', label: 'deepseek/deepseek-chat-v3-0324 (Value)' },
    ],
  },
  local: {
    label: 'Local URL (Ollama / LM Studio / vLLM)',
    baseUrl: 'http://127.0.0.1:11434/v1',
    defaultModel: 'qwen2.5:14b',
    requiresKey: false,
    envVar: 'LOCAL_API_KEY',
    models: [
      { id: 'qwen2.5:14b', label: 'qwen2.5:14b (Ollama)' },
      { id: 'qwen2.5:7b', label: 'qwen2.5:7b (Ollama fast)' },
      { id: 'llama3.1:8b', label: 'llama3.1:8b (Ollama)' },
      { id: 'gemma3:12b', label: 'gemma3:12b (Ollama)' },
      { id: 'mistral:7b', label: 'mistral:7b (Ollama)' },
    ],
  },
  anthropic: {
    label: 'Anthropic (Claude)',
    baseUrl: 'https://api.anthropic.com',
    defaultModel: 'claude-sonnet-4-5',
    requiresKey: true,
    envVar: 'ANTHROPIC_API_KEY',
    models: [
      { id: 'claude-haiku-4-5', label: 'claude-haiku-4-5 (Fastest)' },
      { id: 'claude-sonnet-4-5', label: 'claude-sonnet-4-5 (Recommended)' },
      { id: 'claude-opus-4-1', label: 'claude-opus-4-1 (Highest quality)' },
    ],
  },
  gemini: {
    label: 'Google Gemini API',
    baseUrl: 'https://generativelanguage.googleapis.com',
    defaultModel: 'gemini-2.5-flash',
    requiresKey: true,
    envVar: 'GEMINI_API_KEY',
    models: [
      { id: 'gemini-2.5-flash', label: 'gemini-2.5-flash (Fastest)' },
      { id: 'gemini-2.5-pro', label: 'gemini-2.5-pro (Highest quality)' },
      { id: 'gemini-2.0-flash', label: 'gemini-2.0-flash (Legacy fast)' },
    ],
  },
};

function isLocalBaseUrl(url) {
  return /^https?:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\]|host\.docker\.internal|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|[^/]+\.local)(:\d+)?(\/|$)/i.test(
    String(url || '').trim(),
  );
}

function normalizeProvider(raw) {
  const val = String(raw || '').trim().toLowerCase();
  if (val === 'openrouter' || val === 'open-router') return 'openrouter';
  if (val === 'local' || val === 'ollama' || val === 'lmstudio' || val === 'vllm') return 'local';
  if (val === 'anthropic' || val === 'claude') return 'anthropic';
  if (val === 'gemini' || val === 'google') return 'gemini';
  return 'openai';
}

export class DirectApiAdapter {
  constructor({ env = process.env, apiDefaults = {} } = {}) {
    this.id = 'api';
    this.label = 'Direct API / Local URL';
    this.description =
      'Calls OpenAI, OpenRouter, a local OpenAI-compatible server (Ollama/LM Studio/vLLM), Anthropic, or Gemini directly.';
    this.env = env;
    this.apiDefaults = apiDefaults;
    this.sessions = new Map();
  }

  #getEnvKeysPresent() {
    return {
      openai: Boolean(this.env.OPENAI_API_KEY),
      openrouter: Boolean(this.env.OPENROUTER_API_KEY),
      local: Boolean(this.env.LOCAL_API_KEY),
      anthropic: Boolean(this.env.ANTHROPIC_API_KEY),
      gemini: Boolean(this.env.GEMINI_API_KEY || this.env.GOOGLE_API_KEY),
    };
  }

  #resolveConfig({ model = '', apiConfig = {} } = {}) {
    const provider = normalizeProvider(apiConfig.provider || this.apiDefaults.provider || this.env.API_PROVIDER || 'openai');
    const defaults = API_PROVIDER_DEFAULTS[provider];

    const envKey =
      provider === 'openrouter'
        ? this.env.OPENROUTER_API_KEY
        : provider === 'local'
          ? this.env.LOCAL_API_KEY
          : provider === 'anthropic'
            ? this.env.ANTHROPIC_API_KEY
            : provider === 'gemini'
              ? this.env.GEMINI_API_KEY || this.env.GOOGLE_API_KEY
              : this.env.OPENAI_API_KEY;

    const envBaseUrl = provider === 'local' ? this.env.LOCAL_API_BASE_URL || this.env.API_BASE_URL : this.env.API_BASE_URL;
    const apiKey = String(apiConfig.apiKey || envKey || '').trim();
    const baseUrl = String(apiConfig.baseUrl || this.apiDefaults.baseUrl || envBaseUrl || defaults.baseUrl)
      .trim()
      .replace(/\/+$/, '');
    const resolvedModel =
      String(model && model !== 'cli-default' ? model : apiConfig.model || this.env.API_MODEL || defaults.defaultModel).trim();

    return { provider, apiKey, baseUrl, model: resolvedModel };
  }

  async checkStatus() {
    const envKeys = this.#getEnvKeysPresent();
    const anyEnvKey = envKeys.openai || envKeys.openrouter || envKeys.anthropic || envKeys.gemini;
    const allModels = [
      ...API_PROVIDER_DEFAULTS.openai.models,
      ...API_PROVIDER_DEFAULTS.openrouter.models,
      ...API_PROVIDER_DEFAULTS.local.models,
      ...API_PROVIDER_DEFAULTS.anthropic.models,
      ...API_PROVIDER_DEFAULTS.gemini.models,
    ];

    return {
      id: this.id,
      label: this.label,
      description: this.description,
      installed: true,
      authenticated: anyEnvKey,
      requiresApiKey: true,
      envKeys,
      providers: API_PROVIDER_DEFAULTS,
      models: allModels,
      message: anyEnvKey
        ? 'Ready (API key detected in environment; can also override or choose Local URL in Settings)'
        : 'Enter an API key in Settings (OpenAI / OpenRouter / Anthropic / Gemini) or choose Local URL (Ollama / LM Studio / vLLM).',
    };
  }

  #getSessionKey(sessionKey, cfg) {
    if (!sessionKey) return '';
    return `${sessionKey}::${cfg.provider}::${cfg.baseUrl}::${cfg.model}`;
  }

  isSessionSeeded(sessionKey, { model = '', apiConfig = {} } = {}) {
    if (!sessionKey) return false;
    const cfg = this.#resolveConfig({ model, apiConfig });
    const fullKey = this.#getSessionKey(sessionKey, cfg);
    const entry = this.sessions.get(fullKey);
    if (!entry) return false;
    if (Date.now() - entry.lastUsedAt > SESSION_IDLE_TTL_MS || entry.turnCount >= MAX_TURNS_PER_SESSION) {
      this.sessions.delete(fullKey);
      return false;
    }
    return entry.messages.length > 0;
  }

  async #callOpenAi({ provider, baseUrl, apiKey, model, effort, messages, signal }) {
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    if (provider === 'openrouter') {
      headers['HTTP-Referer'] = 'https://github.com/GearlessJoeL/paint-it-black';
      headers['X-Title'] = 'Paint It Black';
    }

    const endpoint = /\/chat\/completions$/i.test(baseUrl) ? baseUrl : `${baseUrl}/chat/completions`;
    const body = {
      model,
      messages,
      response_format: { type: 'json_object' },
    };
    if (effort && /^(o[134]|gpt-5)/i.test(model)) {
      body.reasoning_effort = effort === 'xhigh' ? 'high' : effort;
    }

    let res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    });

    // Some OpenAI-compatible servers reject response_format; retry once cleanly without it
    if (res.status === 400) {
      const errText = await res.text().catch(() => '');
      if (/response_format/i.test(errText)) {
        delete body.response_format;
        res = await fetch(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal,
        });
      } else {
        throw new Error(`OpenAI API error (HTTP 400): ${errText.slice(0, 400)}`);
      }
    }

    if (res.status === 401 || res.status === 403) {
      const err = new Error(`API authentication failed (HTTP ${res.status}). Check your API key in Settings.`);
      err.code = 'AUTH_REQUIRED';
      throw err;
    }
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`API error (HTTP ${res.status}): ${txt.slice(0, 400)}`);
    }

    const json = await res.json();
    const content = json.choices?.[0]?.message?.content;
    const rawText = Array.isArray(content)
      ? content.map((p) => (typeof p === 'string' ? p : p?.text || '')).join('')
      : String(content || '');

    return { rawText, usage: json.usage || null };
  }

  async #callAnthropic({ baseUrl, apiKey, model, messages, signal }) {
    const endpoint = /\/v1\/messages$/i.test(baseUrl) ? baseUrl : `${baseUrl}/v1/messages`;
    const systemMsg = messages.find((m) => m.role === 'system')?.content || '';
    const chatMessages = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }));

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        ...(systemMsg ? { system: systemMsg } : {}),
        messages: chatMessages,
      }),
      signal,
    });

    if (res.status === 401 || res.status === 403) {
      const err = new Error(`Anthropic API authentication failed (HTTP ${res.status}). Check your API key in Settings.`);
      err.code = 'AUTH_REQUIRED';
      throw err;
    }
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`Anthropic API error (HTTP ${res.status}): ${txt.slice(0, 400)}`);
    }

    const json = await res.json();
    const rawText = (Array.isArray(json.content) ? json.content : [])
      .filter((b) => b?.type === 'text')
      .map((b) => b.text)
      .join('');

    return { rawText, usage: json.usage || null };
  }

  async #callGemini({ baseUrl, apiKey, model, messages, signal }) {
    const systemMsg = messages.find((m) => m.role === 'system')?.content || '';
    const contents = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      }));

    const cleanModel = model.replace(/^models\//, '');
    const endpoint = `${baseUrl}/v1beta/models/${encodeURIComponent(cleanModel)}:generateContent?key=${encodeURIComponent(apiKey)}`;

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...(systemMsg ? { systemInstruction: { parts: [{ text: systemMsg }] } } : {}),
        contents,
        generationConfig: {
          responseMimeType: 'application/json',
        },
      }),
      signal,
    });

    if (res.status === 401 || res.status === 403) {
      const err = new Error(`Gemini API authentication failed (HTTP ${res.status}). Check your API key in Settings.`);
      err.code = 'AUTH_REQUIRED';
      throw err;
    }
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`Gemini API error (HTTP ${res.status}): ${txt.slice(0, 400)}`);
    }

    const json = await res.json();
    const parts = json.candidates?.[0]?.content?.parts || [];
    const rawText = parts.map((p) => p?.text || '').join('');
    return { rawText, usage: json.usageMetadata || null };
  }

  async runUnifiedTurn({
    sessionKey = '',
    prompt,
    schema,
    model = '',
    effort = '',
    apiConfig = {},
    signal,
    onEvent = () => {},
  }) {
    const cfg = this.#resolveConfig({ model, apiConfig });

    const requiresKey = API_PROVIDER_DEFAULTS[cfg.provider]?.requiresKey !== false;
    if (requiresKey && !cfg.apiKey && !isLocalBaseUrl(cfg.baseUrl)) {
      const envHint = API_PROVIDER_DEFAULTS[cfg.provider]?.envVar || 'OPENAI_API_KEY';
      const err = new Error(
        `No API key configured for ${API_PROVIDER_DEFAULTS[cfg.provider].label}. Add one in Settings or set ${envHint} on the server.`,
      );
      err.code = 'AUTH_REQUIRED';
      throw err;
    }

    const fullKey = this.#getSessionKey(sessionKey, cfg);
    let session = fullKey ? this.sessions.get(fullKey) : null;
    if (session && (Date.now() - session.lastUsedAt > SESSION_IDLE_TTL_MS || session.turnCount >= MAX_TURNS_PER_SESSION)) {
      this.sessions.delete(fullKey);
      session = null;
    }

    const systemPrompt =
      'You are a precise LaTeX resume tailoring assistant. Always return ONLY a single valid raw JSON object matching this exact JSON Schema (no markdown fences, no extra prose):\n' +
      JSON.stringify(schema);

    const turnMessages = session
      ? [...session.messages, { role: 'user', content: String(prompt || '') }]
      : [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: String(prompt || '') },
        ];

    onEvent({ kind: 'status', text: `Calling ${API_PROVIDER_DEFAULTS[cfg.provider].label} (${cfg.model})…` });

    let result;
    if (cfg.provider === 'anthropic') {
      result = await this.#callAnthropic({ ...cfg, messages: turnMessages, signal });
    } else if (cfg.provider === 'gemini') {
      result = await this.#callGemini({ ...cfg, messages: turnMessages, signal });
    } else {
      result = await this.#callOpenAi({ ...cfg, effort, messages: turnMessages, signal });
    }

    const data = extractJsonObject(result.rawText);
    if (!data) {
      throw new Error(
        `API response was not valid JSON. Preview: ${String(result.rawText || '').trim().slice(0, 400) || '(empty)'}`,
      );
    }

    if (fullKey) {
      this.sessions.set(fullKey, {
        messages: [...turnMessages, { role: 'assistant', content: JSON.stringify(data) }],
        turnCount: (session?.turnCount || 0) + 1,
        lastUsedAt: Date.now(),
      });
      while (this.sessions.size > MAX_SESSIONS) {
        const oldest = this.sessions.keys().next().value;
        if (oldest) this.sessions.delete(oldest);
        else break;
      }
    }

    onEvent({ kind: 'status', text: `${API_PROVIDER_DEFAULTS[cfg.provider].label} finished` });
    return {
      data,
      rawText: result.rawText,
      conversationId: fullKey || null,
      usage: result.usage,
    };
  }

  async runStructuredPrompt({ prompt, schema, model = '', effort = '', apiConfig = {}, signal, onEvent = () => {} }) {
    return this.runUnifiedTurn({ sessionKey: '', prompt, schema, model, effort, apiConfig, signal, onEvent });
  }

  dispose() {
    this.sessions.clear();
  }
}
