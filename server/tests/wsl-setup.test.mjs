import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';

function run(binary, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Fixture installer timed out.')); }, 10_000);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'paint-it-black-wsl-setup-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const home = path.join(directory, "Home & user's files");
  const project = path.join(directory, 'Companion source');
  const scripts = path.join(project, 'scripts');
  const mockBin = path.join(directory, 'mock bin');
  const appData = path.join(directory, 'Windows AppData', 'Roaming');
  const localAppData = path.join(directory, 'Windows AppData', 'Local');
  for (const dir of [home, scripts, mockBin, path.join(project, 'extension'), appData, localAppData]) await fs.mkdir(dir, { recursive: true });
  const installer = (await fs.readFile(new URL('../../scripts/install-autostart.sh', import.meta.url), 'utf8'))
    .replace('/proc/sys/fs/binfmt_misc/WSLInterop', path.join(directory, 'absent-wsl-marker'));
  await fs.writeFile(path.join(scripts, 'install-autostart.sh'), installer);
  await fs.copyFile(new URL('../../extension/manifest.json', import.meta.url), path.join(project, 'extension', 'manifest.json'));
  await fs.writeFile(path.join(scripts, 'runtime.sh'), 'resume_tailor_configure_runtime() { export NODE_BIN; }\n');
  for (const file of ['start-server.sh', 'native-host.mjs']) await fs.writeFile(path.join(scripts, file), '# fixture\n');
  await fs.writeFile(path.join(scripts, 'wsl-autostart.sh'), `#!/bin/bash
set -euo pipefail
"$NODE_BIN" -e 'require("node:fs").writeFileSync(process.env.WSL_ENV_TRACE, JSON.stringify({node:process.env.NODE_BIN,dataDir:process.env.PAINT_IT_BLACK_DATA_DIR,port:process.env.PORT,resume:process.env.RESUME_REPO_DIR,revisions:process.env.REVISIONS_DIR,args:process.argv.slice(1)}))' -- "$@"
`);
  const mocks = {
    uname: '#!/bin/bash\nprintf "Linux\\n"\n',
    id: '#!/bin/bash\nif [ "${1:-}" = -u ]; then printf "4242\\n"; else printf "fixture-user\\n"; fi\n',
    systemctl: '#!/bin/bash\nprintf "%s\\n" "$*" >> "$SYSTEMCTL_TRACE"\n[ "${SYSTEMD_AVAILABLE:-0}" = 1 ]\n',
    'cmd.exe': '#!/bin/bash\ncase "$*" in *%LOCALAPPDATA%*) printf "%s\\r\\n" "$FIX_WIN_LOCAL" ;; *) printf "%s\\r\\n" "$FIX_WIN_APP" ;; esac\n',
    wslpath: '#!/bin/bash\nif [ "$2" = "$FIX_WIN_LOCAL" ]; then printf "%s\\n" "$FIX_UNIX_LOCAL"; else printf "%s\\n" "$FIX_UNIX_APP"; fi\n',
    'reg.exe': '#!/bin/bash\nprintf "%s\\n" "$*" >> "$REGISTRY_TRACE"\n[ "$1" != query ]\n',
  };
  for (const [name, contents] of Object.entries(mocks)) await fs.writeFile(path.join(mockBin, name), contents, { mode: 0o755 });
  const server = http.createServer((_request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ ok: true, status: 'ok', platform: 'linux', isWsl: true, latex: { installed: true, compiler: 'fixture' }, agents: [] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const env = {
    HOME: home, PATH: `${mockBin}:/usr/bin:/bin`, NODE_BIN: process.execPath,
    PAINT_IT_BLACK_BOOTSTRAPPED: '1', PAINT_IT_BLACK_DATA_DIR: path.join(home, 'prepared data'),
    PORT: String(server.address().port), WSL_DISTRO_NAME: 'Ubuntu Fixture',
    RESUME_REPO_DIR: path.join(home, 'selected resume'), REVISIONS_DIR: path.join(home, 'draft revisions'),
    FIX_WIN_APP: "C:\\Users\\O'Brien User\\AppData\\Roaming", FIX_WIN_LOCAL: "C:\\Users\\O'Brien User\\AppData\\Local",
    FIX_UNIX_APP: appData, FIX_UNIX_LOCAL: localAppData,
    SYSTEMCTL_TRACE: path.join(directory, 'systemctl.log'), REGISTRY_TRACE: path.join(directory, 'registry.log'),
    WSL_ENV_TRACE: path.join(directory, 'wsl-environment.json'),
  };
  return { directory, home, project, scripts, appData, localAppData, env };
}

test('WSL setup without a systemd user bus emits Startup/native launchers and preserves prepared runtime settings', async (t) => {
  const f = await fixture(t);
  const result = await run('/bin/bash', [path.join(f.scripts, 'install-autostart.sh')], f.env);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /no systemd user bus/i);
  assert.match(result.stdout, /Windows \+ WSL auto-start setup complete/);
  assert.doesNotMatch(result.stdout, /systemd service:.*enabled & running/);
  assert.equal((await fs.readFile(f.env.SYSTEMCTL_TRACE, 'utf8')).trim(), '--user show-environment');
  const startup = path.join(f.appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'ResumeTailorWSL.vbs');
  const vbs = await fs.readFile(startup, 'utf8');
  assert.match(vbs, /wsl\.exe .*""-d"" ""Ubuntu Fixture""/);
  assert.match(vbs, /wsl-launcher\.sh/);
  const ps = await fs.readFile(path.join(f.localAppData, 'ResumeTailor', 'native-host.ps1'), 'utf8');
  assert.match(ps, /O''Brien User/);
  assert.match(ps, /-ArgumentList \$wslArgs/);
  assert.match(ps, new RegExp(`127\\.0\\.0\\.1:${f.env.PORT}/api/ping`));
  const nativeManifest = JSON.parse(await fs.readFile(path.join(f.localAppData, 'ResumeTailor', 'com.local.resume_tailor.launcher.json'), 'utf8'));
  assert.equal(nativeManifest.path, `${f.env.FIX_WIN_LOCAL}\\ResumeTailor\\native-host.cmd`);

  // Exercise the generated Linux-side launcher with a completely fresh
  // environment; the fixture target records values instead of starting WSL.
  const launcher = path.join(f.home, '.local', 'state', 'resume-tailor', 'wsl-launcher.sh');
  const launched = await run('/bin/bash', [launcher], { HOME: f.home, PATH: '/usr/bin:/bin', WSL_ENV_TRACE: f.env.WSL_ENV_TRACE });
  assert.equal(launched.code, 0, launched.stderr);
  assert.deepEqual(JSON.parse(await fs.readFile(f.env.WSL_ENV_TRACE)), {
    node: f.env.NODE_BIN, dataDir: f.env.PAINT_IT_BLACK_DATA_DIR, port: f.env.PORT,
    resume: f.env.RESUME_REPO_DIR, revisions: f.env.REVISIONS_DIR, args: ['--keepalive'],
  });
});

test('WSL with a working systemd user bus still installs its regular service', async (t) => {
  const f = await fixture(t);
  const result = await run('/bin/bash', [path.join(f.scripts, 'install-autostart.sh')], { ...f.env, SYSTEMD_AVAILABLE: '1' });
  assert.equal(result.code, 0, result.stderr);
  const calls = await fs.readFile(f.env.SYSTEMCTL_TRACE, 'utf8');
  assert.match(calls, /--user daemon-reload/);
  assert.match(calls, /--user restart resume-tailor\.service/);
  assert.match(result.stdout, /systemd service:.*enabled & running/);
  assert.doesNotMatch(result.stdout, /no systemd user bus/i);
});

test('ordinary Linux still fails clearly if its systemd service cannot be installed', async (t) => {
  const f = await fixture(t);
  const env = { ...f.env };
  delete env.WSL_DISTRO_NAME;
  const result = await run('/bin/bash', [path.join(f.scripts, 'install-autostart.sh')], env);
  assert.notEqual(result.code, 0);
  assert.match(await fs.readFile(f.env.SYSTEMCTL_TRACE, 'utf8'), /--user daemon-reload/);
  assert.doesNotMatch(result.stdout, /setup complete/);
  assert.deepEqual(await fs.readdir(f.appData), []);
});
