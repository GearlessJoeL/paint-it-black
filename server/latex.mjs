import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

/**
 * Parse a pdflatex/latexmk .log file for page count, Overfull warnings, and errors.
 */
export function parseLatexLog(logText) {
  const text = String(logText || '');
  const lines = text.split(/\r?\n/);

  let pageCount = null;
  const pageMatch = text.match(/Output written on [^\n]*?\((\d+)\s+pages?,/i);
  if (pageMatch) {
    pageCount = Number(pageMatch[1]);
  }

  const overfullHbox = [];
  const overfullVbox = [];
  const errors = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    const hboxMatch = line.match(/Overfull \\hbox \(([\d.]+)pt too wide\)(.*)/);
    if (hboxMatch) {
      const pt = Number(hboxMatch[1]);
      const lineRef = hboxMatch[2]?.match(/lines?\s+([\d-]+)/)?.[1] || null;
      overfullHbox.push({ pt, line: lineRef, raw: line.trim() });
    }

    const vboxMatch = line.match(/Overfull \\vbox \(([\d.]+)pt too high\)/);
    if (vboxMatch) {
      overfullVbox.push({ pt: Number(vboxMatch[1]), raw: line.trim() });
    }

    if (line.startsWith('! ')) {
      const context = lines.slice(i, Math.min(lines.length, i + 4)).join(' | ').trim();
      errors.push(context);
    }
  }

  const maxOverfullHboxPt = overfullHbox.reduce((max, item) => Math.max(max, item.pt), 0);
  const maxOverfullVboxPt = overfullVbox.reduce((max, item) => Math.max(max, item.pt), 0);

  return {
    pageCount,
    overfullHbox,
    overfullVbox,
    maxOverfullHboxPt,
    maxOverfullVboxPt,
    errors,
    isOnePage: pageCount === 1,
    hasSevereOverfull: maxOverfullHboxPt > 12 || maxOverfullVboxPt > 8,
  };
}

function runCommand(binary, args, { cwd, env, signal, timeoutMs = 60_000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 2000).unref();
      }
    }, timeoutMs);

    const onAbort = () => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2000).unref();
    };

    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        child.kill('SIGTERM');
        reject(new Error('LaTeX compilation cancelled'));
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(err);
    });

    child.on('close', (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve({ exitCode: exitCode ?? 1, stdout, stderr });
    });
  });
}

/**
 * Compile a .tex file inside workDir using single-pass pdflatex first (~3x faster than latexmk),
 * automatically running a 2nd pass only if LaTeX requests cross-reference rerun, with latexmk fallback.
 */
export async function compileLatex({ workDir, texFilename = 'resume.tex', env, signal }) {
  const baseName = texFilename.replace(/\.tex$/i, '');
  const pdfPath = path.join(workDir, `${baseName}.pdf`);
  const logPath = path.join(workDir, `${baseName}.log`);

  let result;
  let compiler = 'pdflatex';
  try {
    result = await runCommand(
      'pdflatex',
      ['-interaction=nonstopmode', '-halt-on-error', texFilename],
      { cwd: workDir, env, signal },
    );

    if (result.exitCode === 0) {
      const firstLog = await fs.readFile(logPath, 'utf8').catch(() => '');
      if (/Rerun to get (?:cross-references|outlines|annotations) right/i.test(firstLog)) {
        result = await runCommand(
          'pdflatex',
          ['-interaction=nonstopmode', '-halt-on-error', texFilename],
          { cwd: workDir, env, signal },
        );
      }
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    compiler = 'latexmk';
    result = await runCommand(
      'latexmk',
      ['-pdf', '-g', '-interaction=nonstopmode', '-halt-on-error', texFilename],
      { cwd: workDir, env, signal },
    );
  }

  let logText = '';
  try {
    logText = await fs.readFile(logPath, 'utf8');
  } catch {
    logText = `${result.stdout}\n${result.stderr}`;
  }

  const logSummary = parseLatexLog(logText);

  let pdfExists = false;
  let pdfSizeBytes = 0;
  try {
    const stat = await fs.stat(pdfPath);
    pdfExists = stat.isFile() && stat.size > 0;
    pdfSizeBytes = stat.size;
  } catch {
    pdfExists = false;
  }

  const ok = result.exitCode === 0 && pdfExists && logSummary.errors.length === 0;

  return {
    ok,
    compiler,
    exitCode: result.exitCode,
    pdfPath,
    pdfSizeBytes,
    logPath,
    logSummary,
    stdoutTail: result.stdout.slice(-2500),
    stderrTail: result.stderr.slice(-1500),
  };
}

/**
 * Check whether pdflatex / latexmk is reachable with the given environment.
 */
export async function checkLatexToolchain(env) {
  for (const bin of ['pdflatex', 'latexmk']) {
    try {
      const res = await runCommand(bin, ['--version'], {
        cwd: process.cwd(),
        env,
        timeoutMs: 5000,
      });
      if (res.exitCode === 0) {
        const firstLine = (res.stdout || res.stderr).split(/\r?\n/)[0]?.trim() || bin;
        return { installed: true, compiler: bin, version: firstLine };
      }
    } catch {
      // try next
    }
  }
  return { installed: false, compiler: null, version: null };
}
