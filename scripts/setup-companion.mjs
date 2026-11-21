import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildToolEnv, listMasterResumes, loadConfig } from '../server/config.mjs';
import { ensureTex } from './provision-tex.mjs';

async function readSetup(filename) {
  try {
    const saved = JSON.parse(await fs.readFile(filename, 'utf8'));
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new Error('Invalid configuration');
    return saved;
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw new Error('The local setup configuration could not be read. Existing resume settings were preserved.');
  }
}

export async function prepareCompanion({
  dataDir = process.env.PAINT_IT_BLACK_DATA_DIR || path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'paint-it-black'),
  nodeBin = process.execPath,
  texArchive = process.env.PAINT_IT_BLACK_TEX_ARCHIVE,
  provisionTex = ensureTex,
  resolveConfig = loadConfig,
  log = (message) => process.stderr.write(`${message}\n`),
} = {}) {
  const directory = path.resolve(dataDir);
  const filename = path.join(directory, 'config.json');
  await readSetup(filename); // Refuse to overwrite a malformed existing config.
  const config = resolveConfig({ dataDir: directory });
  const existingMaster = config.resumeConfigured
    ? listMasterResumes(config.resumeRepoDir)[0]?.path : null;
  const templatePath = existingMaster || fileURLToPath(new URL('../resume-sample/resume.tex', import.meta.url));
  log('[paint-it-black] Preparing LaTeX and verifying a local resume compile...');
  const tex = await provisionTex({
    dataDir: directory, templatePath, env: buildToolEnv(config), log,
    ...(texArchive ? { archivePath: path.resolve(texArchive) } : {}),
  });
  if (!tex?.texBin || !path.isAbsolute(tex.texBin)) throw new Error('TeX setup did not return a usable compiler directory.');
  const canonicalNode = await fs.realpath(nodeBin);
  // Read again after potentially lengthy provisioning so a resume chosen in
  // an already-running companion is not replaced with an old snapshot.
  const saved = await readSetup(filename);
  const current = resolveConfig({ dataDir: directory });
  const next = {
    ...saved,
    nodeBin: canonicalNode,
    texBin: tex.texBin,
    texManaged: tex.managed === true,
    setupVersion: 1,
    resumeConfigured: current.resumeConfigured === true,
  };
  if (current.resumeConfigured) {
    next.resumeRepoDir = current.resumeRepoDir;
    next.resumeSource = current.resumeSource || 'user';
  } else if (!next.resumeSource) {
    next.resumeSource = null;
  }
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${filename}.tmp-${randomUUID()}`;
  try {
    await fs.writeFile(temporary, JSON.stringify(next, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await fs.rename(temporary, filename);
  } finally {
    await fs.rm(temporary, { force: true });
  }
  log(current.resumeConfigured
    ? '[paint-it-black] Prerequisites verified; your configured resume was preserved.'
    : '[paint-it-black] Prerequisites verified. Finish setup in Chrome by choosing your own PDF or LaTeX resume.');
  return next;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  prepareCompanion().catch((error) => {
    process.stderr.write(`[paint-it-black] Setup failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
