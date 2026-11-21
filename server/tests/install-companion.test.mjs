import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { installCompanion } from '../../scripts/install-companion.mjs';

async function fixture(t) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'stable-companion-')));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const sourceDir = path.join(dir, "Downloaded & 'quoted' source");
  const dataDir = path.join(dir, 'app data');
  const files = {
    'server/index.mjs': 'export const version = 1;\n',
    'scripts/install-autostart.sh': '#!/bin/bash\nexit 0\n',
    'scripts/start-server.sh': '#!/bin/bash\nexit 0\n',
    'scripts/runtime.sh': '# runtime fixture\n',
    'package.json': '{"name":"fixture","type":"module"}\n',
    'package-lock.json': '{"lockfileVersion":3}\n',
    'resume-sample/resume.tex': 'Fictional sample\n',
    'extension/manifest.json': '{"manifest_version":3}\n',
    'extension/sidepanel/sidepanel.html': '<p>Durable extension</p>\n',
    'node_modules/pdf-parse/package.json': '{"name":"pdf-parse","type":"module","exports":"./index.js"}\n',
    'node_modules/pdf-parse/index.js': 'export const copied = true;\n',
    'Setup.command': '#!/bin/bash\nexit 0\n',
    '.env': 'PRIVATE_FIXTURE=must-not-copy\n',
    '.git/config': 'private fixture\n',
    'work/private.txt': 'private fixture\n',
    'resume/resume.tex': 'private fixture\n',
    'config.json': '{"private":"must-not-copy"}\n',
  };
  for (const [entry, contents] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(sourceDir, entry)), { recursive: true });
    await fs.writeFile(path.join(sourceDir, entry), contents);
  }
  await fs.chmod(path.join(sourceDir, 'Setup.command'), 0o755);
  await fs.mkdir(path.join(sourceDir, 'node_modules', '.bin'));
  await fs.symlink('../pdf-parse/index.js', path.join(sourceDir, 'node_modules', '.bin', 'pdf-fixture'));
  await fs.mkdir(dataDir);
  await fs.writeFile(path.join(dataDir, 'config.json'), '{"resumeConfigured":false,"keep":"yes"}\n');
  return { dir, sourceDir, dataDir, options: { sourceDir, dataDir, log() {} } };
}

test('stable companion remains self-contained after the original source is removed', async (t) => {
  const f = await fixture(t);
  const { appDir, updated } = await installCompanion(f.options);
  assert.equal(updated, true);
  assert.equal(appDir, path.join(f.dataDir, 'companion'));
  for (const excluded of ['.env', '.git', 'work', 'resume', 'config.json']) {
    assert.equal(await fs.lstat(path.join(appDir, excluded)).then(() => true, () => false), false);
  }
  assert.match(await fs.readFile(path.join(appDir, 'extension', 'sidepanel', 'sidepanel.html'), 'utf8'), /Durable extension/);
  assert.equal(await fs.readlink(path.join(appDir, 'node_modules', '.bin', 'pdf-fixture')), '../pdf-parse/index.js');
  assert.equal((await fs.stat(path.join(appDir, 'Setup.command'))).mode & 0o111, 0o111);
  await fs.rm(f.sourceDir, { recursive: true });
  const probe = spawnSync(process.execPath, ['--input-type=module', '-e', 'const m=await import("pdf-parse"); if(!m.copied) process.exit(1);'], { cwd: appDir, encoding: 'utf8' });
  assert.equal(probe.status, 0, probe.stderr);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.dataDir, 'config.json'), 'utf8')), { resumeConfigured: false, keep: 'yes' });
  assert.deepEqual(await installCompanion({ sourceDir: appDir, dataDir: f.dataDir, log() {} }), { appDir, updated: false });
});

test('managed companion updates atomically without replacing user configuration', async (t) => {
  const f = await fixture(t);
  const { appDir } = await installCompanion(f.options);
  await fs.writeFile(path.join(f.sourceDir, 'server', 'index.mjs'), 'export const version = 2;\n');
  await installCompanion(f.options);
  assert.match(await fs.readFile(path.join(appDir, 'server', 'index.mjs'), 'utf8'), /version = 2/);
  assert.deepEqual((await fs.readdir(f.dataDir)).sort(), ['companion', 'config.json']);
  await fs.rm(path.join(f.sourceDir, 'extension', 'manifest.json'));
  await assert.rejects(installCompanion(f.options), /Application prerequisite is missing/);
  assert.match(await fs.readFile(path.join(appDir, 'server', 'index.mjs'), 'utf8'), /version = 2/);
});

test('stable installation leaves an unmanaged destination untouched', async (t) => {
  const f = await fixture(t);
  const target = path.join(f.dataDir, 'companion');
  await fs.mkdir(target);
  await fs.writeFile(path.join(target, 'keep.txt'), 'existing data');
  await assert.rejects(installCompanion(f.options), /not managed.*left unchanged/);
  assert.equal(await fs.readFile(path.join(target, 'keep.txt'), 'utf8'), 'existing data');
});
