import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const OWNER_MARKER = '.paint-it-black-companion.json';
const REQUIRED = [
  'server/index.mjs', 'scripts/install-autostart.sh', 'scripts/start-server.sh',
  'scripts/runtime.sh', 'package.json', 'package-lock.json',
  'resume-sample/resume.tex', 'extension/manifest.json', 'node_modules/pdf-parse/package.json',
];

async function exists(filename) {
  return fs.lstat(filename).then(() => true, (error) => {
    if (error.code === 'ENOENT') return false;
    throw error;
  });
}

/** Keep launchd and native messaging outside Downloads/Documents and independent
 * of the original ZIP/checkout. User resumes/config live alongside this tree. */
export async function installCompanion({
  sourceDir = fileURLToPath(new URL('../', import.meta.url)),
  dataDir = process.env.PAINT_IT_BLACK_DATA_DIR || path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'paint-it-black'),
  log = (message) => process.stderr.write(`${message}\n`),
} = {}) {
  const source = await fs.realpath(sourceDir);
  await fs.mkdir(path.resolve(dataDir), { recursive: true, mode: 0o700 });
  const directory = await fs.realpath(path.resolve(dataDir));
  const appDir = path.join(directory, 'companion');
  const targetInfo = await fs.lstat(appDir).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (targetInfo?.isSymbolicLink()) throw new Error('The companion destination must be a real directory, not a link to the downloaded source.');
  const canonicalTarget = await fs.realpath(appDir).catch((error) => {
    if (error.code === 'ENOENT') return appDir;
    throw error;
  });
  for (const filename of REQUIRED) {
    if (!await exists(path.join(source, filename))) {
      throw new Error(`Application prerequisite is missing: ${filename}. Rerun setup from the complete application source.`);
    }
  }
  if (source === canonicalTarget) return { appDir, updated: false };
  if (await exists(appDir)) {
    const owned = await fs.readFile(path.join(appDir, OWNER_MARKER), 'utf8')
      .then((value) => JSON.parse(value)?.owner === 'paint-it-black', () => false)
      .catch(() => false);
    if (!owned) throw new Error(`The existing directory ${appDir} is not managed by Paint It Black and was left unchanged.`);
  }
  const stage = await fs.mkdtemp(path.join(directory, '.companion-install-'));
  const stagedApp = path.join(stage, 'app');
  const backup = path.join(directory, `.companion-backup-${randomUUID()}`);
  let previousMoved = false;
  let published = false;
  try {
    await fs.mkdir(stagedApp);
    const copy = (entry) => fs.cp(path.join(source, entry), path.join(stagedApp, entry), {
      recursive: true,
      dereference: false,
      verbatimSymlinks: true,
      mode: constants.COPYFILE_FICLONE,
    });
    for (const entry of ['server', 'scripts', 'resume-sample', 'extension', 'node_modules']) await copy(entry);
    for (const entry of await fs.readdir(source)) {
      if (/^package(?:-[A-Za-z0-9_-]+)?\.json$/.test(entry)) await copy(entry);
    }
    for (const entry of ['Setup.command', 'README.md', 'LICENSE']) {
      if (await exists(path.join(source, entry))) await copy(entry);
    }
    for (const filename of REQUIRED) await fs.access(path.join(stagedApp, filename), constants.R_OK);
    await fs.writeFile(path.join(stagedApp, OWNER_MARKER), JSON.stringify({
      owner: 'paint-it-black', version: 1,
    }) + '\n', { mode: 0o600 });
    if (await exists(appDir)) {
      await fs.rename(appDir, backup);
      previousMoved = true;
    }
    try {
      await fs.rename(stagedApp, appDir);
      published = true;
    } catch (error) {
      if (previousMoved) {
        await fs.rename(backup, appDir);
        previousMoved = false;
      }
      throw error;
    }
    if (previousMoved) await fs.rm(backup, { recursive: true, force: true });
    log(`[paint-it-black] Installed the companion at ${appDir}.`);
    return { appDir, updated: true };
  } finally {
    await fs.rm(stage, { recursive: true, force: true });
    // A publish failure must never silently discard a previous installation.
    if (previousMoved && !published && !await exists(appDir)) await fs.rename(backup, appDir);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  installCompanion().then(({ appDir }) => process.stdout.write(`${appDir}\n`)).catch((error) => {
    process.stderr.write(`[paint-it-black] Companion installation failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
