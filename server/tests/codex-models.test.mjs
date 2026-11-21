import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CodexCliAdapter } from '../agents/codex.mjs';
import { discoverCodexModels, normalizeCodexModels } from '../agents/codex-models.mjs';

async function fixture(t, mode = 'success') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-catalog-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const binaryPath = path.join(dir, 'codex');
  const configPath = path.join(dir, 'catalog.json');
  const logPath = path.join(dir, 'requests.jsonl');
  await fs.writeFile(configPath, JSON.stringify({ mode }));
  await fs.writeFile(binaryPath, `#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
const config = JSON.parse(fs.readFileSync(process.env.CATALOG_CONFIG, 'utf8'));
const log = (entry) => fs.appendFileSync(process.env.CATALOG_LOG, JSON.stringify(entry) + '\\n');
log({args: process.argv.slice(2)});
if (process.argv[2] === '--version') { console.log('codex-cli fake'); process.exit(0); }
if (process.argv[2] === 'exec') {
  const args = process.argv.slice(2);
  fs.readFileSync(0, 'utf8');
  fs.writeFileSync(args[args.indexOf('-o') + 1], JSON.stringify({reply:'fake result'}));
  process.exit(0);
}
if (process.argv[2] !== 'app-server') process.exit(90);
let initialized = false;
function send(message) {
  const bytes = Buffer.from(JSON.stringify(message) + '\\n');
  // Split inside multi-byte UTF-8 as well as JSON tokens.
  let i = 0;
  const write = () => {
    if (i >= bytes.length) return;
    const end = Math.min(i + 7, bytes.length);
    process.stdout.write(bytes.subarray(i, end)); i = end;
    setImmediate(write);
  };
  write();
}
const rl = readline.createInterface({input: process.stdin});
rl.on('line', (line) => {
  const request = JSON.parse(line); log(request);
  if (config.mode === 'timeout') return;
  if (request.method === 'initialize') {
    send({id:request.id, result:{userAgent:'fake'}}); return;
  }
  if (request.method === 'initialized') { initialized = true; return; }
  if (request.method !== 'model/list' || !initialized) process.exit(91);
  if (config.mode === 'error') { send({id:request.id,error:{code:-32601,message:'model/list unavailable'}}); return; }
  if (config.mode === 'auth') { send({id:request.id,error:{code:401,message:'authentication required'}}); return; }
  if (config.mode === 'secret') { send({id:request.id,error:{code:-32601,message:'api_key=sk-secret123456789 Bearer abcdefghijklmnop'}}); return; }
  if (config.mode === 'malformed') { process.stdout.write('not-json\\n'); return; }
  if (config.mode === 'overflow') { process.stdout.write('x'.repeat(20000)); return; }
  if (config.mode === 'repeat') { send({id:request.id,result:{data:[],nextCursor:'same'}}); return; }
  const second = Boolean(request.params.cursor);
  send({id:request.id,result:{data:second ? [
    {id:'second-catalog-id',model:'live-model-b',displayName:'Second model',supportedReasoningEfforts:[{reasoningEffort:'high'}],defaultReasoningEffort:'high',isDefault:false}
  ] : [
    {id:'first-catalog-id',model:'live-model-a',displayName:'Live 模型',supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'medium'}],defaultReasoningEffort:'medium',isDefault:true}
  ],nextCursor:second ? null : 'page-2'}});
});
`, { mode: 0o755 });
  const env = {
    PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH || ''}`,
    CATALOG_CONFIG: configPath, CATALOG_LOG: logPath,
  };
  const adapter = new CodexCliAdapter({ binaryPath, env, modelDiscoveryTimeoutMs: 2000 });
  return {
    binaryPath, env, adapter,
    configure: (next) => fs.writeFile(configPath, JSON.stringify(next)),
    requests: async () => (await fs.readFile(logPath, 'utf8')).trim().split('\n').map(JSON.parse),
  };
}

test('Codex model normalization uses advertised IDs and reasoning efforts without presets', () => {
  assert.deepEqual(normalizeCodexModels([
    { id: 'catalog-id', model: 'available-model', displayName: 'Available', supportedReasoningEfforts: [{ reasoningEffort: 'minimal' }, { reasoningEffort: 'high' }, { reasoningEffort: 'high' }], defaultReasoningEffort: 'high', isDefault: true },
    { id: 'duplicate', model: 'available-model' },
    { id: 'hidden-model', hidden: true },
    { id: 'no-efforts' },
    null,
  ]), [
    { id: 'available-model', label: 'Available (available-model)', efforts: ['minimal', 'high'], defaultEffort: 'high', isDefault: true, description: '' },
    { id: 'no-efforts', label: 'no-efforts', efforts: [], defaultEffort: '', isDefault: false, description: '' },
  ]);
});

test('Codex discovers paginated live metadata after its handshake and caches/coalesces probes', async (t) => {
  const f = await fixture(t);
  const [status, concurrent] = await Promise.all([f.adapter.checkStatus(), f.adapter.checkStatus({ forceRefresh: true })]);
  assert.equal(status, concurrent);
  assert.equal(status.installed, true);
  assert.equal(status.modelsSource, 'live');
  assert.equal(status.modelDiscoveryError, null);
  assert.deepEqual(status.models.map((model) => model.id), ['live-model-a', 'live-model-b']);
  assert.deepEqual(status.models[0].efforts, ['low', 'medium']);
  assert.equal(status.models[0].defaultEffort, 'medium');
  assert.match(status.models[0].label, /模型/);
  const requests = await f.requests();
  assert.deepEqual(requests.filter((entry) => entry.method).map((entry) => entry.method), ['initialize', 'initialized', 'model/list', 'model/list']);
  assert.equal(requests.find((entry) => entry.method === 'model/list').params.includeHidden, false);
  assert.equal(requests.filter((entry) => entry.method === 'model/list')[1].params.cursor, 'page-2');
  assert.equal(await f.adapter.checkStatus(), status);
  assert.equal((await f.requests()).filter((entry) => entry.args?.[0] === 'app-server').length, 1);
  const refreshed = await f.adapter.checkStatus({ forceRefresh: true });
  assert.notEqual(refreshed, status);
  f.adapter.statusCachedAt -= 121_000;
  await f.adapter.checkStatus();
  assert.equal((await f.requests()).filter((entry) => entry.args?.[0] === 'app-server').length, 3);
});

test('Codex discovery errors retain CLI availability and expose an unavailable catalog', async (t) => {
  const f = await fixture(t, 'error');
  const status = await f.adapter.checkStatus();
  assert.equal(status.installed, true);
  assert.equal(status.modelsSource, 'unavailable');
  assert.deepEqual(status.models, []);
  assert.match(status.modelDiscoveryError, /model\/list unavailable/);
  await f.configure({ mode: 'success' });
  const recovered = await f.adapter.checkStatus({ forceRefresh: true });
  assert.equal(recovered.modelsSource, 'live');
  assert.equal(recovered.models.length, 2);
});

test('Codex catalog discovery bounds malformed output, pagination, output size, and time', async (t) => {
  for (const [mode, pattern, options] of [
    ['malformed', /malformed JSON/, {}],
    ['repeat', /repeated pagination cursor/, {}],
    ['overflow', /output limit/, { maxOutputBytes: 10000 }],
    ['timeout', /Timed out loading Codex models/, { timeoutMs: 100 }],
  ]) {
    await t.test(mode, async (subtest) => {
      const f = await fixture(subtest, mode);
      await assert.rejects(discoverCodexModels({ binaryPath: f.binaryPath, env: f.env, timeoutMs: 2000, ...options }), pattern);
    });
  }
});

test('Codex model metadata auth errors require sign-in while preserving installation status', async (t) => {
  const f = await fixture(t, 'auth');
  const status = await f.adapter.checkStatus();
  assert.equal(status.installed, true);
  assert.equal(status.authenticated, false);
  assert.equal(status.modelsSource, 'unavailable');
  assert.match(status.message, /sign-in/);
});

test('Codex model discovery redacts credentials in protocol errors', async (t) => {
  const f = await fixture(t, 'secret');
  const status = await f.adapter.checkStatus();
  assert.match(status.modelDiscoveryError, /redacted/);
  assert.doesNotMatch(status.modelDiscoveryError, /secret123456789|abcdefghijklmnop/);
});

test('Codex Auto effort preserves CLI defaults for explicit models', async (t) => {
  const f = await fixture(t);
  const input = { prompt: 'fake test input', schema: { type: 'object', properties: { reply: { type: 'string' } } }, model: 'live-model-b' };
  await f.adapter.runStructuredPrompt({ ...input, effort: '' });
  await f.adapter.runStructuredPrompt({ ...input, effort: 'high' });
  const calls = (await f.requests()).filter((entry) => entry.args?.[0] === 'exec');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].args.includes('live-model-b'), true);
  assert.equal(calls[0].args.some((arg) => arg.includes('model_reasoning_effort')), false);
  assert.equal(calls[1].args.includes('model_reasoning_effort="high"'), true);
});
