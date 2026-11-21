import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import { extractJsonObject } from './antigravity.mjs';
import { discoverClaudeModels } from './claude-models.mjs';

const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]|\r/g;
const AUTH_ERROR_RE =
  /not logged in|please log\s*in|claude login|authentication required|invalid api key|oauth|unauthorized/i;
const STATUS_CACHE_TTL_MS = 120_000;
const MAX_SESSIONS = 8;

function stripAnsi(text) {
  return String(text || '').replace(ANSI_RE, '');
}

export class ClaudeCodeCliAdapter {
  constructor({ binaryPath, env, modelDiscoveryTimeoutMs = 10_000 }) {
    this.id = 'claude';
    this.label = 'Claude Code CLI (claude)';
    this.description = 'Runs local Claude Code CLI (`claude -p`) using your Claude subscription or ANTHROPIC_API_KEY.';
    this.binaryPath = binaryPath;
    this.env = env;
    this.modelDiscoveryTimeoutMs = modelDiscoveryTimeoutMs;

    this.statusCache = null;
    this.statusCachedAt = 0;
    this.statusInFlight = null;
    this.statusGeneration = 0;
    this.statusProbeCancels = new Set();
    this.sessionIds = new Map();
  }

  invalidateStatusCache() {
    this.statusGeneration += 1;
    this.statusCache = null;
    this.statusCachedAt = 0;
    this.statusInFlight = null;
  }

  async checkStatus({ forceRefresh = false } = {}) {
    if (this.statusInFlight) {
      return this.statusInFlight;
    }
    if (
      !forceRefresh &&
      this.statusCache &&
      this.statusCache.installed &&
      Date.now() - this.statusCachedAt < STATUS_CACHE_TTL_MS
    ) {
      return this.statusCache;
    }
    const generation = this.statusGeneration;
    const pending = this.#probeStatus(generation).then((result) => {
      if (generation === this.statusGeneration && result.installed) {
        this.statusCache = result;
        this.statusCachedAt = Date.now();
      }
      return result;
    }).finally(() => {
      if (this.statusInFlight === pending) this.statusInFlight = null;
    });
    this.statusInFlight = pending;
    return pending;
  }

  async #probeStatus(generation) {
    const status = await this.#probeVersion();
    if (!status.installed || !status.authenticated || generation !== this.statusGeneration) return status;
    try {
      const models = await discoverClaudeModels({
        binaryPath: this.binaryPath,
        env: this.env,
        timeoutMs: this.modelDiscoveryTimeoutMs,
        onCancel: (cancel) => {
          this.statusProbeCancels.add(cancel);
          return () => this.statusProbeCancels.delete(cancel);
        },
      });
      return { ...status, models, modelsSource: 'live', modelsDiscoveredAt: new Date().toISOString() };
    } catch (error) {
      return {
        ...status, models: [], modelsSource: 'unavailable', modelDiscoveryError: error.message,
        authenticated: AUTH_ERROR_RE.test(error.message) ? false : status.authenticated,
        message: `${status.message}. ${error.message}`,
      };
    }
  }

  async #probeVersion() {
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
        modelsSource: 'unavailable',
        modelDiscoveryError: 'Claude Code CLI is not installed.',
        message: 'Claude Code CLI not found. Install it (`npm i -g @anthropic-ai/claude-code`) or set CLAUDE_BIN.',
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
      const child = spawn(this.binaryPath, ['--version'], spawnOpts);

      let stdout = '';
      let stderr = '';
      let settled = false;

      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
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
          modelsSource: 'unavailable',
          modelDiscoveryError: 'Timed out probing `claude --version`.',
          message: 'Timed out probing `claude --version`.',
        });
      }, 5000);

      child.stdout.on('data', (c) => {
        stdout += c.toString('utf8');
      });
      child.stderr.on('data', (c) => {
        stderr += c.toString('utf8');
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
          modelsSource: 'unavailable',
          modelDiscoveryError: 'Could not start Claude Code CLI.',
          message: `Failed to run claude: ${err.message}`,
        });
      });
      child.on('close', (code) => {
        const version = stripAnsi(stdout || stderr).split('\n')[0]?.trim() || '';
        finish({
          id: this.id,
          label: this.label,
          description: this.description,
          installed: code === 0,
          authenticated: code === 0,
          binaryPath: this.binaryPath,
          models: [],
          modelsSource: 'unavailable',
          modelDiscoveryError: code === 0 ? undefined : 'Claude Code version probe failed.',
          message: code === 0 ? `Ready (${version || 'claude'})` : version || `claude exited with code ${code}`,
        });
      });
    });
  }

  #resolveModelAndEffort({ model = '', effort = '' } = {}) {
    return {
      modelArg: model === 'cli-default' ? '' : model || '',
      effortArg: effort || '',
    };
  }

  isSessionSeeded(sessionKey, { model = '', effort = '' } = {}) {
    if (!sessionKey) return false;
    const { modelArg, effortArg } = this.#resolveModelAndEffort({ model, effort });
    return this.sessionIds.has(`${sessionKey}::${modelArg}::${effortArg}`);
  }

  async runUnifiedTurn({ sessionKey = '', prompt, schema, model = '', effort = '', signal, onEvent = () => {} }) {
    const { modelArg, effortArg } = this.#resolveModelAndEffort({ model, effort });
    const mapKey = sessionKey ? `${sessionKey}::${modelArg}::${effortArg}` : '';
    const resumeId = mapKey ? this.sessionIds.get(mapKey) || '' : '';

    const res = await this.runStructuredPrompt({
      prompt,
      schema,
      model: modelArg,
      effort: effortArg,
      conversationId: resumeId,
      signal,
      onEvent,
    });

    if (mapKey && res.conversationId) {
      this.sessionIds.set(mapKey, res.conversationId);
      while (this.sessionIds.size > MAX_SESSIONS) {
        const oldest = this.sessionIds.keys().next().value;
        if (oldest) this.sessionIds.delete(oldest);
        else break;
      }
    }
    return res;
  }

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
    const args = [
      '-p',
      '--output-format',
      'json',
      '--permission-mode',
      'dontAsk',
      '--tools',
      '',
      '--json-schema',
      JSON.stringify(schema),
    ];

    if (model && model !== 'cli-default') args.push('--model', model);
    if (effort) args.push('--effort', effort);
    if (conversationId) args.push('--resume', conversationId);

    onEvent({ kind: 'status', text: `Running Claude Code (${model || 'default'})…` });

    return new Promise((resolve, reject) => {
      const spawnOpts = {
        cwd: cwd || os.tmpdir(),
        env: this.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      };
      if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(this.binaryPath)) {
        spawnOpts.shell = true;
      }
      const child = spawn(this.binaryPath, args, spawnOpts);

      let stdout = '';
      let stderr = '';
      let settled = false;

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

      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString('utf8');
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString('utf8');
      });
      child.on('error', (err) => {
        fail(new Error(`Failed to spawn claude (${this.binaryPath}): ${err.message}`));
      });

      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);

        const combined = stripAnsi(`${stdout}\n${stderr}`).trim();
        if (AUTH_ERROR_RE.test(combined)) {
          this.invalidateStatusCache();
          const err = new Error(
            'Claude Code CLI is not signed in. Run `claude login` in your terminal (or set ANTHROPIC_API_KEY) and try again.',
          );
          err.code = 'AUTH_REQUIRED';
          reject(err);
          return;
        }

        const envelope = extractJsonObject(stdout);
        if (envelope?.is_error) {
          const msg = String(envelope.result || envelope.error || 'Claude Code returned an error.');
          if (AUTH_ERROR_RE.test(msg)) {
            const err = new Error(msg);
            err.code = 'AUTH_REQUIRED';
            reject(err);
            return;
          }
          reject(new Error(msg));
          return;
        }

        const data =
          (envelope?.structured_output && typeof envelope.structured_output === 'object'
            ? envelope.structured_output
            : null) ||
          extractJsonObject(envelope?.result) ||
          (envelope && !('result' in envelope) && !('session_id' in envelope) ? envelope : null);

        if (code !== 0 && !data) {
          const detail = stripAnsi(stderr || stdout).trim().slice(-800);
          reject(new Error(`claude exited with code ${code}: ${detail || 'Unknown error'}`));
          return;
        }

        if (!data) {
          const preview = stripAnsi(stdout || stderr).trim().slice(0, 500);
          reject(new Error(`Claude Code did not return valid structured JSON. Output: ${preview || '(empty)'}`));
          return;
        }

        onEvent({ kind: 'status', text: 'Claude Code finished' });
        resolve({
          data,
          rawText: typeof envelope?.result === 'string' ? envelope.result : stdout,
          conversationId: envelope?.session_id || conversationId || null,
          usage: envelope?.usage || null,
        });
      });

      child.stdin.end(String(prompt || ''), 'utf8');
    });
  }

  dispose() {
    for (const cancel of this.statusProbeCancels) cancel();
    this.invalidateStatusCache();
    this.sessionIds.clear();
  }
}
