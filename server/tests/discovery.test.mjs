import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AgentRegistry, createDefaultRegistry } from '../agents/registry.mjs';
import { TailorService } from '../tailor-service.mjs';

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'resume-discovery-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const utilityBin = path.join(dir, 'utilities');
  await fs.mkdir(utilityBin);
  await fs.symlink(process.execPath, path.join(utilityBin, 'node'));
  const config = {
    host: '127.0.0.1', port: 8787, resumeRepoDir: dir, revisionsDir: dir,
    agyBin: path.join(dir, 'missing-agy'), claudeBin: path.join(dir, 'missing-claude'),
    codexBin: path.join(dir, 'missing-codex'), extraPathDirs: [], texliveDirs: [], apiDefaults: {},
  };
  let discovered = config;
  const registry = createDefaultRegistry({
    config, env: { PATH: utilityBin, DISCOVERY_MARKER: 'preserved' },
    resolveConfig: () => discovered,
  });
  t.after(() => registry.disposeAll());
  const service = new TailorService({ config, registry });
  service.env = { PATH: utilityBin }; // Do not probe a real LaTeX installation.
  async function cli(name, version) {
    const bin = path.join(dir, `installation ${version}`);
    await fs.mkdir(bin, { recursive: true });
    const executable = path.join(bin, name);
    await fs.writeFile(executable, `#!/usr/bin/env node
const arg = process.argv[2];
if (process.env.DISCOVERY_MARKER !== 'preserved') process.exit(97);
if (arg === 'app-server' || process.argv.includes('--input-format')) {
  require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
    const message = JSON.parse(line);
    if (message.method === 'initialize') console.log(JSON.stringify({ id: message.id, result: {} }));
    if (message.method === 'model/list') console.log(JSON.stringify({ id: message.id, result: {
      data: [{ id: 'live-codex', model: 'live-codex', displayName: 'Live Codex', supportedReasoningEfforts: [] }], nextCursor: null,
    } }));
    if (message.request?.subtype === 'initialize') console.log(JSON.stringify({ type: 'control_response', response: {
      subtype: 'success', request_id: message.request_id,
      response: { models: [{ value: 'live-claude', displayName: 'Live Claude', supportedEffortLevels: [] }] },
    } }));
  });
} else {
if (arg !== '--version' && arg !== 'models') process.exit(98);
console.log(arg === 'models' ? 'gemini-discovery-low Test model' : ${JSON.stringify(`${name} ${version}`)});
}
`, { mode: 0o755 });
    return executable;
  }
  return { dir, config, registry, service, cli, discover: (next) => { discovered = next; } };
}

test('health and reconnect discover a CLI installed at a new path without recreating adapters', async (t) => {
  const f = await fixture(t);
  const adapter = f.registry.get('codex');
  const before = await f.service.getHealth();
  assert.equal(before.agents.find((agent) => agent.id === 'codex').installed, false);
  const installed = await f.cli('codex', 'new');
  assert.notEqual(installed, adapter.binaryPath);
  f.discover({ ...f.config, codexBin: installed, extraPathDirs: [path.dirname(installed)] });
  const health = await f.service.reconnect({ agentId: 'codex' });
  const codex = health.agents.find((agent) => agent.id === 'codex');
  assert.equal(codex.installed, true);
  assert.equal(codex.binaryPath, installed);
  assert.equal(f.registry.get('codex'), adapter);
  assert.equal(adapter.env.PATH.split(path.delimiter)[0], path.dirname(installed));
  assert.equal(adapter.env.DISCOVERY_MARKER, 'preserved');
});

test('path changes invalidate cached status while unchanged paths preserve sessions and caches', async (t) => {
  const f = await fixture(t);
  const first = await f.cli('codex', 'first');
  const claudePath = await f.cli('claude', 'first');
  const agyPath = await f.cli('agy', 'first');
  const config = { ...f.config, codexBin: first, claudeBin: claudePath, agyBin: agyPath, extraPathDirs: [path.dirname(first)] };
  f.discover(config);
  const before = await f.registry.checkAllStatuses();
  assert.ok(before.every((agent) => agent.installed));
  const claude = f.registry.get('claude');
  const agy = f.registry.get('antigravity');
  claude.sessionIds.set('session', 'conversation');
  let disposed = 0;
  agy.sessionWorkers.set('session', { dispose() { disposed += 1; } });
  const unchanged = await f.registry.checkAllStatuses();
  for (const id of ['codex', 'claude', 'antigravity']) {
    assert.equal(unchanged.find((agent) => agent.id === id), before.find((agent) => agent.id === id));
  }
  const moved = await f.cli('codex', 'moved');
  f.discover({ ...config, codexBin: moved, extraPathDirs: [path.dirname(moved)] });
  const after = await f.registry.checkAllStatuses();
  const codex = after.find((agent) => agent.id === 'codex');
  assert.equal(codex.binaryPath, moved);
  assert.match(codex.message, /moved/);
  assert.notEqual(codex, before.find((agent) => agent.id === 'codex'));
  assert.equal(f.registry.get('codex').env.PATH.split(path.delimiter)[0], path.dirname(moved));
  assert.equal(claude.sessionIds.get('session'), 'conversation');
  assert.equal(claude.statusCache, before.find((agent) => agent.id === 'claude'));
  assert.equal(agy.sessionWorkers.size, 1);
  assert.equal(disposed, 0);
});

test('custom registries continue to support status probes without runtime discovery', async () => {
  const registry = new AgentRegistry();
  const status = { id: 'mock', installed: true, authenticated: true };
  let options;
  registry.register({ id: 'mock', async checkStatus(value) { options = value; return status; } });
  assert.deepEqual(await registry.checkAllStatuses({ forceRefresh: true }), [status]);
  assert.deepEqual(options, { forceRefresh: true });
});
