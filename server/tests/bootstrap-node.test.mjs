import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const projectDir = fileURLToPath(new URL('../../', import.meta.url));
const version = '24.22.3';
const name = `node-v${version}-darwin-arm64`;

async function fixture(t, { unsafe = false, badChecksum = false } = {}) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'node-bootstrap-')));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const home = path.join(dir, "Home & 'fixture'");
  const scripts = path.join(dir, 'scripts');
  const utilities = path.join(dir, 'utilities');
  const mirror = path.join(dir, 'mirror');
  for (const subdir of [home, scripts, utilities, mirror]) await fs.mkdir(subdir, { recursive: true });
  await fs.copyFile(path.join(projectDir, 'scripts', 'bootstrap-node.sh'), path.join(scripts, 'bootstrap-node.sh'));
  let runtime = await fs.readFile(path.join(projectDir, 'scripts', 'runtime.sh'), 'utf8');
  for (const hostBin of ['/opt/homebrew/bin', '/usr/local/bin', '/Library/TeX/texbin']) {
    runtime = runtime.replaceAll(hostBin, path.join(dir, 'empty-host', hostBin));
  }
  await fs.writeFile(path.join(scripts, 'runtime.sh'), runtime);
  for (const tool of ['dirname', 'cat', 'mkdir', 'mktemp', 'rm', 'mv', 'cp', 'awk', 'tar', 'gzip', 'shasum', 'sha256sum', 'sha256', 'sleep']) {
    for (const prefix of ['/usr/bin', '/bin']) {
      const source = path.join(prefix, tool);
      if (await fs.access(source).then(() => true, () => false)) {
        await fs.symlink(source, path.join(utilities, tool));
        break;
      }
    }
  }
  const archiveRoot = path.join(dir, 'build', name);
  await fs.mkdir(path.join(archiveRoot, 'bin'), { recursive: true });
  if (unsafe) await fs.symlink('../../../../escape', path.join(archiveRoot, 'bin', 'node'));
  else await fs.writeFile(path.join(archiveRoot, 'bin', 'node'), `#!/bin/bash
case "\${1:-}" in
  --version|-v) printf 'v${version}\\n' ;;
  -p) printf '${version}\\n' ;;
  -e) printf '%s' "$0" ;;
  *) exit 99 ;;
esac
`, { mode: 0o755 });
  const archive = path.join(mirror, `${name}.tar.gz`);
  const packed = spawnSync('/usr/bin/tar', ['-czf', archive, '-C', path.dirname(archiveRoot), name], { encoding: 'utf8' });
  assert.equal(packed.status, 0, packed.stderr);
  const checksum = createHash('sha256').update(await fs.readFile(archive)).digest('hex');
  await fs.writeFile(path.join(mirror, 'SHASUMS256.txt'), `${badChecksum ? '0'.repeat(64) : checksum}  ${name}.tar.gz\n`);
  const log = path.join(dir, 'curl.log');
  await fs.writeFile(path.join(utilities, 'curl'), `#!/bin/bash
set -eu
out='' url=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output) out="$2"; shift 2 ;;
    --proto|--proto-redir|--retry|--connect-timeout|--max-time) shift 2 ;;
    --*) shift ;;
    *) url="$1"; shift ;;
  esac
done
printf '%s\\n' "$url" >> "$FAKE_CURL_LOG"
if [ "\${FAKE_CURL_FAIL:-}" = 1 ]; then printf 'partial' > "$out"; exit 56; fi
cp "$FAKE_NODE_MIRROR/\${url##*/}" "$out"
`, { mode: 0o755 });
  const data = path.join(home, 'app data');
  const env = {
    HOME: home, PATH: utilities,
    PAINT_IT_BLACK_DATA_DIR: data,
    PAINT_IT_BLACK_NODE_DIST_URL: 'https://fixture.invalid/dist',
    PAINT_IT_BLACK_NODE_PLATFORM: 'Darwin', PAINT_IT_BLACK_NODE_ARCH: 'arm64',
    FAKE_NODE_MIRROR: mirror, FAKE_CURL_LOG: log,
  };
  const run = (extra = {}) => spawnSync('/bin/bash', ['-c', `
    set -euo pipefail
    source "$1"
    resume_tailor_bootstrap_node
    printf '%s\\n' "$NODE_BIN"
  `, 'node-bootstrap-test', path.join(scripts, 'bootstrap-node.sh')], {
    env: { ...env, ...extra }, encoding: 'utf8', timeout: 10_000,
  });
  return { dir, data, log, env, run, target: path.join(data, 'runtime', 'node', name) };
}

test('Node bootstrap reuses a compatible installation without downloading', async (t) => {
  const f = await fixture(t);
  const result = f.run({ NODE_BIN: process.execPath });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), await fs.realpath(process.execPath));
  assert.equal(await fs.access(f.log).then(() => true, () => false), false);
});

test('Node bootstrap verifies and atomically installs into per-user storage, then reuses offline', async (t) => {
  const f = await fixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `${f.target}/bin/node\n`);
  assert.match(result.stderr, /Downloading official Node/);
  assert.deepEqual((await fs.readFile(f.log, 'utf8')).trim().split('\n'), [
    `https://fixture.invalid/dist/v${version}/SHASUMS256.txt`,
    `https://fixture.invalid/dist/v${version}/${name}.tar.gz`,
  ]);
  assert.deepEqual(await fs.readdir(path.dirname(f.target)), [name]);
  const offline = f.run({ FAKE_CURL_FAIL: '1' });
  assert.equal(offline.status, 0, offline.stderr);
  assert.equal(offline.stdout, result.stdout);
  assert.equal((await fs.readFile(f.log, 'utf8')).trim().split('\n').length, 2);
});

test('Node checksum failure preserves an existing runtime and removes staging files', async (t) => {
  const f = await fixture(t, { badChecksum: true });
  await fs.mkdir(f.target, { recursive: true });
  await fs.writeFile(path.join(f.target, 'preserve.txt'), 'previous installation');
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /checksum verification failed/);
  assert.equal(await fs.readFile(path.join(f.target, 'preserve.txt'), 'utf8'), 'previous installation');
  assert.deepEqual(await fs.readdir(path.dirname(f.target)), [name]);
});

test('Node bootstrap rejects a verified archive with an escaping symlink', async (t) => {
  const f = await fixture(t, { unsafe: true });
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unsafe path or link/);
  assert.deepEqual(await fs.readdir(path.dirname(f.target)), []);
});

test('Node bootstrap download failures clean up without claiming success', async (t) => {
  const f = await fixture(t);
  const result = f.run({ FAKE_CURL_FAIL: '1' });
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
  assert.deepEqual(await fs.readdir(path.dirname(f.target)), []);
});

test('Node bootstrap rejects unsupported platforms before downloading', async (t) => {
  const f = await fixture(t);
  const result = f.run({ PAINT_IT_BLACK_NODE_PLATFORM: 'FreeBSD' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not support FreeBSD/);
  assert.equal(await fs.access(f.log).then(() => true, () => false), false);
});
