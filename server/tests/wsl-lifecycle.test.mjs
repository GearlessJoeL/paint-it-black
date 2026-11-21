import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';

async function waitFor(check) {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Fixture lifecycle did not reach its expected state.');
}

const exists = (filename) => fs.access(filename).then(() => true, () => false);
const running = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paint-it-black-wsl-lifecycle-'));
  const home = path.join(root, 'Home');
  const project = path.join(root, 'companion');
  const scripts = path.join(project, 'scripts');
  const bin = path.join(root, 'bin');
  const proc = path.join(root, 'proc');
  const state = path.join(home, '.local', 'state', 'resume-tailor');
  for (const dir of [home, scripts, bin, proc, state]) await fs.mkdir(dir, { recursive: true });
  const autostart = (await fs.readFile(new URL('../../scripts/wsl-autostart.sh', import.meta.url), 'utf8'))
    .replaceAll('/proc/', proc + '/');
  await fs.writeFile(path.join(scripts, 'wsl-autostart.sh'), autostart);
  const uninstall = (await fs.readFile(new URL('../../scripts/uninstall-autostart.sh', import.meta.url), 'utf8'))
    .replaceAll('/proc/', proc + '/');
  await fs.writeFile(path.join(scripts, 'uninstall-autostart.sh'), uninstall);
  await fs.writeFile(path.join(scripts, 'runtime.sh'), 'resume_tailor_configure_runtime() { export NODE_BIN; }\n');
  await fs.writeFile(path.join(scripts, 'start-server.sh'), `#!/bin/bash
exec "$NODE_BIN" -e 'require("node:fs").writeFileSync(process.env.SERVER_PID_FILE,String(process.pid));setInterval(()=>{},1000)'
`, { mode: 0o755 });
  const mocks = {
    uname: '#!/bin/bash\nprintf "Linux\\n"\n',
    flock: '#!/bin/bash\nif [ -n "${FLOCK_MARKER:-}" ]; then mkdir "$FLOCK_MARKER" 2>/dev/null; else exit 0; fi\n',
    systemctl: '#!/bin/bash\nexit 1\n',
    curl: '#!/bin/bash\n[ -f "$SERVER_PID_FILE" ] && kill -0 "$(cat "$SERVER_PID_FILE")" 2>/dev/null\n',
    sleep: '#!/bin/bash\ncase "$1" in 0.25|0.3) exit 0 ;; *) exec /bin/sleep "$@" ;; esac\n',
  };
  for (const [name, text] of Object.entries(mocks)) await fs.writeFile(path.join(bin, name), text, { mode: 0o755 });
  const env = { HOME: home, PATH: `${bin}:/usr/bin:/bin`, NODE_BIN: process.execPath, SERVER_PID_FILE: path.join(root, 'server.pid') };
  t.after(async () => {
    const serverPid = Number(await fs.readFile(env.SERVER_PID_FILE, 'utf8').catch(() => '0'));
    if (serverPid > 1 && running(serverPid)) process.kill(serverPid, 'SIGTERM');
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, home, scripts, proc, state, env };
}

async function keepalive(t, f) {
  const script = path.join(f.scripts, 'wsl-autostart.sh');
  const child = spawn('/bin/bash', [script, '--keepalive'], { env: f.env, stdio: 'ignore' });
  t.after(() => { if (child.exitCode === null) child.kill('SIGTERM'); });
  await waitFor(() => exists(path.join(f.state, 'autostart.pid')));
  await waitFor(() => exists(f.env.SERVER_PID_FILE));
  const record = (await fs.readFile(path.join(f.state, 'autostart.pid'), 'utf8')).trim().split('\n');
  assert.equal(Number(record[0]), child.pid);
  assert.equal(record[1], script);
  const stat = await fs.stat(path.join(f.state, 'autostart.pid'));
  assert.equal(stat.mode & 0o777, 0o600);
  return child;
}

function uninstall(f) {
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/bash', [path.join(f.scripts, 'uninstall-autostart.sh')], { env: f.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, output }));
  });
}

test('WSL keepalive writes a private PID record after locking and cleans up its own fallback server', async (t) => {
  const f = await fixture(t);
  const child = await keepalive(t, f);
  const serverPid = Number(await fs.readFile(f.env.SERVER_PID_FILE, 'utf8'));
  assert.ok(running(serverPid));
  child.kill('SIGTERM');
  await waitFor(() => !running(child.pid));
  await waitFor(() => !running(serverPid));
  assert.equal(await exists(path.join(f.state, 'autostart.pid')), false);
});

test('WSL uninstall stops only its recorded matching process and preserves resumes and runtime data', async (t) => {
  const f = await fixture(t);
  const child = await keepalive(t, f);
  await fs.mkdir(path.join(f.proc, String(child.pid)), { recursive: true });
  await fs.writeFile(path.join(f.proc, String(child.pid), 'cmdline'), Buffer.from(`/bin/bash\0${path.join(f.scripts, 'wsl-autostart.sh')}\0--keepalive\0`));
  await fs.writeFile(path.join(f.state, 'wsl-launcher.sh'), 'prepared launcher');
  const resume = path.join(f.home, '.local', 'share', 'paint-it-black', 'resume', 'resume.tex');
  const runtime = path.join(f.home, '.local', 'share', 'paint-it-black', 'runtime', 'keep.txt');
  for (const filename of [resume, runtime]) { await fs.mkdir(path.dirname(filename), { recursive: true }); await fs.writeFile(filename, 'preserve'); }
  const result = await uninstall(f);
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /Stopping the registered WSL keepalive/);
  await waitFor(() => !running(child.pid));
  const serverPid = Number(await fs.readFile(f.env.SERVER_PID_FILE, 'utf8'));
  await waitFor(() => !running(serverPid));
  assert.equal(await exists(path.join(f.state, 'autostart.pid')), false);
  assert.equal(await exists(path.join(f.state, 'wsl-launcher.sh')), false);
  assert.equal(await fs.readFile(resume, 'utf8'), 'preserve');
  assert.equal(await fs.readFile(runtime, 'utf8'), 'preserve');
});

test('WSL uninstall does not signal a reused PID whose command line does not match the installed script', async (t) => {
  const f = await fixture(t);
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  t.after(() => unrelated.kill('SIGTERM'));
  await fs.writeFile(path.join(f.state, 'autostart.pid'), `${unrelated.pid}\n${path.join(f.scripts, 'wsl-autostart.sh')}\n`);
  await fs.mkdir(path.join(f.proc, String(unrelated.pid)), { recursive: true });
  await fs.writeFile(path.join(f.proc, String(unrelated.pid), 'cmdline'), Buffer.from('/usr/bin/node\0unrelated-app.mjs\0'));
  const result = await uninstall(f);
  assert.equal(result.code, 0, result.output);
  assert.doesNotMatch(result.output, /Stopping the registered WSL keepalive/);
  assert.equal(running(unrelated.pid), true);
});

test('duplicate WSL launchers wake the registered owner instead of starting an untracked server', async (t) => {
  const f = await fixture(t);
  f.env.FLOCK_MARKER = path.join(f.root, 'fixture-lock');
  const child = await keepalive(t, f);
  await fs.mkdir(path.join(f.proc, String(child.pid)), { recursive: true });
  await fs.writeFile(path.join(f.proc, String(child.pid), 'cmdline'), Buffer.from(`/bin/bash\0${path.join(f.scripts, 'wsl-autostart.sh')}\0--keepalive\0`));
  const oldServer = Number(await fs.readFile(f.env.SERVER_PID_FILE, 'utf8'));
  process.kill(oldServer, 'SIGTERM');
  await waitFor(() => !running(oldServer));
  const duplicate = spawn('/bin/bash', [path.join(f.scripts, 'wsl-autostart.sh'), '--keepalive'], { env: f.env, stdio: 'ignore' });
  t.after(() => { if (duplicate.exitCode === null) duplicate.kill('SIGTERM'); });
  await waitFor(async () => Number(await fs.readFile(f.env.SERVER_PID_FILE, 'utf8')) !== oldServer);
  const replacement = Number(await fs.readFile(f.env.SERVER_PID_FILE, 'utf8'));
  await waitFor(() => duplicate.exitCode !== null);
  assert.equal(duplicate.exitCode, 0);
  assert.equal(Number((await fs.readFile(path.join(f.state, 'autostart.pid'), 'utf8')).split('\n')[0]), child.pid);
  child.kill('SIGTERM');
  await waitFor(() => !running(replacement));
});
