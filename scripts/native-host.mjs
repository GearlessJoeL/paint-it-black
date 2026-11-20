#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(SCRIPT_DIR, '..');
const START_SCRIPT = path.join(PROJECT_DIR, 'scripts', 'start-server.sh');
const PORT = Number(process.env.PORT || 8787);
const PING_URL = `http://127.0.0.1:${PORT}/api/ping`;
const LOG_DIR =
  process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Logs', 'resume-tailor')
    : path.join(os.homedir(), '.local', 'state', 'resume-tailor');

function readNativeMessage() {
  return new Promise((resolve) => {
    let header = Buffer.alloc(0);
    let expectedLen = null;
    const bodyChunks = [];
    let bodyLen = 0;

    const cleanup = () => {
      process.stdin.off('readable', onReadable);
      process.stdin.off('end', onEnd);
    };

    const onEnd = () => {
      cleanup();
      resolve(null);
    };

    const onReadable = () => {
      if (expectedLen === null) {
        const needed = 4 - header.length;
        const chunk = process.stdin.read(needed);
        if (!chunk) return;
        header = Buffer.concat([header, chunk]);
        if (header.length < 4) return;
        expectedLen = header.readUInt32LE(0);
        if (expectedLen <= 0 || expectedLen > 1024 * 1024) {
          cleanup();
          resolve(null);
          return;
        }
      }

      while (expectedLen !== null && bodyLen < expectedLen) {
        const chunk = process.stdin.read(expectedLen - bodyLen);
        if (!chunk) return;
        bodyChunks.push(chunk);
        bodyLen += chunk.length;
      }

      if (expectedLen !== null && bodyLen >= expectedLen) {
        cleanup();
        try {
          const text = Buffer.concat(bodyChunks).toString('utf8');
          resolve(JSON.parse(text));
        } catch {
          resolve({});
        }
      }
    };

    process.stdin.on('readable', onReadable);
    process.stdin.on('end', onEnd);
    onReadable();
  });
}

function writeNativeMessage(obj) {
  const json = Buffer.from(JSON.stringify(obj), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(json.length, 0);
  process.stdout.write(Buffer.concat([header, json]));
}

async function checkPing() {
  try {
    const res = await fetch(PING_URL, { signal: AbortSignal.timeout(1000) });
    return res.ok;
  } catch {
    return false;
  }
}

function wakeServer() {
  const uid = typeof process.getuid === 'function' ? process.getuid() : '';

  if (process.platform === 'darwin' && uid !== '') {
    const label = 'com.local.resume_tailor.server';
    const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
    try {
      execFileSync('launchctl', ['kickstart', '-k', `gui/${uid}/${label}`], { stdio: 'ignore' });
      return;
    } catch {
      try {
        if (fs.existsSync(plistPath)) {
          execFileSync('launchctl', ['bootstrap', `gui/${uid}`, plistPath], { stdio: 'ignore' });
          return;
        }
      } catch {
        // fall through to detached spawn
      }
    }
  } else if (process.platform === 'linux') {
    try {
      execFileSync('systemctl', ['--user', 'start', 'resume-tailor.service'], { stdio: 'ignore' });
      return;
    } catch {
      // fall through to detached spawn
    }
  }

  fs.mkdirSync(LOG_DIR, { recursive: true });
  const outFd = fs.openSync(path.join(LOG_DIR, 'server.log'), 'a');
  const child = spawn('/bin/bash', [START_SCRIPT], {
    cwd: PROJECT_DIR,
    detached: true,
    stdio: ['ignore', outFd, outFd],
  });
  child.unref();
}

async function main() {
  await readNativeMessage();

  if (await checkPing()) {
    writeNativeMessage({ ok: true, alreadyRunning: true, ready: true });
    return;
  }

  wakeServer();

  for (let i = 0; i < 30; i += 1) {
    await new Promise((r) => setTimeout(r, 400));
    if (await checkPing()) {
      writeNativeMessage({ ok: true, alreadyRunning: false, ready: true });
      return;
    }
  }

  writeNativeMessage({
    ok: false,
    ready: false,
    error: `Timed out waiting for companion server on 127.0.0.1:${PORT}`,
  });
}

main().catch((err) => {
  writeNativeMessage({ ok: false, ready: false, error: err?.message || 'Native host failed' });
  process.exit(1);
});
