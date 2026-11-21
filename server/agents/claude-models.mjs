import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import os from 'node:os';

const MAX_OUTPUT_BYTES = 1024 * 1024;

// ModelInfo is the Agent SDK's supportedModels()/initializationResult() shape:
// https://code.claude.com/docs/en/agent-sdk/typescript#modelinfo
export function normalizeClaudeModels(entries) {
  if (!Array.isArray(entries)) throw new Error('Claude Code returned no model list.');
  const seen = new Set();
  const models = [];
  for (const entry of entries) {
    const id = typeof entry?.value === 'string' ? entry.value.trim() : '';
    if (!id || id.length > 512 || seen.has(id)) continue;
    seen.add(id);
    const label = typeof entry.displayName === 'string' ? entry.displayName.trim() : '';
    const model = { id, label: label || id };
    if (typeof entry.description === 'string') model.description = entry.description;
    if (typeof entry.resolvedModel === 'string') model.resolvedModel = entry.resolvedModel;
    if (typeof entry.supportsEffort === 'boolean') model.supportsEffort = entry.supportsEffort;
    if (entry.supportsEffort === false) {
      model.efforts = [];
    } else if (Array.isArray(entry.supportedEffortLevels)) {
      model.efforts = [...new Set(entry.supportedEffortLevels.filter(
        (level) => typeof level === 'string' && level.length > 0 && level.length <= 32,
      ))];
    }
    const defaultEffort = entry.defaultEffort ?? entry.defaultEffortLevel;
    if (typeof defaultEffort === 'string' && (!model.efforts || model.efforts.includes(defaultEffort))) {
      model.defaultEffort = defaultEffort;
    }
    if (entry.isDefault === true || id === 'default') model.isDefault = true;
    models.push(model);
  }
  if (entries.length > 0 && models.length === 0) throw new Error('Claude Code returned an invalid model list.');
  return models;
}

function controlError(value) {
  // Never return a whole initialization response: it can also contain account
  // metadata. Only the protocol's error string is useful to the user.
  return String(value || 'Model metadata request was rejected.')
    .replace(/\x1b\[[0-9;]*[a-zA-Z]|\r/g, '')
    .replace(/\b(?:sk-ant-|sk-)[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .slice(0, 300);
}

export function discoverClaudeModels({ binaryPath, env, timeoutMs = 10_000, onCancel }) {
  return new Promise((resolve, reject) => {
    // Initialize the SDK control channel only. No user message is sent, so no
    // model inference is requested. User settings preserve provider/model
    // restrictions; a neutral cwd and strict MCP avoid project integrations.
    const args = [
      '--print', '--input-format', 'stream-json', '--output-format', 'stream-json',
      '--verbose', '--no-session-persistence', '--tools', '',
      '--disable-slash-commands', '--strict-mcp-config', '--setting-sources', 'user',
    ];
    const options = { cwd: os.tmpdir(), env, stdio: ['pipe', 'pipe', 'pipe'] };
    if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(binaryPath)) options.shell = true;
    const child = spawn(binaryPath, args, options);
    const requestId = randomUUID();
    let buffer = '';
    let bytes = 0;
    let settled = false;
    let closed = false;
    let cleanupCancel = () => {};
    const stop = () => {
      if (closed) return;
      child.stdin.destroy();
      child.kill('SIGTERM');
      const killTimer = setTimeout(() => child.kill('SIGKILL'), 1000);
      killTimer.unref();
      child.once('close', () => clearTimeout(killTimer));
    };
    const finish = (error, models) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanupCancel();
      stop();
      if (error) reject(error);
      else resolve(models);
    };
    const timer = setTimeout(() => finish(new Error('Timed out loading models from Claude Code.')), timeoutMs);
    cleanupCancel = onCancel?.(() => finish(new Error('Claude Code model discovery was cancelled.'))) || cleanupCancel;

    const readLine = (line) => {
      if (!line.trim() || settled) return;
      let message;
      try { message = JSON.parse(line); } catch {
        finish(new Error('Claude Code returned malformed model metadata.'));
        return;
      }
      if (message.type !== 'control_response' || message.response?.request_id !== requestId) return;
      if (message.response.subtype !== 'success') {
        finish(new Error(`Claude Code model discovery failed: ${controlError(message.response.error)}`));
        return;
      }
      try { finish(null, normalizeClaudeModels(message.response.response?.models)); } catch (error) { finish(error); }
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (settled) return;
      bytes += Buffer.byteLength(chunk, 'utf8');
      if (bytes > MAX_OUTPUT_BYTES) {
        finish(new Error('Claude Code model metadata exceeded the output limit.'));
        return;
      }
      buffer += chunk;
      let newline;
      while (!settled && (newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        readLine(line);
      }
    });
    // Drain stderr without retaining account data or unrelated diagnostics.
    child.stderr.on('data', () => {});
    child.stdin.on('error', (error) => {
      if (error.code !== 'EPIPE') finish(new Error('Could not request model metadata from Claude Code.'));
    });
    child.on('error', (error) => finish(new Error(`Failed to start Claude Code model discovery: ${error.code || 'spawn failed'}.`)));
    child.on('close', (code) => {
      closed = true;
      if (settled) return;
      if (buffer.trim()) readLine(buffer);
      if (!settled) finish(new Error(`Claude Code exited before returning model metadata (code ${code ?? 'unknown'}).`));
    });
    child.stdin.write(JSON.stringify({
      type: 'control_request', request_id: requestId, request: { subtype: 'initialize' },
    }) + '\n');
  });
}
