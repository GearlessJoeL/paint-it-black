import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]|\r/g;
const AUTH_ERROR_RE =
  /please sign in|authentication required|oauth-callback|launch the cli without arguments to sign in/i;

const STATUS_CACHE_TTL_MS = 120_000;
const WORKER_IDLE_TTL_MS = 10 * 60_000;
const MAX_CACHED_WORKERS = 4;
const MAX_WORKER_TURNS = 12;

function stripAnsi(text) {
  return String(text || '').replace(ANSI_RE, '');
}

/**
 * Extract a JSON object from raw LLM text (supports raw JSON, fenced ```json blocks, or balanced braces).
 */
export function extractJsonObject(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw;
  }
  const text = String(raw || '').trim();
  if (!text) return null;

  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {
    // continue
  }

  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenceMatch) {
    try {
      const parsed = JSON.parse(fenceMatch[1]);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
      // continue
    }
  }

  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      const parsed = JSON.parse(text.slice(firstBrace, lastBrace + 1));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
      // continue
    }
  }

  return null;
}

/**
 * Parse `agy models` output into selectable model options.
 */
export function parseModelsOutput(raw) {
  const cleaned = stripAnsi(raw);
  const lines = cleaned
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  const models = [];
  const seen = new Set();

  for (const line of lines) {
    if (
      /^[-=+─━│┌┐└┘├┤┬┴┼\s]+$/.test(line) ||
      /^(available models|model|name|id|status|provider)\b/i.test(line) ||
      AUTH_ERROR_RE.test(line)
    ) {
      continue;
    }

    const cleanedLine = line.replace(/^[*•▸▶✓\-\s]+/, '');
    const tokenMatch = cleanedLine.match(/^([a-z0-9][a-z0-9._:/-]{2,})(?:\s+(.*))?$/i);
    if (tokenMatch) {
      const id = tokenMatch[1];
      if (!seen.has(id) && /[a-z]/i.test(id) && !/^https?:/i.test(id)) {
        seen.add(id);
        const extra = tokenMatch[2]?.replace(/\s{2,}/g, ' · ').trim();
        models.push({
          id,
          label: extra ? `${id} (${extra})` : id,
        });
      }
    }
  }

  return models;
}

/**
 * Shared NDJSON line processor for both one-shot `agy --print` and persistent `stream-json` workers.
 */
function handleAgyStreamLine(line, streamName, state, { onEvent, onAuthError }) {
  const cleaned = stripAnsi(line).trim();
  if (!cleaned) return;

  if (AUTH_ERROR_RE.test(cleaned)) {
    const err = new Error(
      'Antigravity CLI is not signed in yet. Open your terminal (or WSL), run `agy`, sign in with your Google AI Pro account, and try again.',
    );
    err.code = 'AUTH_REQUIRED';
    onAuthError(err);
    return;
  }

  if (streamName === 'stderr') {
    onEvent?.({ kind: 'stderr', text: cleaned });
    return;
  }

  let parsed = null;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    onEvent?.({ kind: 'stdout', text: cleaned });
    return;
  }

  if (!parsed || typeof parsed !== 'object') return;

  const eventName = String(parsed.event || parsed.type || '').toLowerCase();

  if (eventName === 'init') {
    if (parsed.conversation_id) state.conversationId = parsed.conversation_id;
    state.initialized = true;
    state.onInit?.(parsed);
    const modelName = parsed.init?.model;
    if (modelName) {
      onEvent?.({ kind: 'status', text: `Antigravity session started (${modelName})` });
    }
    return;
  }

  if (eventName === 'step_update' && parsed.step_update && typeof parsed.step_update === 'object') {
    const step = parsed.step_update;
    if (step.conversation_id) state.conversationId = step.conversation_id;
    if (step.usage) state.usage = step.usage;

    const stepType = String(step.step_type || '').toLowerCase();
    const thoughtDelta = step.thought_delta || step.thinking_delta || step.thought || '';
    if (thoughtDelta) {
      onEvent?.({ kind: 'thought', text: String(thoughtDelta) });
    }

    if (stepType === 'agent_response' && typeof step.text_delta === 'string' && step.text_delta) {
      state.accumulatedText += step.text_delta;
      onEvent?.({ kind: 'delta', text: step.text_delta });
    } else if (stepType && !['user_input', 'unknown', 'agent_response', 'finish', 'system_message'].includes(stepType)) {
      if (step.state === 'ACTIVE' || step.state === 'DONE') {
        onEvent?.({ kind: 'status', text: `Step ${step.step_index ?? ''}: ${stepType} (${step.state})` });
      }
    }
    return;
  }

  if (eventName === 'result' && parsed.result && typeof parsed.result === 'object') {
    const resObj = parsed.result;
    state.finalEnvelope = resObj;
    if (resObj.conversation_id) state.conversationId = resObj.conversation_id;
    if (resObj.usage) state.usage = resObj.usage;
    if (resObj.structured_output !== undefined || resObj.structuredOutput !== undefined) {
      const candidate = resObj.structured_output ?? resObj.structuredOutput;
      state.structuredOutput = extractJsonObject(candidate) || candidate;
    }
    if (typeof resObj.response === 'string' && resObj.response.trim()) {
      state.accumulatedText = resObj.response;
    }
    const durationLabel =
      typeof resObj.duration_seconds === 'number' ? ` in ${resObj.duration_seconds.toFixed(1)}s` : '';
    onEvent?.({
      kind: 'status',
      text: `Antigravity finished (${resObj.status || 'done'}${durationLabel})`,
    });
    state.onTurnResult?.(resObj);
    return;
  }

  // Fallback for generic/older CLI envelopes
  if (parsed.conversation_id || parsed.conversationId) {
    state.conversationId = parsed.conversation_id || parsed.conversationId;
  }
  if (parsed.usage) state.usage = parsed.usage;
  if (parsed.structured_output !== undefined || parsed.structuredOutput !== undefined) {
    const candidate = parsed.structured_output ?? parsed.structuredOutput;
    state.structuredOutput = extractJsonObject(candidate) || candidate;
  }

  if (parsed.error) {
    const msg = typeof parsed.error === 'string' ? parsed.error : parsed.error.message || JSON.stringify(parsed.error);
    if (AUTH_ERROR_RE.test(msg)) {
      const err = new Error(
        'Antigravity CLI is not signed in yet. Run `agy` in your terminal (or WSL) to sign in with your Google AI Pro account.',
      );
      err.code = 'AUTH_REQUIRED';
      onAuthError(err);
      return;
    }
    onEvent?.({ kind: 'warning', text: msg });
  }

  if (eventName.includes('thought') || eventName.includes('thinking') || parsed.thought) {
    const thoughtText = parsed.thought || parsed.delta || parsed.text || '';
    if (thoughtText) onEvent?.({ kind: 'thought', text: String(thoughtText) });
    return;
  }

  if (eventName.includes('tool') || parsed.tool_call || parsed.toolCall) {
    const toolName = parsed.tool_name || parsed.name || parsed.tool_call?.name || parsed.toolCall?.name || 'tool';
    onEvent?.({ kind: 'status', text: `Agent invoked ${toolName}` });
    return;
  }

  if (parsed.status || eventName === 'final' || eventName === 'done') {
    state.finalEnvelope = parsed;
    if (typeof parsed.response === 'string' && parsed.response.trim()) {
      state.accumulatedText = parsed.response;
    }
    onEvent?.({ kind: 'status', text: `Antigravity finished (${parsed.status || 'done'})` });
    state.onTurnResult?.(parsed);
    return;
  }

  const deltaText =
    typeof parsed.text_delta === 'string'
      ? parsed.text_delta
      : typeof parsed.delta === 'string'
        ? parsed.delta
        : typeof parsed.text === 'string'
          ? parsed.text
          : typeof parsed.content === 'string'
            ? parsed.content
            : typeof parsed.message?.content === 'string'
              ? parsed.message.content
              : '';

  if (deltaText) {
    state.accumulatedText += deltaText;
    onEvent?.({ kind: 'delta', text: deltaText });
  }
}

function resolveStructuredFromState(state) {
  return (
    state.structuredOutput ||
    extractJsonObject(state.finalEnvelope?.structured_output) ||
    extractJsonObject(state.finalEnvelope?.structuredOutput) ||
    extractJsonObject(state.finalEnvelope?.response) ||
    (typeof state.finalEnvelope?.result === 'string' ? extractJsonObject(state.finalEnvelope.result) : null) ||
    extractJsonObject(state.accumulatedText)
  );
}

/**
 * Persistent bidirectional `agy --input-format stream-json --output-format stream-json` process.
 * Pre-initializes at spawn (0 AI tokens) and preserves warm KV cache across turns.
 */
export class PersistentAgyWorker {
  constructor({ binaryPath, env, schemaPath, model = '', effort = '', cwd = os.tmpdir(), onAuthInvalidate }) {
    this.binaryPath = binaryPath;
    this.env = env;
    this.schemaPath = schemaPath;
    this.model = model;
    this.effort = effort;
    this.cwd = cwd;
    this.onAuthInvalidate = onAuthInvalidate;

    this.alive = true;
    this.busy = false;
    this.seeded = false;
    this.turnCount = 0;
    this.lastUsedAt = Date.now();
    this.idleTimer = null;

    this.stdoutBuf = '';
    this.stderrBuf = '';
    this.activeTurn = null;

    const args = [
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--disable-slash-commands',
      '--print-timeout',
      '300s',
      '--json-schema',
      schemaPath,
    ];
    if (model) args.push('--model', model);
    if (effort) args.push('--effort', effort);
    args.push('--print=');

    const spawnOpts = {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    };
    if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(binaryPath)) {
      spawnOpts.shell = true;
    }

    this.child = spawn(binaryPath, args, spawnOpts);

    let initResolved = false;
    let resolveInit;
    let rejectInit;
    this.initPromise = new Promise((res, rej) => {
      resolveInit = res;
      rejectInit = rej;
    });
    // Prevent unhandled rejection if pre-warmed spare fails before anyone awaits it
    this.initPromise.catch(() => {});

    this.streamState = {
      initialized: false,
      conversationId: null,
      accumulatedText: '',
      finalEnvelope: null,
      structuredOutput: null,
      usage: null,
      onInit: () => {
        if (!initResolved) {
          initResolved = true;
          resolveInit();
        }
      },
      onTurnResult: (resObj) => {
        this.#finishTurnFromResult(resObj);
      },
    };

    const failAll = (err) => {
      this.alive = false;
      clearTimeout(this.idleTimer);
      if (!initResolved) {
        initResolved = true;
        rejectInit(err);
      }
      if (this.activeTurn) {
        const t = this.activeTurn;
        this.activeTurn = null;
        this.busy = false;
        t.signal?.removeEventListener('abort', t.onAbort);
        t.reject(err);
      }
    };

    this.child.stdout.on('data', (chunk) => {
      this.stdoutBuf += chunk.toString('utf8');
      const lines = this.stdoutBuf.split('\n');
      this.stdoutBuf = lines.pop() ?? '';
      for (const line of lines) {
        handleAgyStreamLine(line, 'stdout', this.streamState, {
          onEvent: (ev) => this.activeTurn?.onEvent?.(ev),
          onAuthError: (err) => {
            this.onAuthInvalidate?.();
            failAll(err);
            this.dispose();
          },
        });
      }
    });

    this.child.stderr.on('data', (chunk) => {
      this.stderrBuf += chunk.toString('utf8');
      const lines = this.stderrBuf.split('\n');
      this.stderrBuf = lines.pop() ?? '';
      for (const line of lines) {
        handleAgyStreamLine(line, 'stderr', this.streamState, {
          onEvent: (ev) => this.activeTurn?.onEvent?.(ev),
          onAuthError: (err) => {
            this.onAuthInvalidate?.();
            failAll(err);
            this.dispose();
          },
        });
      }
    });

    this.child.on('error', (err) => {
      failAll(new Error(`Failed to spawn agy (${binaryPath}): ${err.message}`));
    });

    this.child.on('close', (code) => {
      const stderrTail = stripAnsi(this.stderrBuf).trim().slice(-600);
      failAll(
        new Error(
          stderrTail
            ? `agy worker closed (code ${code}): ${stderrTail}`
            : `agy worker closed unexpectedly (code ${code})`,
        ),
      );
    });

    this.#resetIdleTimer();
  }

  #resetIdleTimer() {
    clearTimeout(this.idleTimer);
    if (!this.alive) return;
    this.idleTimer = setTimeout(() => {
      if (!this.busy) this.dispose();
    }, WORKER_IDLE_TTL_MS);
    this.idleTimer.unref?.();
  }

  #finishTurnFromResult(resObj) {
    const turn = this.activeTurn;
    if (!turn) return;
    this.activeTurn = null;
    this.busy = false;
    this.turnCount += 1;
    this.lastUsedAt = Date.now();
    turn.signal?.removeEventListener('abort', turn.onAbort);
    this.#resetIdleTimer();

    if (resObj?.status === 'ERROR') {
      const msg = resObj.error || resObj.response || 'Antigravity returned an error status.';
      if (AUTH_ERROR_RE.test(msg)) {
        this.onAuthInvalidate?.();
        const err = new Error(msg);
        err.code = 'AUTH_REQUIRED';
        turn.reject(err);
        this.dispose();
        return;
      }
      turn.reject(new Error(msg));
      return;
    }

    const extracted = resolveStructuredFromState(this.streamState);
    if (!extracted) {
      const preview = stripAnsi(this.streamState.accumulatedText).trim().slice(0, 500);
      turn.reject(
        new Error(`Antigravity did not return valid structured JSON. Output preview: ${preview || '(empty)'}`),
      );
      return;
    }

    this.seeded = true;
    turn.resolve({
      data: extracted,
      rawText: this.streamState.accumulatedText,
      conversationId: this.streamState.conversationId,
      usage: this.streamState.usage,
    });
  }

  async runTurn(prompt, { signal, onEvent } = {}) {
    if (!this.alive) {
      throw new Error('agy worker is no longer alive');
    }
    if (this.busy) {
      throw new Error('agy worker is already busy');
    }

    await this.initPromise;
    if (!this.alive) {
      throw new Error('agy worker exited during init');
    }

    if (signal?.aborted) {
      const err = new Error('Generation cancelled by user');
      err.code = 'ABORTED';
      throw err;
    }

    this.busy = true;
    clearTimeout(this.idleTimer);

    // Reset per-turn collectors (preserve conversationId)
    this.streamState.accumulatedText = '';
    this.streamState.finalEnvelope = null;
    this.streamState.structuredOutput = null;
    this.streamState.usage = null;

    return new Promise((resolve, reject) => {
      const onAbort = () => {
        if (this.activeTurn?.reject !== reject) return;
        this.activeTurn = null;
        this.busy = false;
        const err = new Error('Generation cancelled by user');
        err.code = 'ABORTED';
        this.dispose();
        reject(err);
      };

      this.activeTurn = { resolve, reject, onEvent, signal, onAbort };
      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true });
      }

      const payloadLine = JSON.stringify({ event: 'user', message: { content: prompt } }) + '\n';
      this.child.stdin.write(payloadLine, 'utf8', (writeErr) => {
        if (writeErr && this.activeTurn?.reject === reject) {
          this.activeTurn = null;
          this.busy = false;
          signal?.removeEventListener('abort', onAbort);
          this.dispose();
          reject(writeErr);
        }
      });
    });
  }

  dispose() {
    this.alive = false;
    clearTimeout(this.idleTimer);
    try {
      this.child.stdin?.end();
    } catch {
      // ignore
    }
    try {
      this.child.kill('SIGTERM');
      const ref = this.child;
      setTimeout(() => {
        try {
          ref.kill('SIGKILL');
        } catch {
          // already exited
        }
      }, 1200).unref?.();
    } catch {
      // ignore
    }
  }
}

export class AntigravityCliAdapter {
  constructor({ binaryPath, env }) {
    this.id = 'antigravity';
    this.label = 'Antigravity CLI (agy)';
    this.description = 'Runs local Antigravity CLI using your signed-in Google AI Pro account.';
    this.binaryPath = binaryPath;
    this.env = env;

    this.statusCache = null;
    this.statusCachedAt = 0;
    this.statusInFlight = null;

    this.schemaDirPromise = null;
    this.schemaFiles = new Map();
    this.spareWorkers = new Map();
    this.sessionWorkers = new Map();
  }

  invalidateStatusCache() {
    this.statusCache = null;
    this.statusCachedAt = 0;
  }

  async checkStatus({ forceRefresh = false } = {}) {
    if (
      !forceRefresh &&
      this.statusCache &&
      this.statusCache.authenticated &&
      Date.now() - this.statusCachedAt < STATUS_CACHE_TTL_MS
    ) {
      return this.statusCache;
    }

    if (this.statusInFlight && !forceRefresh) {
      return this.statusInFlight;
    }

    this.statusInFlight = this.#probeModelsStatus().finally(() => {
      this.statusInFlight = null;
    });
    return this.statusInFlight;
  }

  async #probeModelsStatus() {
    try {
      await fs.access(this.binaryPath, fs.constants.X_OK);
    } catch {
      return {
        id: this.id,
        label: this.label,
        description: this.description,
        installed: false,
        authenticated: false,
        binaryPath: this.binaryPath,
        models: [],
        message: `Antigravity CLI not found at ${this.binaryPath}. Install agy or set AGY_BIN.`,
      };
    }

    return new Promise((resolve) => {
      const spawnOpts = {
        env: this.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      };
      if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(this.binaryPath)) {
        spawnOpts.shell = true;
      }
      const child = spawn(this.binaryPath, ['models'], spawnOpts);

      let stdout = '';
      let stderr = '';
      let settled = false;

      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (result.authenticated) {
          this.statusCache = result;
          this.statusCachedAt = Date.now();
        }
        resolve(result);
      };

      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 1000).unref();
        finish({
          id: this.id,
          label: this.label,
          description: this.description,
          installed: true,
          authenticated: false,
          binaryPath: this.binaryPath,
          models: [],
          message: 'Timed out checking Antigravity CLI auth status. Run `agy` in terminal to verify sign-in.',
        });
      }, 6000);

      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString('utf8');
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString('utf8');
      });

      child.on('error', (err) => {
        finish({
          id: this.id,
          label: this.label,
          description: this.description,
          installed: false,
          authenticated: false,
          binaryPath: this.binaryPath,
          models: [],
          message: `Failed to execute agy: ${err.message}`,
        });
      });

      child.on('close', (code) => {
        const combined = stripAnsi(`${stdout}\n${stderr}`).trim();
        if (AUTH_ERROR_RE.test(combined)) {
          finish({
            id: this.id,
            label: this.label,
            description: this.description,
            installed: true,
            authenticated: false,
            binaryPath: this.binaryPath,
            models: [],
            message:
              'Antigravity CLI needs a one-time sign-in. Open your terminal (or WSL on Windows), run `agy`, complete Google AI Pro sign-in, then click Retry.',
          });
          return;
        }

        const models = parseModelsOutput(stdout);
        finish({
          id: this.id,
          label: this.label,
          description: this.description,
          installed: true,
          authenticated: code === 0,
          binaryPath: this.binaryPath,
          models,
          message:
            code === 0
              ? `Ready (${models.length || 'default'} model${models.length === 1 ? '' : 's'} available)`
              : combined || `agy models exited with code ${code}`,
        });
      });
    });
  }

  resolveModelAndEffort({ model = '', effort = '' } = {}) {
    if (model === 'cli-default') {
      return { modelArg: '', effortArg: effort || '' };
    }
    if (model) {
      return { modelArg: model, effortArg: effort || 'low' };
    }
    const availableIds = new Set((this.statusCache?.models || []).map((m) => m.id));
    let fastModel = '';
    for (const candidate of ['gemini-3.8-flash-low', 'gemini-3.8-flash-medium', 'gemini-4-argon-low']) {
      if (availableIds.has(candidate)) {
        fastModel = candidate;
        break;
      }
    }
    return {
      modelArg: fastModel,
      effortArg: effort || 'low',
    };
  }

  async #getSchemaPath(schema) {
    if (!this.schemaDirPromise) {
      this.schemaDirPromise = fs.mkdtemp(path.join(os.tmpdir(), 'resume-tailor-schemas-'));
    }
    const dir = await this.schemaDirPromise;
    const raw = JSON.stringify(schema);
    if (this.schemaFiles.has(raw)) {
      return this.schemaFiles.get(raw);
    }
    const filePath = path.join(dir, `schema-${this.schemaFiles.size + 1}.json`);
    await fs.writeFile(filePath, JSON.stringify(schema, null, 2), 'utf8');
    this.schemaFiles.set(raw, filePath);
    return filePath;
  }

  isSessionSeeded(sessionKey, { model = '', effort = '' } = {}) {
    if (!sessionKey) return false;
    const { modelArg, effortArg } = this.resolveModelAndEffort({ model, effort });
    const key = `${sessionKey}::${modelArg}::${effortArg}`;
    const worker = this.sessionWorkers.get(key);
    return Boolean(worker && worker.alive && !worker.busy && worker.seeded && worker.turnCount < MAX_WORKER_TURNS);
  }

  async #spawnSpareWorker({ schemaPath, modelArg, effortArg }) {
    const configKey = `${schemaPath}::${modelArg}::${effortArg}`;
    const existing = this.spareWorkers.get(configKey);
    if (existing && existing.alive && !existing.busy) {
      return existing;
    }

    const worker = new PersistentAgyWorker({
      binaryPath: this.binaryPath,
      env: this.env,
      schemaPath,
      model: modelArg,
      effort: effortArg,
      cwd: os.tmpdir(),
      onAuthInvalidate: () => this.invalidateStatusCache(),
    });
    this.spareWorkers.set(configKey, worker);
    return worker;
  }

  /**
   * Zero-token warmup: caches `agy models` and pre-initializes one background `stream-json`
   * process so Turn 1 skips CLI cold startup (~2.5s).
   */
  async prewarm({ schema, model = '', effort = '' } = {}) {
    try {
      const status = await this.checkStatus();
      if (!status?.installed || !status?.authenticated || !schema) return { ok: false };
      const schemaPath = await this.#getSchemaPath(schema);
      const { modelArg, effortArg } = this.resolveModelAndEffort({ model, effort });
      const spare = await this.#spawnSpareWorker({ schemaPath, modelArg, effortArg });
      await spare.initPromise.catch(() => {});
      return { ok: true };
    } catch {
      return { ok: false };
    }
  }

  #evictExcessSessionWorkers() {
    while (this.sessionWorkers.size > MAX_CACHED_WORKERS) {
      let oldestKey = null;
      let oldestTime = Infinity;
      for (const [k, w] of this.sessionWorkers.entries()) {
        if (!w.busy && w.lastUsedAt < oldestTime) {
          oldestTime = w.lastUsedAt;
          oldestKey = k;
        }
      }
      if (!oldestKey) break;
      const victim = this.sessionWorkers.get(oldestKey);
      this.sessionWorkers.delete(oldestKey);
      victim?.dispose();
    }
  }

  /**
   * Execute a turn on a pre-initialized / per-job persistent `stream-json` worker.
   * Reuses the same live `agy` process & KV cache across tailor -> repair -> chat turns.
   */
  async runUnifiedTurn({ sessionKey = '', prompt, schema, model = '', effort = '', signal, onEvent = () => {} }) {
    // Ensure model table is populated before resolving Auto-Fast model ID
    await this.checkStatus().catch(() => null);
    const schemaPath = await this.#getSchemaPath(schema);
    const { modelArg, effortArg } = this.resolveModelAndEffort({ model, effort });
    const configKey = `${schemaPath}::${modelArg}::${effortArg}`;
    const fullSessionKey = sessionKey ? `${sessionKey}::${modelArg}::${effortArg}` : '';

    let worker = fullSessionKey ? this.sessionWorkers.get(fullSessionKey) : null;
    if (worker && (!worker.alive || worker.busy || worker.turnCount >= MAX_WORKER_TURNS)) {
      if (!worker.busy) worker.dispose();
      this.sessionWorkers.delete(fullSessionKey);
      worker = null;
    }

    if (!worker) {
      const spare = this.spareWorkers.get(configKey);
      if (spare && spare.alive && !spare.busy) {
        this.spareWorkers.delete(configKey);
        worker = spare;
      } else {
        worker = new PersistentAgyWorker({
          binaryPath: this.binaryPath,
          env: this.env,
          schemaPath,
          model: modelArg,
          effort: effortArg,
          cwd: os.tmpdir(),
          onAuthInvalidate: () => this.invalidateStatusCache(),
        });
      }

      // Replenish pre-initialized zero-token spare in background for next request
      this.#spawnSpareWorker({ schemaPath, modelArg, effortArg }).catch(() => {});
    }

    try {
      const res = await worker.runTurn(prompt, { signal, onEvent });
      if (fullSessionKey && worker.alive) {
        this.sessionWorkers.set(fullSessionKey, worker);
        this.#evictExcessSessionWorkers();
      } else {
        worker.dispose();
      }
      return res;
    } catch (err) {
      if (fullSessionKey && this.sessionWorkers.get(fullSessionKey) === worker) {
        this.sessionWorkers.delete(fullSessionKey);
      }
      worker.dispose();
      throw err;
    }
  }

  /**
   * One-shot `agy --print` fallback (used by direct tests or explicit conversationId calls).
   */
  async runStructuredPrompt({
    prompt,
    schema,
    model = '',
    effort = '',
    cwd = os.tmpdir(),
    conversationId = '',
    signal,
    onEvent = () => {},
  }) {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'resume-tailor-agy-'));
    const schemaPath = path.join(tmpDir, 'schema.json');
    await fs.writeFile(schemaPath, JSON.stringify(schema, null, 2), 'utf8');

    const { modelArg, effortArg } = model || effort ? this.resolveModelAndEffort({ model, effort }) : { modelArg: '', effortArg: '' };

    const args = [
      '--output-format',
      'stream-json',
      '--disable-slash-commands',
      '--print-timeout',
      '300s',
      '--json-schema',
      schemaPath,
    ];

    if (modelArg) args.push('--model', modelArg);
    if (effortArg) args.push('--effort', effortArg);
    if (conversationId) args.push('--conversation', conversationId);
    args.push(`--print=${prompt}`);

    try {
      return await this.#spawnAndCollect({ args, cwd, signal, onEvent });
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  #spawnAndCollect({ args, cwd, signal, onEvent }) {
    return new Promise((resolve, reject) => {
      const spawnOpts = {
        cwd,
        env: this.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      };
      if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(this.binaryPath)) {
        spawnOpts.shell = true;
      }
      const child = spawn(this.binaryPath, args, spawnOpts);

      let stdoutBuf = '';
      let stderrBuf = '';
      let rawStdout = '';
      let rawStderr = '';
      let settled = false;

      const streamState = {
        initialized: false,
        conversationId: null,
        accumulatedText: '',
        finalEnvelope: null,
        structuredOutput: null,
        usage: null,
      };

      const fail = (err) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 1500).unref();
        reject(err);
      };

      const onAbort = () => {
        const err = new Error('Generation cancelled by user');
        err.code = 'ABORTED';
        fail(err);
      };

      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }

      const handleLine = (line, streamName) => {
        handleAgyStreamLine(line, streamName, streamState, {
          onEvent,
          onAuthError: (err) => {
            this.invalidateStatusCache();
            fail(err);
          },
        });
      };

      child.stdout.on('data', (chunk) => {
        const str = chunk.toString('utf8');
        rawStdout += str;
        stdoutBuf += str;
        const lines = stdoutBuf.split('\n');
        stdoutBuf = lines.pop() ?? '';
        for (const line of lines) handleLine(line, 'stdout');
      });

      child.stderr.on('data', (chunk) => {
        const str = chunk.toString('utf8');
        rawStderr += str;
        stderrBuf += str;
        const lines = stderrBuf.split('\n');
        stderrBuf = lines.pop() ?? '';
        for (const line of lines) handleLine(line, 'stderr');
      });

      child.on('error', (err) => {
        fail(new Error(`Failed to spawn agy (${this.binaryPath}): ${err.message}`));
      });

      child.on('close', (code) => {
        if (settled) return;
        if (stdoutBuf.trim()) handleLine(stdoutBuf, 'stdout');
        if (stderrBuf.trim()) handleLine(stderrBuf, 'stderr');
        if (settled) return;

        settled = true;
        signal?.removeEventListener('abort', onAbort);

        const combined = stripAnsi(`${rawStdout}\n${rawStderr}`);
        if (AUTH_ERROR_RE.test(combined)) {
          this.invalidateStatusCache();
          const err = new Error(
            'Antigravity CLI is not signed in yet. Open your terminal (or WSL), run `agy`, sign in with your Google AI Pro account, and try again.',
          );
          err.code = 'AUTH_REQUIRED';
          reject(err);
          return;
        }

        const extracted = resolveStructuredFromState(streamState);
        if (code !== 0 && !extracted) {
          const detail = stripAnsi(rawStderr || rawStdout).trim().slice(-1000);
          reject(new Error(`agy exited with code ${code}: ${detail || 'Unknown error'}`));
          return;
        }

        if (!extracted) {
          const preview = stripAnsi(streamState.accumulatedText || rawStdout || rawStderr).trim().slice(0, 600);
          reject(
            new Error(
              `Antigravity did not return valid structured JSON. Output preview: ${preview || '(empty)'}`,
            ),
          );
          return;
        }

        resolve({
          data: extracted,
          rawText: streamState.accumulatedText || rawStdout,
          conversationId: streamState.conversationId,
          usage: streamState.usage,
        });
      });
    });
  }

  dispose() {
    for (const w of this.spareWorkers.values()) w.dispose();
    this.spareWorkers.clear();
    for (const w of this.sessionWorkers.values()) w.dispose();
    this.sessionWorkers.clear();
    if (this.schemaDirPromise) {
      this.schemaDirPromise
        .then((dir) => fs.rm(dir, { recursive: true, force: true }))
        .catch(() => {});
      this.schemaDirPromise = null;
    }
  }
}
