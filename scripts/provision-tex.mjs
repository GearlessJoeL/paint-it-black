import fs from 'node:fs/promises';
import { createReadStream, createWriteStream, constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const RELEASE = 'v2026.11';
const RELEASE_URL = `https://github.com/rstudio/tinytex-releases/releases/download/${RELEASE}`;
const REPOSITORY = 'https://mirrors.ctan.org/systems/texlive/tlnet';
const OWNER_MARKER = '.paint-it-black-managed-tex.json';
const REQUIRED_PACKAGES = ['extsizes', 'preprint', 'titlesec', 'enumitem', 'fancyhdr', 'babel-english', 'setspace'];
const ASSETS = {
  darwin: ['TinyTeX-1-darwin-v2026.11.tar.xz', '9416a257c4caea2f82351fa2f89252b8bd75dceeb0ce6e442d25530b1922a02d'],
  'linux-x64': ['TinyTeX-1-linux-x86_64-v2026.11.tar.xz', '5b75befa848deae702ae6fa12ff0eef3f110d7e4e2a979ae99f101eba3c9c70d'],
  'linux-arm64': ['TinyTeX-1-linux-arm64-v2026.11.tar.xz', 'b351c365e4085a179c8d76fddadff612d4e4fd16a946953fb8b9d331f4f7344a'],
  'linux-musl-x64': ['TinyTeX-1-linuxmusl-x86_64-v2026.11.tar.xz', '4481aa5aeccebe37dc4270d12703ccfd75ac01e7490547be082b1c592092f9c2'],
};

export function tinyTexAsset(platform = process.platform, arch = process.arch, musl = false) {
  const key = platform === 'darwin' && ['arm64', 'x64'].includes(arch)
    ? 'darwin' : `${platform}-${musl ? 'musl-' : ''}${arch}`;
  const asset = ASSETS[key];
  if (!asset) throw new Error(`Automatic TeX installation is not supported on ${platform}/${arch}${musl ? '/musl' : ''}.`);
  return { name: asset[0], sha256: asset[1], url: `${RELEASE_URL}/${asset[0]}`, release: RELEASE };
}

export async function verifyTexArchive(archivePath, expectedSha256) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(archivePath)) hash.update(chunk);
  const actual = hash.digest('hex');
  if (actual !== expectedSha256) throw new Error('TinyTeX download checksum mismatch. Rerun setup to download it again.');
}

async function downloadArchive(url, destination) {
  const response = await fetch(url, { signal: AbortSignal.timeout(180_000) });
  if (!response.ok || !response.body) throw new Error(`TinyTeX download failed (HTTP ${response.status}).`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destination, { mode: 0o600 }));
}

async function runProcess(binary, args, { env, cwd, timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let settled = false;
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 1000).unref();
      finish(new Error(`${path.basename(binary)} timed out during local TeX setup.`));
    }, timeoutMs);
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(result);
    };
    const collect = (chunk) => { output = (output + chunk.toString('utf8')).slice(-32_768); };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', (error) => finish(error));
    child.on('close', (code) => finish(null, { code: code ?? 1, output }));
  });
}

async function executable(filename) {
  return fs.access(filename, constants.X_OK).then(() => true, () => false);
}

async function texBinIn(root) {
  const entries = await fs.readdir(path.join(root, 'bin'), { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const bin = path.join(root, 'bin', entry.name);
    if (await executable(path.join(bin, 'pdflatex'))) return bin;
  }
  return null;
}

function withTexBin(texBin, env) {
  return { ...env, PATH: `${texBin}${path.delimiter}${env.PATH || ''}` };
}

export function missingLatexFile(output) {
  const missing = String(output).match(/(?:LaTeX Error:\s*File|I can't find file)\s*[`'"]([^`'"\n]+)[`'"]/i)?.[1];
  // Only package-style basenames are sent to tlmgr, never paths or TeX source.
  return missing && /^[A-Za-z0-9][A-Za-z0-9_.+-]*$/.test(missing) ? missing : null;
}

export function texPackagesForFile(output, filename) {
  const result = new Set();
  let current = '';
  for (const line of String(output).split(/\r?\n/)) {
    const header = line.match(/^([a-z0-9][a-z0-9+_.-]*):\s*$/);
    if (header) current = header[1];
    else if (current && line.trim().endsWith(`/${filename}`)) result.add(current);
  }
  return [...result];
}

async function preflight(texBin, templatePath, env, run) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'paint-it-black-tex-check-'));
  try {
    // Compile a private copy using relative input/output filenames. Older TeX
    // releases enforce openin_any=p on absolute source paths, and uploads are
    // intentionally self-contained rather than allowed to read sibling files.
    const source = 'preflight-source.tex';
    const contents = templatePath
      ? await fs.readFile(templatePath)
      : '\\documentclass{article}\n\\begin{document}Compiler check.\\end{document}\n';
    await fs.writeFile(path.join(scratch, source), contents, { mode: 0o600 });
    const result = await run(path.join(texBin, 'pdflatex'), [
      '-interaction=nonstopmode', '-halt-on-error', '-no-shell-escape',
      '-output-directory=.', '-jobname=paint-it-black-preflight', source,
    ], {
      cwd: scratch,
      env: { ...withTexBin(texBin, env), openin_any: 'p', openout_any: 'p', shell_escape: 'f' },
      timeoutMs: 60_000,
    });
    const pdf = await fs.stat(path.join(scratch, 'paint-it-black-preflight.pdf')).catch(() => null);
    return { ok: result.code === 0 && Boolean(pdf?.size), output: result.output };
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
}

async function tlmgrCommand(texBin, args, env, run, manager) {
  const invoke = () => run(path.join(texBin, 'tlmgr'), ['--repository', manager.repository, ...args], {
    env: withTexBin(texBin, env), timeoutMs: 180_000,
  });
  let result = await invoke();
  const oldYear = result.output.match(/Local TeX Live\s*\((\d{4})\)\s+is older than remote repository/i)?.[1];
  if (result.code !== 0 && oldYear && manager.repository === REPOSITORY) {
    // TeX Live repositories change annually. Keep a pinned compiler usable
    // through the official frozen repository instead of requiring env edits.
    // https://tug.org/texlive/acquire.html#past
    manager.repository = `https://ftp.math.utah.edu/pub/tex/historic/systems/texlive/${oldYear}/tlnet-final`;
    result = await invoke();
  }
  return result;
}

async function managedPreflight(texBin, templatePath, env, run, log, manager = { repository: REPOSITORY }) {
  const triedFiles = new Set();
  for (let pass = 0; pass < 12; pass++) {
    const check = await preflight(texBin, templatePath, env, run);
    if (check.ok) return;
    const missing = missingLatexFile(check.output);
    if (!missing || triedFiles.has(missing)) {
      throw new Error(`The selected LaTeX resume did not compile. ${check.output.slice(-2000)}`);
    }
    triedFiles.add(missing);
    const pattern = `/${missing.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`;
    const search = await tlmgrCommand(texBin, ['search', '--global', '--file', pattern], env, run, manager);
    const packages = texPackagesForFile(search.output, missing);
    if (search.code !== 0 || packages.length === 0) {
      throw new Error(`The resume requires ${missing}, which is not available from TeX Live. Include any local template files and rerun setup.`);
    }
    log(`Installing LaTeX package for ${missing}…`);
    const install = await tlmgrCommand(texBin, ['install', ...packages], env, run, manager);
    if (install.code !== 0) throw new Error(`Could not install the LaTeX package for ${missing}. ${install.output.slice(-1000)}`);
  }
  throw new Error('The resume needs more LaTeX packages than setup could resolve. Rerun setup to continue.');
}

async function existingTexBins(env, managedRoot) {
  const home = env.HOME || os.homedir();
  const candidates = (env.PATH || '').split(path.delimiter).filter(Boolean).map((dir) => path.resolve(dir));
  candidates.push('/Library/TeX/texbin');
  for (const root of [managedRoot, path.join(home, '.TinyTeX'), path.join(home, 'Library', 'TinyTeX')]) {
    const bin = await texBinIn(root);
    if (bin) candidates.push(bin);
  }
  return [...new Set(candidates)].filter((dir) => !dir.startsWith(managedRoot + path.sep));
}

async function isManagedTexBin(texBin, managedRoot) {
  if (!await fs.access(path.join(managedRoot, OWNER_MARKER)).then(() => true, () => false)) return false;
  const [realBin, realRoot] = await Promise.all([fs.realpath(texBin), fs.realpath(managedRoot)]);
  const relative = path.relative(realRoot, realBin);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

/** Prepare a compatible pdfLaTeX without modifying global PATH or existing TeX. */
export async function ensureTex({
  dataDir, env = process.env, templatePath, log = (message) => process.stderr.write(`${message}\n`),
  archivePath, platform = process.platform, arch = process.arch, musl,
  run = runProcess, download = downloadArchive, asset: injectedAsset, findExisting = existingTexBins,
} = {}) {
  const home = env.HOME || os.homedir();
  dataDir = path.resolve(dataDir || env.PAINT_IT_BLACK_DATA_DIR || path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'paint-it-black'));
  const runtimeDir = path.join(dataDir, 'runtime');
  const target = path.join(runtimeDir, 'tex');
  if (templatePath) await fs.access(templatePath, constants.R_OK);
  for (const bin of await findExisting(env, target)) {
    if (!await executable(path.join(bin, 'pdflatex'))) continue;
    try {
      if ((await preflight(bin, templatePath, env, run)).ok) {
        return { texBin: bin, managed: await isManagedTexBin(bin, target) };
      }
    } catch { /* Try managed TeX instead of modifying someone else's install. */ }
  }
  const managedBin = await texBinIn(target);
  if (managedBin) {
    if (!await fs.access(path.join(target, OWNER_MARKER)).then(() => true, () => false)) {
      if ((await preflight(managedBin, templatePath, env, run)).ok) return { texBin: managedBin, managed: false };
      throw new Error(`The existing TeX directory at ${target} is not managed by Paint It Black and was left unchanged.`);
    }
    await managedPreflight(managedBin, templatePath, env, run, log);
    return { texBin: managedBin, managed: true };
  }

  if (!await executable('/usr/bin/perl') && !await Promise.any((env.PATH || '').split(path.delimiter).map(async (dir) => {
    if (!await executable(path.join(dir, 'perl'))) throw new Error('missing');
    return true;
  })).catch(() => false)) throw new Error('Perl is required by the portable TeX package manager, but was not found on this system.');
  if (musl === undefined && platform === 'linux') musl = !process.report.getReport().header.glibcVersionRuntime;
  const asset = injectedAsset || tinyTexAsset(platform, arch, musl);
  await fs.mkdir(runtimeDir, { recursive: true });
  const stage = await fs.mkdtemp(path.join(runtimeDir, 'tex-install-'));
  try {
    const archive = archivePath || path.join(stage, asset.name);
    if (!archivePath) {
      log(`Downloading portable TinyTeX (${asset.release}, about ${platform === 'darwin' ? '67' : '54'} MB)…`);
      await download(asset.url, archive);
    }
    await verifyTexArchive(archive, asset.sha256);
    const listing = await run('tar', ['-tf', archive], { env, timeoutMs: 30_000 });
    if (listing.code !== 0 || listing.output.split(/\r?\n/).some((name) => name.startsWith('/') || name.split('/').includes('..'))) {
      throw new Error('TinyTeX archive could not be safely inspected. Ensure tar/xz is available and rerun setup.');
    }
    const unpack = await run('tar', ['-xf', archive, '-C', stage], { env, timeoutMs: 90_000 });
    if (unpack.code !== 0) throw new Error(`TinyTeX extraction failed. Ensure tar/xz is available. ${unpack.output.slice(-500)}`);
    let extractedRoot;
    let texBin;
    for (const entry of await fs.readdir(stage, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const root = path.join(stage, entry.name);
      const bin = await texBinIn(root);
      if (bin) { extractedRoot = root; texBin = bin; break; }
    }
    if (!texBin) throw new Error('TinyTeX archive contains no usable pdfLaTeX compiler.');
    log('Preparing LaTeX resume packages…');
    const manager = { repository: REPOSITORY };
    for (const args of [['update', '--self'], ['install', ...REQUIRED_PACKAGES]]) {
      const result = await tlmgrCommand(texBin, args, env, run, manager);
      if (result.code !== 0) throw new Error(`TinyTeX package preparation failed. ${result.output.slice(-1200)}`);
    }
    await managedPreflight(texBin, templatePath, env, run, log, manager);
    await fs.writeFile(path.join(extractedRoot, OWNER_MARKER), JSON.stringify({ release: asset.release, sha256: asset.sha256, repository: manager.repository }) + '\n');
    // Never remove another TeX installation; an incomplete owned destination
    // needs an explicit repair rather than silently overwriting arbitrary data.
    if (await fs.stat(target).catch(() => null)) throw new Error(`A TeX directory already exists at ${target}. It was left unchanged.`);
    await fs.rename(extractedRoot, target);
    const installedBin = await texBinIn(target);
    log('Portable LaTeX is ready.');
    return { texBin: installedBin, managed: true };
  } finally {
    await fs.rm(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const options = {};
  for (let index = 2; index < process.argv.length; index++) {
    const flag = process.argv[index];
    if (flag === '--data-dir') options.dataDir = process.argv[++index];
    else if (flag === '--template') options.templatePath = process.argv[++index];
    else if (flag === '--archive') options.archivePath = process.argv[++index];
    else throw new Error(`Unknown option: ${flag}`);
  }
  ensureTex(options).then((result) => process.stdout.write(JSON.stringify(result) + '\n')).catch((error) => {
    process.stderr.write(`Local TeX setup failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
