import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { extractJsonObject } from './antigravity.mjs';

const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]|\r/g;
const AUTH_ERROR_RE =
  /not logged in|codex login|authentication required|invalid api key|unauthorized|missing api key|please sign in/i;
const STATUS_CACHE_TTL_MS = 120_000;

const DEFAULT_CODEX_MODELS = [
  { id: 'gpt-5.4', label: 'gpt-5.4 (GPT-5.4)' },
  { id: 'gpt-5.3-codex', label: 'gpt-5.3-codex (Codex)' },
  { id: 'gpt-5-codex-mini', label: 'gpt-5-codex-mini (Fastest)' },
  { id: 'o4-mini', label: 'o4-mini (Fast reasoning)' },
];

function stripAnsi(text) {
  return String(text || '').replace(ANSI_RE, '');
}

/**
 * OpenAI / Codex strict structured outputs require `additionalProperties: false`
 * AND every property key listed in `required` on every object schema node.
 */
export function toStrictOpenAiSchema(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return schema;
  }
  const clone = { ...schema };
  if (clone.type === 'object' && clone.properties && typeof clone.properties === 'object') {
    const nextProps = {};
    for (const [k, v] of Object.entries(clone.properties)) {
      nextProps[k] = toStrictOpenAiSchema(v);
    }
    clone.properties = nextProps;
    clone.additionalProperties = false;
    clone.required = Object.keys(nextProps);
  } else if (clone.type === 'array' && clone.items) {
    clone.items = toStrictOpenAiSchema(clone.items);
  }
  return clone;
}

export class CodexCliAdapter {
  constructor({ binaryPath, env }) {
    this.id = 'codex';
    this.label = 'Codex CLI (codex)';
    this.description = 'Runs local OpenAI Codex CLI (`codex exec`) using your ChatGPT/Codex login or OPENAI_API_KEY.';
    this.binaryPath = binaryPath;
    this.env = env;

    this.statusCache = null;
    this.statusCachedAt = 0;
    this.statusInFlight = null;
  }

  invalidateStatusCache() {
    this.statusCache = null;
    this.statusCachedAt = 0;
  }

  async checkStatus({ forceRefresh = false } = {}) {
    if (
      !forceRefresh &&
      this.statusCache &&
      this.statusCache.installed &&
      Date.now() - this.statusCachedAt < STATUS_CACHE_TTL_MS
    ) {
      return this.statusCache;
    }
    if (this.statusInFlight && !forceRefresh) {
      return this.statusInFlight;
    }
    this.statusInFlight = this.#probeVersion().finally(() => {
      this.statusInFlight = null;
    });
    return this.statusInFlight;
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
        models: DEFAULT_CODEX_MODELS,
        message: 'Codex CLI not found. Install it (`npm i -g @openai/codex`) or set CODEX_BIN.',
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
        if (result.installed) {
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
          models: DEFAULT_CODEX_MODELS,
          message: 'Timed out probing `codex --version`.',
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
          models: DEFAULT_CODEX_MODELS,
          message: `Failed to run codex: ${err.message}`,
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
          models: DEFAULT_CODEX_MODELS,
          message: code === 0 ? `Ready (${version || 'codex'})` : version || `codex exited with code ${code}`,
        });
      });
    });
  }

  async runStructuredPrompt({
    prompt,
    schema,
    model = '',
    effort = '',
    cwd = os.tmpdir(),
    signal,
    onEvent = () => {},
  }) {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'resume-tailor-codex-'));
    const schemaPath = path.join(tmpDir, 'schema.json');
    const outPath = path.join(tmpDir, 'last-message.json');

    await fs.writeFile(schemaPath, JSON.stringify(toStrictOpenAiSchema(schema), null, 2), 'utf8');

    const args = [
      'exec',
      '--skip-git-repo-check',
      '--sandbox',
      'read-only',
      '--output-schema',
      schemaPath,
      '-o',
      outPath,
    ];

    if (model && model !== 'cli-default') {
      args.push('--model', model);
    }
    const effortVal = effort || (model === 'cli-default' ? '' : 'low');
    if (effortVal) {
      args.push('-c', `model_reasoning_effort="${effortVal}"`);
    }
    args.push('-'); // Read prompt from stdin

    onEvent({ kind: 'status', text: `Running Codex CLI (${model || 'default'})…` });

    try {
      return await new Promise((resolve, reject) => {
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
          fail(new Error(`Failed to spawn codex (${this.binaryPath}): ${err.message}`));
        });

        child.on('close', async (code) => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener('abort', onAbort);

          const combined = stripAnsi(`${stdout}\n${stderr}`).trim();
          if (AUTH_ERROR_RE.test(combined)) {
            this.invalidateStatusCache();
            const err = new Error(
              'Codex CLI is not signed in. Run `codex login` in your terminal (or set OPENAI_API_KEY) and try again.',
            );
            err.code = 'AUTH_REQUIRED';
            reject(err);
            return;
          }

          const fileOut = await fs.readFile(outPath, 'utf8').catch(() => '');
          const data = extractJsonObject(fileOut) || extractJsonObject(stdout);

          if (code !== 0 && !data) {
            const detail = stripAnsi(stderr || stdout).trim().slice(-800);
            reject(new Error(`codex exited with code ${code}: ${detail || 'Unknown error'}`));
            return;
          }

          if (!data) {
            const preview = stripAnsi(fileOut || stdout || stderr).trim().slice(0, 500);
            reject(new Error(`Codex CLI did not return valid structured JSON. Output: ${preview || '(empty)'}`));
            return;
          }

          onEvent({ kind: 'status', text: 'Codex CLI finished' });
          resolve({
            data,
            rawText: fileOut || stdout,
            conversationId: null,
            usage: null,
          });
        });

        child.stdin.end(String(prompt || ''), 'utf8');
      });
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
