import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const projectDir = fileURLToPath(new URL('../../', import.meta.url));
const runtimePath = path.join(projectDir, 'scripts', 'runtime.sh');
const canonicalNode = await fs.realpath(process.execPath);

const shellQuote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;

async function symlinkNode(binDir) {
  await fs.mkdir(binDir, { recursive: true });
  await fs.symlink(canonicalNode, path.join(binDir, 'node'));
  return path.join(binDir, 'node');
}

async function createFixture(t) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'resume-runtime-')));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const home = path.join(dir, "Home & runtime 'fixtures'");
  const utilityBin = path.join(dir, 'utilities');
  await fs.mkdir(home, { recursive: true });
  await fs.mkdir(utilityBin);

  // Keep real shell utilities available without inheriting a developer's Node.
  for (const tool of ['dirname', 'basename', 'sort', 'find', 'head', 'tail', 'readlink', 'uname', 'sed', 'awk', 'cut', 'tr', 'ls', 'cat', 'pwd', 'realpath', 'chmod', 'mkdir', 'id', 'sleep']) {
    for (const prefix of ['/usr/bin', '/bin']) {
      const candidate = path.join(prefix, tool);
      if (await fs.access(candidate).then(() => true, () => false)) {
        await fs.symlink(candidate, path.join(utilityBin, tool));
        break;
      }
    }
  }

  // Redirect fixed system-install directories in a fixture copy so tests also
  // exercise discovery on hosts that have a separate Homebrew/system Node.
  let runtime = await fs.readFile(runtimePath, 'utf8');
  for (const hostBin of ['/opt/homebrew/bin', '/usr/local/bin', '/Library/TeX/texbin']) {
    runtime = runtime.replaceAll(hostBin, path.join(dir, 'host-install', hostBin));
  }
  runtime = runtime.replace(/(["'])\/(?:usr\/bin|bin)\1/g, (_match, quote) => `${quote}${utilityBin}${quote}`);
  const fixtureRuntime = path.join(dir, 'runtime.sh');
  await fs.writeFile(fixtureRuntime, runtime);

  return { dir, home, utilityBin, runtime: fixtureRuntime };
}

function configureRuntime(fixture, extraEnv = {}, command = `
    "$NODE_BIN" -e 'console.log(JSON.stringify({configured:process.env.NODE_BIN,node:process.execPath,firstPath:process.env.PATH.split(require("node:path").delimiter)[0]}))'
  `) {
  return spawnSync('/bin/bash', ['-c', `
    set -euo pipefail
    source "$1"
    resume_tailor_configure_runtime
    ${command}
  `, 'runtime-test', fixture.runtime], {
    env: { HOME: fixture.home, PATH: fixture.utilityBin, ...extraEnv },
    encoding: 'utf8',
    timeout: 10_000,
  });
}

function assertConfigured(result) {
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  // Parsing the complete output also catches unexpected stdout from discovery,
  // which would corrupt Chrome Native Messaging's length-prefixed protocol.
  assert.deepEqual(JSON.parse(result.stdout), {
    configured: canonicalNode,
    node: canonicalNode,
    firstPath: path.dirname(canonicalNode),
  });
}

async function createVersionNode(binDir, version) {
  await fs.mkdir(binDir, { recursive: true });
  const executable = path.join(binDir, 'node');
  const preload = path.join(binDir, 'version-node.cjs');
  await fs.writeFile(preload, `Object.defineProperty(process.versions, 'node', {value: ${JSON.stringify(version)}});\nObject.defineProperty(process, 'version', {value: ${JSON.stringify(`v${version}`)}});\nObject.defineProperty(process, 'execPath', {value: ${JSON.stringify(executable)}});\n`);
  await fs.writeFile(executable, `#!/bin/bash\nif [ "\${1:-}" = --version ] || [ "\${1:-}" = -v ]; then printf '%s\\n' ${shellQuote(`v${version}`)}; exit 0; fi\nexec ${shellQuote(canonicalNode)} --require ${shellQuote(preload)} "$@"\n`, { mode: 0o755 });
  return executable;
}

const createOldNode = (binDir) => createVersionNode(binDir, '18.20.0');

test('runtime canonicalizes a transient PATH symlink and exports Node for env shebangs', async (t) => {
  const fixture = await createFixture(t);
  const durableBin = path.join(fixture.dir, 'installation', 'bin');
  await symlinkNode(durableBin);
  const transientBin = path.join(fixture.dir, 'fnm_multishells', 'ephemeral', 'bin');
  await fs.mkdir(path.dirname(transientBin), { recursive: true });
  await fs.symlink(durableBin, transientBin);
  const extraEnv = { PATH: `${transientBin}:${fixture.utilityBin}` };
  assertConfigured(configureRuntime(fixture, extraEnv));
  const child = configureRuntime(fixture, extraEnv, `/usr/bin/env node -p 'process.execPath'`);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout.trim(), canonicalNode);
});

for (const [label, getRoot, getEnv] of [
  ['FNM_DIR', (f) => path.join(f.dir, 'custom fnm'), (_f, root) => ({ FNM_DIR: root })],
  ['XDG_DATA_HOME', (f) => path.join(f.dir, 'xdg data', 'fnm'), (_f, root) => ({ XDG_DATA_HOME: path.dirname(root) })],
  ['Linux fnm default', (f) => path.join(f.home, '.local', 'share', 'fnm'), () => ({})],
  ['macOS fnm default', (f) => path.join(f.home, 'Library', 'Application Support', 'fnm'), () => ({})],
  ['legacy fnm default', (f) => path.join(f.home, '.fnm'), () => ({})],
]) {
  test(`runtime discovers ${label} with a clean service PATH`, async (t) => {
    const fixture = await createFixture(t);
    const root = getRoot(fixture);
    const installation = path.join(root, 'node-versions', 'v24.21.0', 'installation');
    await symlinkNode(path.join(installation, 'bin'));
    await fs.mkdir(path.join(root, 'aliases'), { recursive: true });
    await fs.symlink(installation, path.join(root, 'aliases', 'default'));
    assertConfigured(configureRuntime(fixture, getEnv(fixture, root)));
  });
}

test('runtime falls back after a persisted Node installation is removed', async (t) => {
  const fixture = await createFixture(t);
  await symlinkNode(path.join(fixture.home, '.local', 'share', 'fnm', 'aliases', 'default', 'bin'));
  assertConfigured(configureRuntime(fixture, {
    NODE_BIN: path.join(fixture.dir, 'deleted fnm installation', 'bin', 'node'),
  }));
});

test('runtime rejects an old PATH Node and discovers a supported managed version', async (t) => {
  const fixture = await createFixture(t);
  const oldBin = path.join(fixture.dir, 'old-node');
  await createOldNode(oldBin);
  await symlinkNode(path.join(fixture.home, '.local', 'share', 'fnm', 'aliases', 'default', 'bin'));
  assertConfigured(configureRuntime(fixture, { PATH: `${oldBin}:${fixture.utilityBin}` }));
});

test('runtime validates explicit NODE_BIN instead of trusting executable permission', async (t) => {
  const fixture = await createFixture(t);
  const oldNode = await createOldNode(path.join(fixture.dir, 'old-node'));
  await symlinkNode(path.join(fixture.home, '.local', 'share', 'fnm', 'aliases', 'default', 'bin'));
  assertConfigured(configureRuntime(fixture, { NODE_BIN: oldNode }));
});

test('runtime reports a useful failure when only unsupported Node is available', async (t) => {
  const fixture = await createFixture(t);
  const oldBin = path.join(fixture.dir, 'old-node');
  const oldNode = await createOldNode(oldBin);
  const result = configureRuntime(fixture, { NODE_BIN: oldNode, PATH: `${oldBin}:${fixture.utilityBin}` });
  assert.ifError(result.error);
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /Node\.js.*(?:20|>=\s*20)/i);
});

test('runtime supports NVM_DIR and Volta installations without shell initialization', async (t) => {
  await t.test('NVM_DIR', async (subtest) => {
    const fixture = await createFixture(subtest);
    const nvmDir = path.join(fixture.dir, 'custom nvm');
    await symlinkNode(path.join(nvmDir, 'versions', 'node', 'v24.21.0', 'bin'));
    assertConfigured(configureRuntime(fixture, { NVM_DIR: nvmDir }));
  });
  await t.test('Volta', async (subtest) => {
    const fixture = await createFixture(subtest);
    await symlinkNode(path.join(fixture.home, '.volta', 'bin'));
    assertConfigured(configureRuntime(fixture));
  });
});

for (const manager of ['fnm', 'nvm']) {
  test(`runtime selects the numerically newest ${manager} version when no default exists`, async (t) => {
    const fixture = await createFixture(t);
    const root = manager === 'fnm'
      ? path.join(fixture.home, '.local', 'share', 'fnm', 'node-versions')
      : path.join(fixture.home, '.nvm', 'versions', 'node');
    const installationBin = (version) => manager === 'fnm'
      ? path.join(root, `v${version}`, 'installation', 'bin')
      : path.join(root, `v${version}`, 'bin');
    await createVersionNode(installationBin('24.9.0'), '24.9.0');
    const newest = await createVersionNode(installationBin('24.21.0'), '24.21.0');
    const result = configureRuntime(fixture);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      configured: newest,
      node: newest,
      firstPath: path.dirname(newest),
    });
  });
}

function runChild(file, args, { env, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Timed out running ${file}`));
    }, 15_000);
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', (status) => {
      clearTimeout(timeout);
      resolve({ status, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString() });
    });
    child.stdin.end(input);
  });
}

// The generated launchd plist uses only these standard plist value types.
// Parsing them here keeps the test portable without a Python/plutil dependency.
function parsePlist(xml) {
  const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  const decode = (value) => value.replace(/&(amp|lt|gt|quot|apos);/g, (_match, name) => entities[name]);
  const tokens = [...xml.matchAll(/<(dict|array)>|<\/(dict|array)>|<(key|string)>([\s\S]*?)<\/\3>|<(true|false)\s*\/>/g)];
  let cursor = 0;
  const parseValue = () => {
    const token = tokens[cursor++];
    assert.ok(token, 'Missing plist value');
    if (token[3] === 'string' || token[3] === 'key') return decode(token[4]);
    if (token[5]) return token[5] === 'true';
    assert.ok(token[1], `Unexpected plist token ${token[0]}`);
    const value = token[1] === 'dict' ? {} : [];
    while (tokens[cursor]?.[2] !== token[1]) {
      if (Array.isArray(value)) value.push(parseValue());
      else {
        assert.equal(tokens[cursor]?.[3], 'key');
        const key = parseValue();
        value[key] = parseValue();
      }
    }
    cursor += 1;
    return value;
  };
  const result = parseValue();
  assert.equal(cursor, tokens.length, 'Unconsumed plist values');
  return result;
}

test('macOS setup persists a durable runtime and native messaging survives the transient path disappearing', async (t) => {
  const fixture = await createFixture(t);
  const project = path.join(fixture.dir, "Project & 'quoted' path");
  const scripts = path.join(project, 'scripts');
  await fs.mkdir(scripts, { recursive: true });
  await fs.mkdir(path.join(project, 'extension'));
  for (const file of ['install-autostart.sh', 'start-server.sh', 'native-host.mjs', 'wsl-autostart.sh']) {
    await fs.copyFile(path.join(projectDir, 'scripts', file), path.join(scripts, file));
  }
  await fs.copyFile(fixture.runtime, path.join(scripts, 'runtime.sh'));
  await fs.copyFile(path.join(projectDir, 'extension', 'manifest.json'), path.join(project, 'extension', 'manifest.json'));

  // Every command that could mutate real services is replaced within this
  // fixture. The only process started is the installer under the fixture HOME.
  for (const [name, body] of [
    ['uname', "printf 'Darwin\\n'"],
    ['id', "printf '501\\n'"],
    ['launchctl', 'if [ "${1:-}" = print ]; then printf "state = %s\\n" "${MOCK_LAUNCHCTL_STATE:-running}"; fi\nexit 0'],
    ['pkill', 'exit 1'],
    ['sleep', 'exit 0'],
  ]) {
    const executable = path.join(fixture.utilityBin, name);
    await fs.rm(executable, { force: true });
    await fs.writeFile(executable, `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  }

  const fnmRoot = path.join(fixture.home, '.local', 'share', 'fnm');
  const durableBin = path.join(fnmRoot, 'node-versions', 'v24.21.0', 'installation', 'bin');
  await fs.mkdir(durableBin, { recursive: true });
  const installedNode = path.join(durableBin, 'node');
  // Copy (or clone on APFS) the executable so its canonical bin stays inside
  // the fixture. A system /usr/bin/node must not prepend real service tools
  // ahead of our mocks when this test runs on Linux.
  await fs.copyFile(canonicalNode, installedNode, constants.COPYFILE_FICLONE);
  await fs.mkdir(path.join(fnmRoot, 'aliases'), { recursive: true });
  await fs.symlink(path.dirname(durableBin), path.join(fnmRoot, 'aliases', 'default'));
  const transientBin = path.join(fixture.dir, 'fnm_multishells', 'temporary', 'bin');
  await fs.mkdir(path.dirname(transientBin), { recursive: true });
  await fs.symlink(durableBin, transientBin);

  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(req.url === '/api/health'
      ? { status: 'ok', platform: 'darwin', latex: { installed: true, compiler: 'pdflatex' }, agents: [] }
      : { ok: true }));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = String(server.address().port);
  const installed = await runChild('/bin/bash', [path.join(scripts, 'install-autostart.sh')], {
    env: { HOME: fixture.home, PATH: `${transientBin}:${fixture.utilityBin}`, PORT: port },
  });
  assert.equal(installed.status, 0, installed.stderr);
  assert.match(installed.stdout.toString(), /macOS auto-start setup complete/);

  const plist = parsePlist(await fs.readFile(path.join(fixture.home, 'Library', 'LaunchAgents', 'com.local.resume_tailor.server.plist'), 'utf8'));
  assert.equal(plist.WorkingDirectory, project);
  assert.deepEqual(plist.ProgramArguments, ['/bin/bash', path.join(scripts, 'start-server.sh')]);
  assert.equal(plist.EnvironmentVariables.NODE_BIN, installedNode);
  assert.equal(plist.EnvironmentVariables.PATH.split(':')[0], durableBin);
  assert.equal(plist.EnvironmentVariables.PORT, port);
  assert.equal(plist.RunAtLoad, true);
  assert.equal(plist.KeepAlive, true);

  const nativeManifest = JSON.parse(await fs.readFile(path.join(fixture.home, 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts', 'com.local.resume_tailor.launcher.json'), 'utf8'));
  assert.equal(nativeManifest.name, 'com.local.resume_tailor.launcher');
  assert.equal(nativeManifest.path, path.join(fixture.home, '.local', 'state', 'resume-tailor', 'native-host.sh'));
  assert.equal(nativeManifest.type, 'stdio');
  assert.match(nativeManifest.allowed_origins[0], /^chrome-extension:\/\/[a-p]{32}\/$/);

  await fs.rm(path.dirname(transientBin), { recursive: true });
  const inputJson = Buffer.from(JSON.stringify({ action: 'ensure_server' }));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(inputJson.length);
  const input = Buffer.concat([header, inputJson]);
  const checkNativeMessage = async () => {
    const result = await runChild('/bin/bash', [nativeManifest.path], {
      env: { HOME: fixture.home, PATH: fixture.utilityBin },
      input,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    const responseLength = result.stdout.readUInt32LE(0);
    assert.equal(result.stdout.length, responseLength + 4, 'Unexpected native messaging stdout');
    assert.deepEqual(JSON.parse(result.stdout.subarray(4).toString()), {
      ok: true, alreadyRunning: true, ready: true,
    });
  };
  await checkNativeMessage();

  // Simulate uninstalling the pinned Node after setup; runtime discovery must
  // recover using the fnm default rather than require reinstalling the host.
  const wrapper = await fs.readFile(nativeManifest.path, 'utf8');
  // %q shell escaping means matching the literal path requires escaping it
  // exactly as Bash did, rather than replacing its unescaped display form.
  const staleWrapper = wrapper.replace(/^export NODE_BIN=.*$/m, `export NODE_BIN=${shellQuote(path.join(fixture.dir, 'deleted-node'))}`);
  assert.notEqual(staleWrapper, wrapper);
  await fs.writeFile(nativeManifest.path, staleWrapper);
  await checkNativeMessage();
  assert.ok(requests.includes('/api/health'));
  assert.ok(requests.filter((url) => url === '/api/ping').length >= 3);

  const nonRunning = await runChild('/bin/bash', [path.join(scripts, 'install-autostart.sh')], {
    env: { HOME: fixture.home, PATH: fixture.utilityBin, PORT: port, MOCK_LAUNCHCTL_STATE: 'exited' },
  });
  assert.notEqual(nonRunning.status, 0);
  assert.match(nonRunning.stderr, /LaunchAgent is not running/);
  assert.doesNotMatch(nonRunning.stdout.toString(), /macOS auto-start setup complete/);
});
