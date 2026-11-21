import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { prepareCompanion } from '../../scripts/setup-companion.mjs';

const projectDir = fileURLToPath(new URL('../../', import.meta.url));

async function temporary(t) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'companion-setup-')));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('fresh setup verifies the bundled template without selecting it as the user resume', async (t) => {
  const dataDir = path.join(await temporary(t), 'fresh data');
  let selected;
  const result = await prepareCompanion({
    dataDir, log() {},
    provisionTex: async (options) => { selected = options; return { texBin: '/fixture/tex/bin', managed: true }; },
  });
  assert.equal(selected.dataDir, dataDir);
  assert.equal(selected.templatePath, path.join(projectDir, 'resume-sample', 'resume.tex'));
  assert.equal(result.resumeConfigured, false);
  assert.equal(result.resumeSource, null);
  assert.equal(result.resumeRepoDir, undefined);
  assert.equal(result.nodeBin, await fs.realpath(process.execPath));
  assert.equal(result.texBin, '/fixture/tex/bin');
  const saved = await fs.readFile(path.join(dataDir, 'config.json'), 'utf8');
  assert.equal(JSON.parse(saved).resumeConfigured, false);
  assert.doesNotMatch(saved, /API_KEY|apiKey|Bearer/);
  assert.deepEqual(await fs.readdir(dataDir), ['config.json']);
});

test('setup preserves a configured user resume and merges config after provisioning', async (t) => {
  const dir = await temporary(t);
  const dataDir = path.join(dir, 'data');
  const resumeRepoDir = path.join(dir, 'own resume');
  await fs.mkdir(dataDir);
  await fs.mkdir(resumeRepoDir);
  await fs.writeFile(path.join(resumeRepoDir, 'resume.tex'), '\\documentclass{article}\\begin{document}Fixture\\end{document}');
  const original = { resumeConfigured: true, resumeSource: 'user', resumeRepoDir, keep: 'before' };
  const configPath = path.join(dataDir, 'config.json');
  await fs.writeFile(configPath, JSON.stringify(original));
  const result = await prepareCompanion({
    dataDir, log() {},
    provisionTex: async ({ templatePath }) => {
      assert.equal(templatePath, path.join(resumeRepoDir, 'resume.tex'));
      await fs.writeFile(configPath, JSON.stringify({ ...original, keep: 'latest', preference: 'preserved' }));
      return { texBin: '/existing/tex/bin', managed: false };
    },
  });
  assert.equal(result.resumeConfigured, true);
  assert.equal(result.resumeRepoDir, resumeRepoDir);
  assert.equal(result.keep, 'latest');
  assert.equal(result.preference, 'preserved');
  assert.equal(result.texManaged, false);
  assert.deepEqual((await fs.readdir(dataDir)).filter((entry) => entry.includes('.tmp-')), []);
});

test('failed preflight and malformed saved config never replace existing settings', async (t) => {
  const dataDir = await temporary(t);
  const filename = path.join(dataDir, 'config.json');
  const original = '{"resumeConfigured":false,"preference":"preserve"}\n';
  await fs.writeFile(filename, original);
  await assert.rejects(prepareCompanion({ dataDir, log() {}, provisionTex: async () => { throw new Error('preflight failed'); } }), /preflight failed/);
  assert.equal(await fs.readFile(filename, 'utf8'), original);
  await fs.writeFile(filename, '{invalid');
  let invoked = false;
  await assert.rejects(prepareCompanion({ dataDir, log() {}, provisionTex: async () => { invoked = true; } }), /Existing resume settings were preserved/);
  assert.equal(invoked, false);
  assert.equal(await fs.readFile(filename, 'utf8'), '{invalid');
});

test('setup orchestrator installs dependencies once and prepare-only skips services', async (t) => {
  const dir = await temporary(t);
  const scripts = path.join(dir, 'scripts');
  const bin = path.join(dir, 'node', 'bin');
  await fs.mkdir(scripts);
  await fs.mkdir(bin, { recursive: true });
  const nodeBin = path.join(bin, 'node');
  await fs.copyFile(process.execPath, nodeBin, constants.COPYFILE_FICLONE);
  await fs.copyFile(path.join(projectDir, 'scripts', 'setup.sh'), path.join(scripts, 'setup.sh'));
  await fs.writeFile(path.join(dir, 'package.json'), '{"name":"setup-fixture","private":true,"type":"module"}\n');
  await fs.writeFile(path.join(dir, 'package-lock.json'), '{"name":"setup-fixture","lockfileVersion":3}\n');
  await fs.writeFile(path.join(scripts, 'bootstrap-node.sh'), `resume_tailor_bootstrap_node() { NODE_BIN="$FAKE_NODE_BIN"; PATH="$(dirname "$NODE_BIN"):$PATH"; export NODE_BIN PATH; }\n`);
  await fs.writeFile(path.join(bin, 'npm'), `#!/bin/bash
set -eu
printf 'npm:%s:cache=%s\\n' "$*" "$npm_config_cache" >> "$SETUP_LOG"
mkdir -p node_modules/pdf-parse
printf '%s' '{"name":"pdf-parse","version":"2.4.5","type":"module","exports":"./index.js"}' > node_modules/pdf-parse/package.json
printf '%s' 'export const fixture = true;' > node_modules/pdf-parse/index.js
`, { mode: 0o755 });
  await fs.writeFile(path.join(scripts, 'setup-companion.mjs'), `import fs from 'node:fs'; fs.appendFileSync(process.env.SETUP_LOG, 'prepare\\n');\n`);
  await fs.writeFile(path.join(scripts, 'install-companion.mjs'), `import fs from 'node:fs/promises'; import path from 'node:path'; const app=path.join(process.env.PAINT_IT_BLACK_DATA_DIR,'companion'); await fs.mkdir(path.join(app,'scripts'),{recursive:true}); await fs.copyFile('scripts/install-autostart.sh',path.join(app,'scripts/install-autostart.sh')); console.log(app);\n`);
  await fs.writeFile(path.join(scripts, 'install-autostart.sh'), `#!/bin/bash\nprintf 'service:%s\\n' "$PAINT_IT_BLACK_BOOTSTRAPPED" >> "$SETUP_LOG"\n`, { mode: 0o755 });
  const logPath = path.join(dir, 'setup.log');
  const dataDir = path.join(dir, 'data');
  const run = (args) => spawnSync('/bin/bash', [path.join(scripts, 'setup.sh'), ...args], {
    env: { HOME: dir, PATH: '/usr/bin:/bin', FAKE_NODE_BIN: nodeBin, PAINT_IT_BLACK_DATA_DIR: dataDir, SETUP_LOG: logPath },
    encoding: 'utf8', timeout: 10_000,
  });
  for (let index = 0; index < 2; index++) {
    const result = run(['--prepare-only']);
    assert.equal(result.status, 0, result.stderr);
  }
  let lines = (await fs.readFile(logPath, 'utf8')).trim().split('\n');
  assert.equal(lines.filter((line) => line.startsWith('npm:')).length, 1);
  assert.match(lines[0], /ci --omit=dev --ignore-scripts --no-audit --no-fund/);
  assert.match(lines[0], new RegExp(`cache=${dataDir}/cache/npm`));
  assert.equal(lines.filter((line) => line.startsWith('service:')).length, 0);
  const normal = run([]);
  assert.equal(normal.status, 0, normal.stderr);
  lines = (await fs.readFile(logPath, 'utf8')).trim().split('\n');
  assert.equal(lines.filter((line) => line.startsWith('npm:')).length, 1);
  assert.equal(lines.at(-1), 'service:1');
});
