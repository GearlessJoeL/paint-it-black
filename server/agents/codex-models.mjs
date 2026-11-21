import { spawn } from 'node:child_process';
import os from 'node:os';

function safeErrorDetail(value) {
  return String(value || '')
    .replace(/\bBearer\s+[^\s"',;]+/gi, 'Bearer [redacted]')
    .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{8,}/g, '[redacted]')
    .replace(/\beyJ[A-Za-z0-9._-]{20,}/g, '[redacted]')
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|authorization)\s*[=:]\s*["']?)[^\s"',;]+/gi, '$1[redacted]')
    .trim().slice(0, 500);
}

export function normalizeCodexModels(entries) {
  const models = new Map();
  for (const entry of entries) {
    if (!entry || entry.hidden === true) continue;
    const id = String(entry.model || entry.id || '').trim();
    if (!id || models.has(id)) continue;
    const name = String(entry.displayName || id).trim();
    const efforts = [...new Set((entry.supportedReasoningEfforts || [])
      .map((option) => typeof option === 'string' ? option : option?.reasoningEffort)
      .filter((effort) => typeof effort === 'string' && effort.length > 0))];
    models.set(id, {
      id,
      label: name === id ? id : `${name} (${id})`,
      efforts,
      defaultEffort: entry.defaultReasoningEffort || '',
      isDefault: entry.isDefault === true,
      description: typeof entry.description === 'string' ? entry.description : '',
    });
  }
  return [...models.values()];
}

/** Query metadata only. No threads, turns, user prompts, or inference requests. */
export function discoverCodexModels({ binaryPath, env, timeoutMs = 10_000, maxOutputBytes = 2 * 1024 * 1024 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(binaryPath, ['app-server'], {
      cwd: os.tmpdir(),
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(process.platform === 'win32' && /\.(cmd|bat)$/i.test(binaryPath) ? { shell: true } : {}),
    });
    let buffer = '';
    let bytes = 0;
    let stderr = '';
    let nextId = 1;
    let pendingId;
    let method;
    let outcome;
    let finalized = false;
    let terminateTimer;
    let killTimer;
    const entries = [];
    const cursors = new Set();
    let pages = 0;

    const finalize = () => {
      if (finalized || !outcome) return;
      finalized = true;
      clearTimeout(timeout);
      clearTimeout(terminateTimer);
      clearTimeout(killTimer);
      if (outcome.error) reject(outcome.error);
      else resolve(outcome.models);
    };
    const finish = (error, models) => {
      if (outcome) return;
      outcome = { error, models };
      clearTimeout(timeout);
      // EOF is the stdio app-server's normal shutdown signal. Escalate only if
      // it fails to exit, and bound cleanup as well as the metadata request.
      child.stdin.end();
      if (error) child.kill('SIGTERM');
      terminateTimer = setTimeout(() => child.kill('SIGTERM'), 250);
      killTimer = setTimeout(() => {
        child.kill('SIGKILL');
        finalize();
      }, 1250);
    };
    const send = (message) => {
      if (outcome) return;
      child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (error) finish(new Error(`Codex model discovery stdin failed: ${safeErrorDetail(error.message)}`));
      });
    };
    const request = (name, params) => {
      method = name;
      pendingId = nextId++;
      send({ id: pendingId, method: name, params });
    };
    const requestPage = (cursor) => {
      pages += 1;
      if (pages > 50) {
        finish(new Error('Codex model discovery exceeded the pagination limit.'));
        return;
      }
      request('model/list', { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) });
    };
    const consumeLine = (line) => {
      if (outcome || !line.trim()) return;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        finish(new Error('Codex app-server returned malformed JSON during model discovery.'));
        return;
      }
      // App-server can emit notifications while servicing the catalog request.
      if (!message || typeof message !== 'object' || message.id !== pendingId) return;
      if (message.error) {
        const detail = safeErrorDetail(message.error.message || 'Protocol error');
        finish(new Error(`Codex ${method} failed (${message.error.code ?? 'unknown'}): ${detail}`));
        return;
      }
      if (!message.result || typeof message.result !== 'object') {
        finish(new Error(`Codex ${method} returned an invalid result.`));
        return;
      }
      if (method === 'initialize') {
        send({ method: 'initialized', params: {} });
        requestPage();
        return;
      }
      const { data, nextCursor } = message.result;
      if (!Array.isArray(data)) {
        finish(new Error('Codex model/list returned an invalid model catalog.'));
        return;
      }
      entries.push(...data);
      if (nextCursor == null || nextCursor === '') {
        try {
          finish(null, normalizeCodexModels(entries));
        } catch {
          finish(new Error('Codex model/list returned invalid model metadata.'));
        }
      } else if (typeof nextCursor !== 'string' || cursors.has(nextCursor)) {
        finish(new Error('Codex model/list returned an invalid or repeated pagination cursor.'));
      } else {
        cursors.add(nextCursor);
        requestPage(nextCursor);
      }
    };
    const timeout = setTimeout(() => {
      finish(new Error(`Timed out loading Codex models after ${timeoutMs}ms.`));
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (outcome) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > maxOutputBytes) {
        finish(new Error('Codex model discovery exceeded its output limit.'));
        return;
      }
      buffer += chunk;
      let newline;
      while (!outcome && (newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        consumeLine(line);
      }
    });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(0, 2000); });
    child.stdin.on('error', (error) => {
      if (!outcome) finish(new Error(`Codex model discovery stdin failed: ${safeErrorDetail(error.message)}`));
    });
    child.on('error', (error) => {
      finish(new Error(`Could not start Codex app-server: ${safeErrorDetail(error.message)}`));
      if (!child.pid) finalize();
    });
    child.on('close', (code) => {
      if (!outcome && buffer.trim()) consumeLine(buffer);
      if (!outcome) {
        const detail = safeErrorDetail(stderr);
        finish(new Error(`Codex app-server exited before returning models (code ${code})${detail ? `: ${detail}` : '.'}`));
      }
      finalize();
    });
    request('initialize', {
      clientInfo: { name: 'resume_tailor_models', title: 'Resume Tailor model discovery', version: '1.0.0' },
    });
  });
}
