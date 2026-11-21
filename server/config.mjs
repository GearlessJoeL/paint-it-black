import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

function findFirstExecutable(candidates) {
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // try next
    }
  }
  return null;
}

function whichBinary(name) {
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  try {
    const out = execFileSync(cmd, [name], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split(/\r?\n/)[0]
      ?.trim();
    return out || null;
  } catch {
    return null;
  }
}

function hasAnyTexBinary(dir) {
  return (
    fs.existsSync(path.join(dir, 'pdflatex')) ||
    fs.existsSync(path.join(dir, 'latexmk')) ||
    fs.existsSync(path.join(dir, 'pdflatex.exe'))
  );
}

function discoverTexliveBinDirs() {
  const dirs = [];
  const home = os.homedir();

  // macOS MacTeX / BasicTeX symlink & Homebrew / Intel local bins
  for (const fixedDir of ['/Library/TeX/texbin', '/opt/homebrew/bin', '/usr/local/bin']) {
    if (fs.existsSync(fixedDir) && hasAnyTexBinary(fixedDir)) {
      dirs.push(fixedDir);
    }
  }

  // Standard TeX Live trees (~/texlive/<year>/bin/<arch> and /usr/local/texlive/<year>/bin/<arch>)
  for (const texliveRoot of [path.join(home, 'texlive'), '/usr/local/texlive']) {
    try {
      const years = fs.readdirSync(texliveRoot).sort().reverse();
      for (const year of years) {
        if (!/^\d{4}$/.test(year)) continue;
        const binParent = path.join(texliveRoot, year, 'bin');
        if (!fs.existsSync(binParent)) continue;
        for (const arch of fs.readdirSync(binParent)) {
          const candidate = path.join(binParent, arch);
          if (hasAnyTexBinary(candidate)) {
            dirs.push(candidate);
          }
        }
      }
    } catch {
      // ignore if tree does not exist
    }
  }
  return [...new Set(dirs)];
}

export function loadConfig(overrides = {}) {
  const home = os.homedir();
  const defaultDataDir = path.join(process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'paint-it-black');
  const dataDir = path.resolve(overrides.dataDir || process.env.PAINT_IT_BLACK_DATA_DIR || defaultDataDir);
  const setupConfigPath = path.join(dataDir, 'config.json');
  let setup = {};
  try { const saved = JSON.parse(fs.readFileSync(setupConfigPath, 'utf8')); if (saved && typeof saved === 'object' && !Array.isArray(saved)) setup = saved; } catch { /* First launch has no saved setup. */ }
  const explicitResume = overrides.resumeRepoDir || process.env.RESUME_REPO_DIR;
  const savedResume = typeof setup.resumeRepoDir === 'string' && setup.resumeRepoDir.trim()
    ? setup.resumeRepoDir : null;
  const legacyResume = dataDir === path.resolve(defaultDataDir) ? path.join(home, 'code', 'resume') : null;
  const hasResume = (dir) => { try { return Boolean(dir && listMasterResumes(dir).length); } catch { return false; } };
  // Keep a saved choice even if its file disappears; setup must request a new
  // selection instead of silently switching to a different legacy resume.
  const selectedResume = explicitResume || savedResume ||
    (hasResume(legacyResume) ? legacyResume : null);
  const host = overrides.host || process.env.HOST || '127.0.0.1';
  const port = Number(overrides.port || process.env.PORT || 8787);
  const resumeRepoDir = path.resolve(selectedResume || path.join(dataDir, 'resume'));
  const resumeConfigured = hasResume(selectedResume);
  const revisionsDir = path.resolve(
    overrides.revisionsDir ||
      process.env.REVISIONS_DIR ||
      (dataDir === path.resolve(defaultDataDir)
        ? path.join(home, '.local', 'state', 'resume-tailor', 'revisions')
        : path.join(dataDir, 'revisions')),
  );

  const managedTexRoot = path.join(dataDir, 'runtime', 'tex', 'bin');
  let managedTexDirs = [];
  try { managedTexDirs = fs.readdirSync(managedTexRoot).map((arch) => path.join(managedTexRoot, arch)).filter(hasAnyTexBinary); } catch { /* Runtime not installed yet. */ }
  const texliveDirs = [...new Set([setup.texBin, ...managedTexDirs, ...discoverTexliveBinDirs()].filter((dir) => typeof dir === 'string' && dir && hasAnyTexBinary(dir)))];
  const exeExt = process.platform === 'win32' ? '.exe' : '';
  const defaultAgyPath = path.join(home, '.gemini', 'bin', `agy${exeExt}`);
  const agyBin =
    findFirstExecutable([
      overrides.agyBin,
      process.env.AGY_BIN,
      defaultAgyPath,
      '/opt/homebrew/bin/agy',
      '/usr/local/bin/agy',
      '/Applications/Antigravity.app/Contents/Resources/app/bin/agy',
      whichBinary('agy'),
    ]) || defaultAgyPath;

  const defaultClaudePath = path.join(home, '.local', 'bin', `claude${exeExt}`);
  const claudeBin =
    findFirstExecutable([
      overrides.claudeBin,
      process.env.CLAUDE_BIN,
      defaultClaudePath,
      path.join(home, '.claude', 'local', `claude${exeExt}`),
      path.join(home, '.npm-global', 'bin', `claude${exeExt}`),
      '/opt/homebrew/bin/claude',
      '/usr/local/bin/claude',
      whichBinary('claude'),
    ]) || defaultClaudePath;

  const defaultCodexPath = path.join(home, '.local', 'bin', `codex${exeExt}`);
  const codexBin =
    findFirstExecutable([
      overrides.codexBin,
      process.env.CODEX_BIN,
      defaultCodexPath,
      path.join(home, '.npm-global', 'bin', `codex${exeExt}`),
      '/opt/homebrew/bin/codex',
      '/usr/local/bin/codex',
      whichBinary('codex'),
    ]) || defaultCodexPath;

  const extraPathDirs = [
    path.dirname(agyBin),
    path.dirname(claudeBin),
    path.dirname(codexBin),
    ...texliveDirs,
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/Library/TeX/texbin',
    path.join(home, '.local', 'bin'),
  ].filter(Boolean);

  return {
    host,
    port,
    dataDir,
    setupConfigPath,
    resumeConfigured,
    resumeSource: resumeConfigured ? 'user' : null,
    resumeRepoDir,
    revisionsDir,
    agyBin,
    claudeBin,
    codexBin,
    apiDefaults: {
      provider: overrides.apiProvider || process.env.API_PROVIDER || 'openai',
      baseUrl: overrides.apiBaseUrl || process.env.API_BASE_URL || '',
    },
    texliveDirs,
    extraPathDirs,
    maxRepairAttempts: Number(overrides.maxRepairAttempts ?? process.env.MAX_REPAIR_ATTEMPTS ?? 2),
  };
}

export function buildToolEnv(config) {
  const existingPath = process.env.PATH || process.env.Path || '';
  const merged = [...new Set([...config.extraPathDirs, ...existingPath.split(path.delimiter)])].filter(Boolean);
  return {
    ...process.env,
    PATH: merged.join(path.delimiter),
  };
}

export function listMasterResumes(resumeRepoDir) {
  if (!fs.existsSync(resumeRepoDir)) return [];
  const entries = fs.readdirSync(resumeRepoDir, { withFileTypes: true });
  const texFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.tex'))
    .map((entry) => entry.name)
    .sort((a, b) => {
      if (a === 'resume.tex') return -1;
      if (b === 'resume.tex') return 1;
      return a.localeCompare(b);
    });

  return texFiles.map((filename) => {
    let label = filename;
    let description = 'Custom LaTeX master';
    if (filename === 'resume.tex') {
      label = 'Primary resume (resume.tex)';
      description = 'Your editable resume master';
    } else if (filename === 'resume-parttime.tex') {
      label = 'Part-time / Service (resume-parttime.tex)';
      description = 'Part-time, retail, food service, and hospitality master';
    }
    return {
      filename,
      path: path.join(resumeRepoDir, filename),
      label,
      description,
    };
  });
}
