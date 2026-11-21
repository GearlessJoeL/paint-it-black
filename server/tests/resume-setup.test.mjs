import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createResumeSetup, MAX_RESUME_UPLOAD_BYTES } from '../resume-setup.mjs';
import { extractResumePdfText } from '../pdf-extract.mjs';

const LATEX = '\\documentclass{article}\n\\begin{document}Alex Example. Team member at Example Cafe, 2022--2025.\\end{document}\n';
const PDF = Buffer.from('%PDF-1.7\nfictional PDF fixture');
const FACTS = 'Alex Example\nalex@example.test\nExample Cafe, Team Member, 2022--2025\nServed customers and prepared orders.';
const upload = (format = 'tex', bytes = Buffer.from(LATEX)) => ({ filename: `my-resume.${format}`, format, contentBase64: bytes.toString('base64') });
const onePage = { ok: true, logSummary: { isOnePage: true, pageCount: 1, errors: [] } };

async function fixture(t, overrides = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'paint-it-black-resume-test-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const config = { dataDir, resumeRepoDir: '', resumeConfigured: false, resumeSource: 'unconfigured', extraPathDirs: [], ...overrides };
  const calls = [];
  const registry = { get: () => ({ runStructuredPrompt: async (options) => { calls.push(options); return { data: { latex: LATEX } }; } }) };
  const compileCalls = [];
  const compiler = async (options) => {
    compileCalls.push(options);
    await fs.writeFile(path.join(options.workDir, 'resume.pdf'), '%PDF-1.7 compiled fixture');
    await fs.writeFile(path.join(options.workDir, 'resume.aux'), 'compile scratch');
    return onePage;
  };
  const texPreparer = async () => ({ texBin: '/fictional/managed-tex/bin' });
  return { config, registry, calls, compileCalls, compiler, texPreparer, extractPdfText: async () => FACTS };
}

test('no resume is selected automatically, including when a TeX file happens to exist', async (t) => {
  const deps = await fixture(t);
  deps.config.resumeRepoDir = path.join(deps.config.dataDir, 'unselected');
  await fs.mkdir(deps.config.resumeRepoDir);
  await fs.writeFile(path.join(deps.config.resumeRepoDir, 'resume.tex'), LATEX);
  assert.equal((await createResumeSetup(deps).getStatus()).resumeConfigured, false);
});

test('LaTeX import prepares packages, compiles locally, and preserves prior files and settings', async (t) => {
  const deps = await fixture(t);
  const previous = path.join(deps.config.dataDir, 'previous');
  await fs.mkdir(previous);
  await fs.writeFile(path.join(previous, 'resume.tex'), 'Previous user resume');
  await fs.writeFile(path.join(deps.config.dataDir, 'config.json'), JSON.stringify({ unrelated: 'kept', resumeRepoDir: previous }));
  deps.config.resumeRepoDir = previous;
  let preflight;
  deps.texPreparer = async (options) => { preflight = options; return { texBin: '/fictional/managed-tex/bin' }; };
  const setup = createResumeSetup(deps);
  const result = await setup.importResume(upload());
  assert.equal(result.resumeConfigured, true);
  assert.notEqual(result.resumeRepoDir, previous);
  assert.equal(await fs.readFile(path.join(previous, 'resume.tex'), 'utf8'), 'Previous user resume');
  assert.equal(deps.calls.length, 0, 'TeX import must not invoke an AI agent');
  assert.equal(preflight.dataDir, deps.config.dataDir);
  assert.equal(preflight.env.openin_any, 'p');
  assert.equal(deps.compileCalls[0].env.openout_any, 'p');
  assert.equal(deps.compileCalls[0].env.shell_escape, 'f');
  assert.ok(deps.compileCalls[0].env.PATH.startsWith('/fictional/managed-tex/bin' + path.delimiter));
  assert.deepEqual((await fs.readdir(result.resumeRepoDir)).sort(), ['SKILL.md', 'original.tex.txt', 'resume.pdf', 'resume.tex']);
  const saved = JSON.parse(await fs.readFile(path.join(deps.config.dataDir, 'config.json'), 'utf8'));
  assert.equal(saved.unrelated, 'kept');
  assert.equal(saved.resumeSource, 'user');
  assert.equal(saved.texBin, '/fictional/managed-tex/bin');
  assert.equal(saved.resumeRepoDir, result.resumeRepoDir);
  assert.equal((await setup.getStatus()).resumeConfigured, true);
  const again = await setup.importResume(upload());
  assert.notEqual(again.resumeRepoDir, result.resumeRepoDir);
  assert.equal(await fs.readFile(path.join(result.resumeRepoDir, 'resume.tex'), 'utf8'), LATEX);
});

test('PDF conversion uses the selected backend and clean template, without persisting its API key', async (t) => {
  const deps = await fixture(t);
  const setup = createResumeSetup(deps);
  const result = await setup.importResume({ ...upload('pdf', PDF), agentId: 'api', apiProvider: 'openai', apiKey: 'test-secret-not-for-files', model: 'chosen-model', effort: 'medium' });
  assert.equal(deps.calls.length, 1);
  const call = deps.calls[0];
  assert.equal(call.apiConfig.apiKey, 'test-secret-not-for-files');
  assert.equal(call.model, 'chosen-model');
  assert.equal(call.effort, 'medium');
  assert.deepEqual(call.schema.required, ['latex']);
  assert.ok(call.prompt.includes(FACTS));
  assert.ok(call.prompt.includes('untrusted document data'));
  assert.ok(!call.prompt.includes('Jane Doe'));
  assert.ok(!call.prompt.includes('McDonald'));
  assert.ok(call.prompt.includes('\\titlespacing*{\\section}{0pt}{8pt}{5pt}'));
  const sectionFormat = call.prompt.match(/\\titleformat\{\\section\}[\s\S]*?(?=\\pdfgentounicode)/)?.[0];
  assert.ok(sectionFormat?.includes('\\titlerule'));
  assert.ok(!sectionFormat?.includes('\\vspace'), 'PDF section layout must not depend on compensating body spacing');
  assert.ok(!(await fs.readFile(path.join(deps.config.dataDir, 'config.json'), 'utf8')).includes('test-secret-not-for-files'));
  for (const name of await fs.readdir(result.resumeRepoDir)) {
    assert.ok(!(await fs.readFile(path.join(result.resumeRepoDir, name), 'utf8')).includes('test-secret-not-for-files'));
  }
  assert.equal(await fs.readFile(path.join(result.resumeRepoDir, 'original.pdf'), 'utf8'), PDF.toString());
});

test('PDF conversion repairs a two-page result with a bounded retry', async (t) => {
  const deps = await fixture(t);
  let count = 0;
  const compiler = deps.compiler;
  deps.compiler = async (options) => {
    await compiler(options);
    return ++count === 1 ? { ok: true, logSummary: { pageCount: 2, isOnePage: false } } : onePage;
  };
  await createResumeSetup(deps).importResume({ ...upload('pdf', PDF), agentId: 'codex' });
  assert.equal(count, 2);
  assert.equal(deps.calls.length, 2);
  assert.ok(deps.calls[1].prompt.includes('2 pages instead of one'));
  assert.ok(deps.calls[1].prompt.includes(FACTS));
});

test('PDF imports prepare packages again when repaired source changes its dependencies', async (t) => {
  const deps = await fixture(t);
  const prepared = [];
  deps.texPreparer = async (options) => {
    assert.equal(options.env.openin_any, 'p');
    assert.equal(options.env.openout_any, 'p');
    prepared.push(await fs.readFile(options.templatePath, 'utf8'));
    return { texBin: '/fictional/prepared-tex/bin' };
  };
  let modelCalls = 0;
  deps.registry.get = () => ({ runStructuredPrompt: async () => ({ data: { latex: ++modelCalls === 1 ? LATEX : LATEX.replace('\\begin{document}', '\\usepackage{enumitem}\n\\begin{document}') } }) });
  let compileCalls = 0;
  const compiler = deps.compiler;
  deps.compiler = async (options) => {
    assert.ok(options.env.PATH.startsWith('/fictional/prepared-tex/bin' + path.delimiter));
    await compiler(options);
    return ++compileCalls === 1 ? { ok: true, logSummary: { pageCount: 2, isOnePage: false } } : onePage;
  };
  await createResumeSetup(deps).importResume({ ...upload('pdf', PDF), agentId: 'codex' });
  assert.equal(prepared.length, 2);
  assert.ok(!prepared[0].includes('enumitem'));
  assert.ok(prepared[1].includes('\\usepackage{enumitem}'));
  assert.equal(deps.config.texBin, '/fictional/prepared-tex/bin');
});

test('PDF source errors discovered during preparation get repaired without masking runtime failures', async (t) => {
  const deps = await fixture(t);
  let prepares = 0;
  deps.texPreparer = async () => {
    if (++prepares === 1) throw new Error('The selected LaTeX resume did not compile. Fictional syntax failure.');
    return {};
  };
  await createResumeSetup(deps).importResume({ ...upload('pdf', PDF), agentId: 'codex' });
  assert.equal(deps.calls.length, 2);
  assert.equal(deps.compileCalls.length, 1);
  assert.ok(deps.calls[1].prompt.includes('Fictional syntax failure'));

  const failed = await fixture(t);
  failed.texPreparer = async () => { throw new Error('TinyTeX download checksum mismatch.'); };
  await assert.rejects(createResumeSetup(failed).importResume({ ...upload('pdf', PDF), agentId: 'codex' }), /checksum mismatch/);
  assert.equal(failed.calls.length, 1, 'runtime failures must not consume repair tokens');
  assert.equal(failed.compileCalls.length, 0);
});

test('failed conversion removes staging and leaves the configured resume unchanged', async (t) => {
  const deps = await fixture(t, { resumeRepoDir: '/existing/own/resume', resumeConfigured: true, resumeSource: 'user' });
  deps.compiler = async () => ({ ok: false, logSummary: { isOnePage: false, errors: ['Uncompilable fixture'] } });
  await assert.rejects(createResumeSetup(deps).importResume({ ...upload('pdf', PDF), agentId: 'claude' }), /could not be compiled/);
  assert.equal(deps.calls.length, 3);
  assert.equal(deps.config.resumeRepoDir, '/existing/own/resume');
  assert.deepEqual(await fs.readdir(path.join(deps.config.dataDir, 'resume')), []);
  await assert.rejects(fs.access(path.join(deps.config.dataDir, 'config.json')));
});

test('invalid uploads and incomplete TeX do not become configured resumes', async (t) => {
  const deps = await fixture(t);
  const setup = createResumeSetup(deps);
  await assert.rejects(setup.importResume({ ...upload(), format: 'docx' }), /Choose a PDF or LaTeX/);
  await assert.rejects(setup.importResume({ ...upload(), contentBase64: '$invalid' }), /empty, invalid/);
  await assert.rejects(setup.importResume(upload('pdf', Buffer.from('not a PDF'))), /not a valid PDF/);
  await assert.rejects(setup.importResume(upload('tex', Buffer.from('Only a fragment'))), /complete document/);
  await assert.rejects(setup.importResume(upload('tex', Buffer.alloc(MAX_RESUME_UPLOAD_BYTES + 1, 65))), /larger than 8 MB/);
  assert.equal((await setup.getStatus()).resumeConfigured, false);
  assert.equal(deps.calls.length, 0);
});

test('configuration failure rolls back the new import', async (t) => {
  const deps = await fixture(t);
  await fs.writeFile(path.join(deps.config.dataDir, 'config.json'), 'unreadable-json');
  await assert.rejects(createResumeSetup(deps).importResume(upload()), /configuration could not be read/);
  assert.equal(deps.config.resumeConfigured, false);
  assert.deepEqual(await fs.readdir(path.join(deps.config.dataDir, 'resume')), []);
});

test('persisted setup configuration must be an object and invalid values are preserved', async (t) => {
  for (const previous of ['null', '[]', '42', '"invalid"']) {
    const deps = await fixture(t);
    const filename = path.join(deps.config.dataDir, 'config.json');
    await fs.writeFile(filename, previous);
    await assert.rejects(createResumeSetup(deps).importResume(upload()), /must be a JSON object/);
    assert.equal(await fs.readFile(filename, 'utf8'), previous);
    assert.equal(deps.config.resumeConfigured, false);
    assert.deepEqual(await fs.readdir(path.join(deps.config.dataDir, 'resume')), []);
  }
});

test('PDF worker extracts the fictional sample with no external PDF tools', async () => {
  const bytes = await fs.readFile(new URL('../../resume-sample/resume.pdf', import.meta.url));
  const text = await extractResumePdfText(bytes);
  assert.ok(/Jane Doe/i.test(text));
  assert.ok(text.includes('McDonald'));
  await assert.rejects(extractResumePdfText(Buffer.from('%PDF-invalid')), /Could not read/);
});

test('uploaded and generated LaTeX cannot directly read files or hide unsafe primitives', async (t) => {
  const deps = await fixture(t);
  const unsafe = [
    '\\input{/private/secret}', '\\include{../../secret}', '\\openin1=/private/secret',
    '\\^^69nput{secret}', '\\csname input\\endcsname{secret}', '\\@@input{secret}',
    '\\ExplSyntaxOn\\file_input:n{secret}', '\\pdffiledump{secret}',
    '\\special{psfile=secret}', '\\usepackage{../../secret}', '\\begin{filecontents}{secret}data\\end{filecontents}',
    '% hidden after bare CR\r\\input{/private/secret}',
    '\\verb|%|\\input{/private/secret}',
  ];
  for (const payload of unsafe) {
    await assert.rejects(createResumeSetup(deps).importResume(upload('tex', Buffer.from(LATEX.replace('\\end{document}', payload + '\\end{document}')))), /unsupported|file access|package names|embedded file/);
  }
  deps.registry.get = () => ({ runStructuredPrompt: async () => ({ data: { latex: LATEX.replace('\\end{document}', '\\input{secret}\\end{document}') } }) });
  await assert.rejects(createResumeSetup(deps).importResume({ ...upload('pdf', PDF), agentId: 'codex' }), /file access/);
  assert.equal(deps.compileCalls.length, 0, 'unsafe source must be rejected before provisioning or compile');
});
