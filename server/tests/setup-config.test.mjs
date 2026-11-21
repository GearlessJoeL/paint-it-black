import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createCompanionServer } from '../index.mjs';

const configUrl = pathToFileURL(fileURLToPath(new URL('../config.mjs', import.meta.url))).href;
const TEMPLATE = '\\documentclass{article}\n\\begin{document}User supplied resume.\\end{document}\n';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paint-it-black-setup-config-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, "Home & user's files");
  const dataDir = path.join(home, '.local', 'share', 'paint-it-black');
  await fs.mkdir(dataDir, { recursive: true });
  return { root, home, dataDir };
}

async function writeMaster(directory, name = 'resume.tex') {
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, name), TEMPLATE);
}

function childConfig(f, overrides = {}, environment = {}) {
  // Separate processes give each test its own HOME and prevent reading the
  // developer's legacy resume, CLI configuration, or environment overrides.
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import {loadConfig} from ${JSON.stringify(configUrl)};
    const c=loadConfig(${JSON.stringify(overrides)});
    console.log(JSON.stringify({
      dataDir:c.dataDir,setupConfigPath:c.setupConfigPath,resumeConfigured:c.resumeConfigured,
      resumeSource:c.resumeSource,resumeRepoDir:c.resumeRepoDir,texliveDirs:c.texliveDirs,extraPathDirs:c.extraPathDirs,
    }));
  `], {
    env: { HOME: f.home, PATH: '/usr/bin:/bin', ...environment },
    encoding: 'utf8', timeout: 10_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('fresh setup has no chosen resume and does not create or select a demonstration master', async (t) => {
  const f = await fixture(t);
  const config = childConfig(f);
  assert.equal(config.resumeConfigured, false);
  assert.equal(config.resumeSource, null);
  assert.equal(config.resumeRepoDir, path.join(f.dataDir, 'resume'));
  assert.equal(config.dataDir, f.dataDir);
  assert.deepEqual(await fs.readdir(f.dataDir), []);
});

test('saved user resume selection and portable TeX bin survive a clean environment restart', async (t) => {
  const f = await fixture(t);
  const imported = path.join(f.dataDir, 'resume', 'selected-user-import');
  const texBin = path.join(f.dataDir, 'runtime', 'tex', 'bin', 'fixture-platform');
  await writeMaster(imported);
  await fs.mkdir(texBin, { recursive: true });
  await fs.writeFile(path.join(texBin, 'pdflatex'), '#!/bin/sh\n', { mode: 0o755 });
  await fs.writeFile(path.join(f.dataDir, 'config.json'), JSON.stringify({
    resumeConfigured: true, resumeSource: 'user', resumeRepoDir: imported, texBin,
  }));
  const config = childConfig(f);
  assert.equal(config.resumeConfigured, true);
  assert.equal(config.resumeSource, 'user');
  assert.equal(config.resumeRepoDir, imported);
  assert.ok(config.texliveDirs.includes(texBin));
  assert.ok(config.extraPathDirs.includes(texBin));
});

test('existing users retain their own legacy resume when no explicit selection has been saved', async (t) => {
  const f = await fixture(t);
  const legacy = path.join(f.home, 'code', 'resume');
  await writeMaster(legacy);
  const config = childConfig(f);
  assert.equal(config.resumeConfigured, true);
  assert.equal(config.resumeRepoDir, legacy);
  assert.equal(config.resumeSource, 'user');
});

test('isolated custom data directories do not silently use a HOME legacy resume', async (t) => {
  const f = await fixture(t);
  await writeMaster(path.join(f.home, 'code', 'resume'));
  const isolated = path.join(f.root, 'isolated deployment');
  const config = childConfig(f, { dataDir: isolated });
  assert.equal(config.resumeConfigured, false);
  assert.equal(config.resumeRepoDir, path.join(isolated, 'resume'));
  assert.equal(config.resumeSource, null);
});

test('missing explicitly selected resume requires reimport instead of silently falling back to another master', async (t) => {
  const f = await fixture(t);
  const missing = path.join(f.dataDir, 'resume', 'deleted-user-import');
  await writeMaster(path.join(f.home, 'code', 'resume'));
  await fs.writeFile(path.join(f.dataDir, 'config.json'), JSON.stringify({
    resumeConfigured: true, resumeSource: 'user', resumeRepoDir: missing,
  }));
  const config = childConfig(f);
  assert.equal(config.resumeConfigured, false);
  assert.equal(config.resumeRepoDir, missing);
  assert.equal(config.resumeSource, null);
});

test('a missing selected file never makes another app-data directory into an automatic resume', async (t) => {
  const f = await fixture(t);
  const missing = path.join(f.dataDir, 'resume', 'missing-selected');
  await fs.mkdir(missing, { recursive: true });
  await writeMaster(path.join(f.dataDir, 'resume'), 'demonstration.tex');
  await fs.writeFile(path.join(f.dataDir, 'config.json'), JSON.stringify({ resumeConfigured: true, resumeRepoDir: missing }));
  const config = childConfig(f);
  assert.equal(config.resumeConfigured, false);
  assert.equal(config.resumeRepoDir, missing);
});

test('invalid setup JSON is treated as incomplete setup and is left unchanged', async (t) => {
  const f = await fixture(t);
  const filename = path.join(f.dataDir, 'config.json');
  const invalid = '{"resumeConfigured":true,"resumeRepoDir":';
  await fs.writeFile(filename, invalid);
  const config = childConfig(f);
  assert.equal(config.resumeConfigured, false);
  assert.equal(config.resumeSource, null);
  assert.equal(await fs.readFile(filename, 'utf8'), invalid);
});

async function serveSetup(t, dataDir) {
  const registry = {
    get() { throw new Error('Setup status must not invoke an AI backend.'); },
    async checkAllStatuses() { throw new Error('Setup status must not probe AI backends.'); },
    disposeAll() {},
  };
  const { server } = createCompanionServer({ config: { dataDir }, registry });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}

test('GET /api/setup/status reports required user import without running AI or creating a master', async (t) => {
  const f = await fixture(t);
  const base = await serveSetup(t, f.dataDir);
  const response = await fetch(`${base}/api/setup/status`, { headers: { Origin: 'chrome-extension://fixture' } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const status = await response.json();
  assert.equal(status.resumeConfigured, false);
  assert.equal(status.resumeSource, null);
  assert.deepEqual(status.acceptedFormats, ['pdf', 'tex']);
  assert.equal(status.maxUploadBytes, 8 * 1024 * 1024);
  assert.deepEqual(await fs.readdir(f.dataDir), []);
  assert.equal((await fetch(`${base}/api/setup/resume/pdf`)).status, 404);
});

test('setup status reports a saved user resume and notices if the selected file is later removed', async (t) => {
  const f = await fixture(t);
  const imported = path.join(f.dataDir, 'resume', 'user-import');
  await writeMaster(imported);
  await fs.writeFile(path.join(f.dataDir, 'config.json'), JSON.stringify({ resumeConfigured: true, resumeRepoDir: imported, resumeSource: 'user' }));
  const base = await serveSetup(t, f.dataDir);
  const pdfBytes = Buffer.from('%PDF-1.7\nchosen user resume preview');
  await fs.writeFile(path.join(imported, 'resume.pdf'), pdfBytes);
  const preview = await fetch(`${base}/api/setup/resume/pdf`);
  assert.equal(preview.status, 200);
  assert.equal(preview.headers.get('content-type'), 'application/pdf');
  assert.equal(preview.headers.get('content-disposition'), 'inline; filename="resume.pdf"');
  assert.deepEqual(Buffer.from(await preview.arrayBuffer()), pdfBytes);
  const ready = await (await fetch(`${base}/api/setup/status`)).json();
  assert.equal(ready.resumeConfigured, true);
  assert.equal(ready.resumeRepoDir, imported);
  await fs.rm(path.join(imported, 'resume.tex'));
  const incomplete = await (await fetch(`${base}/api/setup/status`)).json();
  assert.equal(incomplete.resumeConfigured, false);
});
