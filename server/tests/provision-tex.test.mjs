import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ensureTex, tinyTexAsset, verifyTexArchive, missingLatexFile, texPackagesForFile } from '../../scripts/provision-tex.mjs';

async function fixture(t, { missingPackage = false, failInstall = false, oldRemoteYear = false } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'paint-it-black-tex-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const home = path.join(dir, "Home & user's data");
  const dataDir = path.join(home, 'app data');
  const source = path.join(dir, 'bundle', 'TinyTeX');
  const texBin = path.join(source, 'bin', 'test-platform');
  await fs.mkdir(texBin, { recursive: true });
  for (const tool of ['pdflatex', 'tlmgr']) await fs.writeFile(path.join(texBin, tool), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const archive = path.join(dir, 'fixture.tar.gz');
  const pack = spawnSync('/usr/bin/tar', ['-czf', archive, '-C', path.dirname(source), 'TinyTeX'], { encoding: 'utf8' });
  assert.equal(pack.status, 0, pack.stderr);
  const sha256 = createHash('sha256').update(await fs.readFile(archive)).digest('hex');
  const templatePath = path.join(dir, 'selected resume.tex');
  const template = '\\documentclass{extarticle}\n\\begin{document}User supplied resume.\\end{document}\n';
  await fs.writeFile(templatePath, template);
  const calls = [];
  let downloaded = 0;
  let packageReady = !missingPackage;
  const run = async (binary, args, options) => {
    calls.push({ binary, args });
    if (path.basename(binary) === 'tar') {
      const r = spawnSync('/usr/bin/tar', args, { encoding: 'utf8' });
      return { code: r.status, output: r.stdout + r.stderr };
    }
    if (path.basename(binary) === 'pdflatex') {
      assert.ok(args.includes('-no-shell-escape'));
      assert.equal(options.env.openin_any, 'p');
      assert.equal(options.env.openout_any, 'p');
      assert.equal(options.env.shell_escape, 'f');
      assert.equal(args.at(-1), 'preflight-source.tex');
      assert.ok(args.includes('-output-directory=.'));
      if (!packageReady) return { code: 1, output: "! LaTeX Error: File `newpackage.sty' not found." };
      const out = path.resolve(options.cwd, args.find((arg) => arg.startsWith('-output-directory=')).split('=').slice(1).join('='));
      await fs.writeFile(path.join(out, 'paint-it-black-preflight.pdf'), '%PDF-1.7\nfixture');
      return { code: 0, output: 'Output written on paint-it-black-preflight.pdf (1 page, 24 bytes).' };
    }
    assert.equal(path.basename(binary), 'tlmgr');
    if (oldRemoteYear && args[1] === 'https://mirrors.ctan.org/systems/texlive/tlnet') {
      return { code: 1, output: 'tlmgr: Local TeX Live (2026) is older than remote repository (2027).' };
    }
    if (args.includes('search')) return { code: 0, output: 'newpackage:\n\ttexmf-dist/tex/latex/newpackage/newpackage.sty\n' };
    if (args.includes('newpackage')) packageReady = true;
    return { code: failInstall ? 1 : 0, output: failInstall ? 'Network unavailable' : 'ready' };
  };
  const options = {
    dataDir, templatePath, env: { HOME: home, PATH: '/usr/bin:/bin' },
    run, log: () => {}, findExisting: async () => [],
    asset: { name: 'fixture.tar.gz', release: 'fixture', url: 'https://example.invalid/never-fetched', sha256 },
    download: async (_url, dest) => { downloaded += 1; await fs.copyFile(archive, dest); },
  };
  return { dir, home, dataDir, archive, templatePath, template, options, calls, downloads: () => downloaded };
}

test('TinyTeX release selection covers macOS universal and Linux/WSL architectures with pinned checksums', () => {
  assert.equal(tinyTexAsset('darwin', 'arm64').name, tinyTexAsset('darwin', 'x64').name);
  assert.match(tinyTexAsset('linux', 'x64').name, /linux-x86_64/);
  assert.match(tinyTexAsset('linux', 'arm64').name, /linux-arm64/);
  assert.match(tinyTexAsset('linux', 'x64', true).name, /linuxmusl-x86_64/);
  for (const platform of [['darwin', 'arm64'], ['linux', 'x64'], ['linux', 'arm64']]) {
    const asset = tinyTexAsset(...platform);
    assert.match(asset.sha256, /^[a-f0-9]{64}$/);
    assert.match(asset.url, /^https:\/\/github.com\/rstudio\/tinytex-releases\/releases\/download\/v2026\.11\//);
  }
  assert.throws(() => tinyTexAsset('win32', 'x64'), /not supported/);
});

test('TeX archive checksum mismatch is rejected before extraction or activation', async (t) => {
  const f = await fixture(t);
  await assert.rejects(verifyTexArchive(f.archive, '0'.repeat(64)), /checksum mismatch/);
  await assert.rejects(ensureTex({ ...f.options, asset: { ...f.options.asset, sha256: '0'.repeat(64) } }), /checksum mismatch/);
  assert.equal(f.calls.length, 0);
  assert.equal(await fs.access(path.join(f.dataDir, 'runtime', 'tex')).then(() => true, () => false), false);
});

test('fresh setup prepares portable TeX, resolves template packages, and atomically reuses it later', async (t) => {
  const f = await fixture(t, { missingPackage: true });
  const result = await ensureTex(f.options);
  assert.equal(result.managed, true);
  assert.equal(result.texBin, path.join(f.dataDir, 'runtime', 'tex', 'bin', 'test-platform'));
  assert.equal(f.downloads(), 1);
  assert.ok(f.calls.some((call) => call.args.includes('newpackage')));
  assert.ok(f.calls.some((call) => call.args.includes('--self')));
  assert.equal(await fs.readFile(f.templatePath, 'utf8'), f.template);
  const repeated = await ensureTex(f.options);
  assert.deepEqual(repeated, result);
  assert.equal(f.downloads(), 1);
  assert.deepEqual((await fs.readdir(path.join(f.dataDir, 'runtime'))).sort(), ['tex']);
});

test('a working existing compiler is reused after preflight without modifying it or downloading', async (t) => {
  const f = await fixture(t);
  const existingBin = path.join(f.dir, 'existing TeX', 'bin');
  await fs.mkdir(existingBin, { recursive: true });
  await fs.writeFile(path.join(existingBin, 'pdflatex'), '#!/bin/sh\n', { mode: 0o755 });
  const result = await ensureTex({ ...f.options, findExisting: async () => [existingBin] });
  assert.deepEqual(result, { texBin: existingBin, managed: false });
  assert.equal(f.downloads(), 0);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(await fs.readdir(existingBin), ['pdflatex']);
});

test('managed TeX remains managed when rediscovered through a PATH alias', async (t) => {
  const f = await fixture(t);
  const installed = await ensureTex(f.options);
  const alias = path.join(f.dir, 'saved compiler alias');
  await fs.symlink(installed.texBin, alias, 'dir');
  const reused = await ensureTex({ ...f.options, findExisting: async () => [alias] });
  assert.equal(reused.texBin, alias);
  assert.equal(reused.managed, true);
  assert.equal(f.downloads(), 1);
});

test('failed package preparation leaves the user template and existing installations unchanged', async (t) => {
  const f = await fixture(t, { failInstall: true });
  const unrelated = path.join(f.home, '.local', 'texlive', 'keep.txt');
  await fs.mkdir(path.dirname(unrelated), { recursive: true });
  await fs.writeFile(unrelated, 'user installation');
  await assert.rejects(ensureTex(f.options), /package preparation failed/);
  assert.equal(await fs.readFile(unrelated, 'utf8'), 'user installation');
  assert.equal(await fs.readFile(f.templatePath, 'utf8'), f.template);
  assert.deepEqual(await fs.readdir(path.join(f.dataDir, 'runtime')), []);
});

test('unowned TeX in the destination is not modified to repair missing packages', async (t) => {
  const f = await fixture(t, { missingPackage: true });
  const bin = path.join(f.dataDir, 'runtime', 'tex', 'bin', 'external');
  await fs.mkdir(bin, { recursive: true });
  await fs.writeFile(path.join(bin, 'pdflatex'), '#!/bin/sh\n', { mode: 0o755 });
  await assert.rejects(ensureTex(f.options), /not managed.*left unchanged/);
  assert.equal(f.downloads(), 0);
  assert.equal(f.calls.length, 1);
});

test('pinned TeX survives the annual repository change without user environment edits', async (t) => {
  const f = await fixture(t, { oldRemoteYear: true, missingPackage: true });
  const result = await ensureTex(f.options);
  assert.equal(result.managed, true);
  assert.ok(f.calls.some((call) => call.args.includes('https://ftp.math.utah.edu/pub/tex/historic/systems/texlive/2026/tlnet-final')));
  const marker = JSON.parse(await fs.readFile(path.join(f.dataDir, 'runtime', 'tex', '.paint-it-black-managed-tex.json')));
  assert.match(marker.repository, /2026\/tlnet-final$/);
});

test('missing-file resolution limits tlmgr searches to package basenames', () => {
  assert.equal(missingLatexFile("! LaTeX Error: File `extarticle.cls' not found."), 'extarticle.cls');
  assert.equal(missingLatexFile("I can't find file `glyphtounicode'."), 'glyphtounicode');
  assert.equal(missingLatexFile("! LaTeX Error: File `../../private.sty' not found."), null);
  assert.deepEqual(texPackagesForFile('tlmgr: package repository https://example.org\npreprint:\n\ttexmf-dist/tex/latex/preprint/fullpage.sty\nother:\n\ttexmf-dist/other.txt\n', 'fullpage.sty'), ['preprint']);
});
