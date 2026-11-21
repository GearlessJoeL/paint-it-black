import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ClaudeCodeCliAdapter } from '../agents/claude-code.mjs';
import { normalizeClaudeModels } from '../agents/claude-models.mjs';

async function fixture(t, mode = 'success', extraEnv = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rt-claude-models-'));
  const binaryPath = path.join(dir, 'claude.mjs');
  const modelsPath = path.join(dir, 'models.json');
  const tracePath = path.join(dir, 'trace.jsonl');
  const models = [
    { value: 'default', displayName: 'Default (configured)', resolvedModel: 'claude-current', supportedEffortLevels: ['low', 'high'] },
    { value: 'new-live-model', displayName: 'New live model 🎨', supportsEffort: true, supportedEffortLevels: ['medium', 'xhigh'], defaultEffort: 'medium' },
    { value: 'effort-free', displayName: 'Effort-free', supportsEffort: false },
    { value: 'unknown-effort', displayName: 'Unknown effort' },
  ];
  await fs.writeFile(modelsPath, JSON.stringify(models));
  await fs.writeFile(binaryPath, `#!/usr/bin/env node
import fs from 'node:fs';
import readline from 'node:readline';
const args = process.argv.slice(2);
const trace = (event) => fs.appendFileSync(process.env.TRACE_PATH, JSON.stringify(event) + '\\n');
trace({ kind: 'spawn', args });
if (args.includes('--version')) { console.log('2.1.999 (Claude Code)'); process.exit(0); }
const input = readline.createInterface({ input: process.stdin });
input.on('line', (line) => {
  const request = JSON.parse(line);
  trace({ kind: 'input', request });
  const mode = process.env.MODE;
  if (mode === 'timeout') { setInterval(() => {}, 1000); return; }
  if (mode === 'malformed') { process.stdout.write('not json\\n'); return; }
  if (mode === 'oversized') { process.stdout.write('x'.repeat(1024 * 1024 + 1)); return; }
  if (mode === 'early-exit') { process.exit(3); }
  const reply = mode === 'error'
    ? { subtype: 'error', request_id: request.request_id, error: 'Authentication required (sk-ant-do-not-expose)' }
    : { subtype: 'success', request_id: request.request_id, response: {models: JSON.parse(fs.readFileSync(process.env.MODELS_PATH)), account: {private: 'must-not-be-returned'}} };
  setTimeout(() => {
    process.stdout.write(JSON.stringify({ type: 'system', subtype: 'status' }) + '\\n');
    const bytes = Buffer.from(JSON.stringify({ type: 'control_response', response: reply }) + '\\n');
    // Exercise stream framing, including a UTF-8 label split across chunks.
    const midpoint = Math.floor(bytes.length / 2);
    process.stdout.write(bytes.subarray(0, midpoint));
    setTimeout(() => process.stdout.write(bytes.subarray(midpoint)), 5);
  }, Number(process.env.DELAY || 0));
});
`, { mode: 0o755 });
  const adapter = new ClaudeCodeCliAdapter({
    binaryPath,
    env: { ...process.env, MODE: mode, MODELS_PATH: modelsPath, TRACE_PATH: tracePath, ...extraEnv },
    modelDiscoveryTimeoutMs: mode === 'timeout' ? 100 : 2000,
  });
  t.after(async () => {
    adapter.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  });
  return {
    adapter, modelsPath, models,
    trace: async () => (await fs.readFile(tracePath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line)),
  };
}

test('Claude lists current CLI models using only the SDK initialize metadata request', async (t) => {
  const f = await fixture(t);
  const status = await f.adapter.checkStatus();
  assert.equal(status.installed, true);
  assert.equal(status.modelsSource, 'live');
  assert.equal(status.modelDiscoveryError, undefined);
  assert.ok(status.modelsDiscoveredAt);
  assert.deepEqual(status.models.map((m) => m.id), f.models.map((m) => m.value));
  assert.equal(status.models[0].isDefault, true);
  assert.equal(status.models[0].resolvedModel, 'claude-current');
  assert.deepEqual(status.models[1].efforts, ['medium', 'xhigh']);
  assert.equal(status.models[1].defaultEffort, 'medium');
  assert.deepEqual(status.models[2].efforts, []);
  assert.equal(Object.hasOwn(status.models[3], 'efforts'), false);
  assert.equal('account' in status, false);
  assert.doesNotMatch(JSON.stringify(status), /must-not-be-returned/);
  const trace = await f.trace();
  const spawns = trace.filter((e) => e.kind === 'spawn');
  assert.equal(spawns.length, 2);
  assert.ok(spawns[1].args.includes('--no-session-persistence'));
  assert.ok(spawns[1].args.includes('--strict-mcp-config'));
  assert.equal(spawns[1].args[spawns[1].args.indexOf('--setting-sources') + 1], 'user');
  const inputs = trace.filter((e) => e.kind === 'input');
  assert.equal(inputs.length, 1);
  assert.deepEqual(inputs[0].request.request, { subtype: 'initialize' });
  assert.equal(inputs[0].request.type, 'control_request');
});

test('Claude caches genuine discovery results and force refresh loads changed models', async (t) => {
  const f = await fixture(t);
  const first = await f.adapter.checkStatus();
  const cached = await f.adapter.checkStatus();
  assert.equal(first.modelsSource, 'live');
  assert.equal(cached.modelsSource, 'live');
  assert.equal(cached, first);
  assert.equal(cached.modelsDiscoveredAt, first.modelsDiscoveredAt);
  assert.equal((await f.trace()).filter((e) => e.kind === 'input').length, 1);
  await fs.writeFile(f.modelsPath, JSON.stringify([{ value: 'future-model', displayName: 'Future model' }]));
  const refreshed = await f.adapter.checkStatus({ forceRefresh: true });
  assert.equal(refreshed.modelsSource, 'live');
  assert.deepEqual(refreshed.models.map((m) => m.id), ['future-model']);
  assert.equal((await f.trace()).filter((e) => e.kind === 'input').length, 2);
  f.adapter.statusCachedAt = 0;
  assert.equal((await f.adapter.checkStatus()).modelsSource, 'live');
  assert.equal((await f.trace()).filter((e) => e.kind === 'input').length, 3);
});

test('Claude coalesces concurrent refreshes and clears the completed in-flight request', async (t) => {
  const f = await fixture(t, 'success', { DELAY: '80' });
  const [one, two] = await Promise.all([
    f.adapter.checkStatus({ forceRefresh: true }), f.adapter.checkStatus({ forceRefresh: true }),
  ]);
  assert.deepEqual(one.models, two.models);
  assert.equal((await f.trace()).filter((e) => e.kind === 'input').length, 1);
  assert.equal(f.adapter.statusInFlight, null);
});

for (const [mode, pattern] of [
  ['malformed', /malformed/i], ['error', /Authentication required/],
  ['timeout', /Timed out/], ['oversized', /output limit/], ['early-exit', /exited before/],
]) {
  test(`Claude reports ${mode} model discovery honestly without losing installed status`, async (t) => {
    const f = await fixture(t, mode);
    const status = await f.adapter.checkStatus();
    assert.equal(status.installed, true);
    assert.equal(status.modelsSource, 'unavailable');
    assert.deepEqual(status.models, []);
    assert.match(status.modelDiscoveryError, pattern);
    assert.doesNotMatch(status.modelDiscoveryError, /sk-ant-do-not-expose/);
    assert.equal(f.adapter.statusInFlight, null);
    if (mode === 'error') assert.equal(status.authenticated, false);
  });
}

test('Claude missing binary has no invented models', async () => {
  const adapter = new ClaudeCodeCliAdapter({ binaryPath: '/nonexistent/claude', env: process.env });
  const status = await adapter.checkStatus();
  assert.equal(status.installed, false);
  assert.equal(status.modelsSource, 'unavailable');
  assert.deepEqual(status.models, []);
});

test('Claude disposal cancels metadata discovery and prevents caching its result', async (t) => {
  const f = await fixture(t, 'timeout');
  f.adapter.modelDiscoveryTimeoutMs = 2000;
  const pending = f.adapter.checkStatus();
  for (let attempt = 0; attempt < 50; attempt++) {
    if (f.adapter.statusProbeCancels.size > 0) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(f.adapter.statusProbeCancels.size, 1);
  f.adapter.dispose();
  const result = await pending;
  assert.equal(result.modelsSource, 'unavailable');
  assert.match(result.modelDiscoveryError, /cancelled/);
  assert.equal(f.adapter.statusCache, null);
  assert.equal(f.adapter.statusInFlight, null);
  assert.equal(f.adapter.statusProbeCancels.size, 0);
});

test('Claude immediate refresh after disposal starts a new probe instead of reusing the cancelled one', async (t) => {
  const f = await fixture(t, 'timeout');
  f.adapter.modelDiscoveryTimeoutMs = 2000;
  const pending = f.adapter.checkStatus();
  for (let attempt = 0; attempt < 50; attempt++) {
    if (f.adapter.statusProbeCancels.size > 0) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(f.adapter.statusProbeCancels.size, 1);
  f.adapter.dispose();
  f.adapter.env.MODE = 'success';
  const refreshed = f.adapter.checkStatus({ forceRefresh: true });
  const [cancelled, live] = await Promise.all([pending, refreshed]);
  assert.match(cancelled.modelDiscoveryError, /cancelled/);
  assert.equal(live.modelsSource, 'live');
  assert.equal(f.adapter.statusCache, live);
  assert.equal(f.adapter.statusInFlight, null);
});

test('Claude cache invalidation supersedes an active probe without letting it clear the new request', async (t) => {
  const f = await fixture(t, 'success', { DELAY: '80' });
  const pending = f.adapter.checkStatus();
  for (let attempt = 0; attempt < 50; attempt++) {
    if (f.adapter.statusProbeCancels.size > 0) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(f.adapter.statusProbeCancels.size, 1);
  f.adapter.invalidateStatusCache();
  const fresh = f.adapter.checkStatus({ forceRefresh: true });
  const freshInFlight = f.adapter.statusInFlight;
  await pending;
  assert.equal(f.adapter.statusInFlight, freshInFlight);
  const result = await fresh;
  assert.equal(result.modelsSource, 'live');
  assert.equal(f.adapter.statusCache, result);
  assert.equal(f.adapter.statusInFlight, null);
});

test('Claude honors empty CLI-default selection without pinning a preset model or effort', async () => {
  const adapter = new ClaudeCodeCliAdapter({ binaryPath: '/unused', env: {} });
  const calls = [];
  adapter.runStructuredPrompt = async (params) => { calls.push(params); return { conversationId: null, data: {} }; };
  await adapter.runUnifiedTurn({ prompt: 'fixture', schema: {} });
  await adapter.runUnifiedTurn({ prompt: 'fixture', schema: {}, model: 'cli-default', effort: 'high' });
  assert.equal(calls[0].model, '');
  assert.equal(calls[0].effort, '');
  assert.equal(calls[1].model, '');
  assert.equal(calls[1].effort, 'high');
});

test('Claude model normalization rejects missing data and deduplicates IDs', () => {
  assert.throws(() => normalizeClaudeModels(undefined), /no model list/);
  assert.throws(() => normalizeClaudeModels([{ value: '' }]), /invalid model list/);
  assert.deepEqual(normalizeClaudeModels([]), []);
  assert.deepEqual(normalizeClaudeModels([
    { value: 'alias', displayName: 'Live alias' }, { value: 'alias', displayName: 'Duplicate' }, null,
  ]), [{ id: 'alias', label: 'Live alias' }]);
});
