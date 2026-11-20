import { spawn } from 'node:child_process';
import http from 'node:http';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildToolEnv, loadConfig } from '../config.mjs';
import { checkLatexToolchain, compileLatex, parseLatexLog } from '../latex.mjs';
import { applyLatexSlots, extractLatexSlots, sanitizeLatexCommands } from '../latex-slots.mjs';
import { AntigravityCliAdapter, extractJsonObject, parseModelsOutput } from '../agents/antigravity.mjs';

test('parseLatexLog detects page count, overfull hbox/vbox, and errors', () => {
  const cleanLog = `
Overfull \\hbox (2.15pt too wide) in paragraph at lines 94--95
Output written on resume.pdf (1 page, 74210 bytes).
`;
  const parsedClean = parseLatexLog(cleanLog);
  assert.equal(parsedClean.pageCount, 1);
  assert.equal(parsedClean.isOnePage, true);
  assert.equal(parsedClean.overfullHbox.length, 1);
  assert.equal(parsedClean.overfullHbox[0].pt, 2.15);
  assert.equal(parsedClean.hasSevereOverfull, false);
  assert.equal(parsedClean.errors.length, 0);

  const brokenLog = `
! Undefined control sequence.
l.42 \\badmacro
Overfull \\hbox (18.4pt too wide) in paragraph at lines 50--51
Output written on resume.pdf (2 pages, 81200 bytes).
`;
  const parsedBroken = parseLatexLog(brokenLog);
  assert.equal(parsedBroken.pageCount, 2);
  assert.equal(parsedBroken.isOnePage, false);
  assert.equal(parsedBroken.hasSevereOverfull, true);
  assert.equal(parsedBroken.errors.length, 1);
});

test('antigravity output helpers extract structured JSON and model IDs', () => {
  assert.deepEqual(extractJsonObject('```json\n{"companyName":"Stripe"}\n```'), {
    companyName: 'Stripe',
  });
  assert.deepEqual(extractJsonObject('Here is the result:\n{"ok": true}\nThanks!'), { ok: true });

  const models = parseModelsOutput(`
Available models:
  gemini-3.7-pro    High reasoning
  gemini-3.7-flash  Fast default
`);
  assert.equal(models.length, 2);
  assert.equal(models[0].id, 'gemini-3.7-pro');
  assert.equal(models[1].id, 'gemini-3.7-flash');
});

test('AntigravityCliAdapter parses real agy stream-json init/step_update/result envelopes', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'resume-tailor-fake-agy-'));
  const fakeAgy = path.join(tmpDir, 'agy');
  const script = `#!/usr/bin/env node
console.log(JSON.stringify({ event: 'init', conversation_id: 'conv-42', init: { model: 'gemini-3.8-flash-low' } }));
console.log(JSON.stringify({ event: 'step_update', step_update: { conversation_id: 'conv-42', step_index: 2, state: 'ACTIVE', step_type: 'agent_response', text_delta: '{"tailoredLatex":' } }));
console.log(JSON.stringify({ event: 'result', result: { conversation_id: 'conv-42', status: 'SUCCESS', duration_seconds: 1.5, structured_output: { tailoredLatex: '\\\\documentclass{article}\\\\begin{document}OK\\\\end{document}', companyName: 'Acme' }, usage: { total_tokens: 99 } } }));
`;
  await fs.writeFile(fakeAgy, script, { mode: 0o755 });

  try {
    const adapter = new AntigravityCliAdapter({ binaryPath: fakeAgy, env: process.env });
    const events = [];
    const res = await adapter.runStructuredPrompt({
      prompt: 'test',
      schema: { type: 'object' },
      onEvent: (ev) => events.push(ev),
    });

    assert.equal(res.conversationId, 'conv-42');
    assert.deepEqual(res.usage, { total_tokens: 99 });
    assert.equal(res.data.companyName, 'Acme');
    assert.match(res.data.tailoredLatex, /\\documentclass/);
    assert.ok(events.some((e) => e.kind === 'status' && e.text.includes('gemini-3.8-flash-low')));
    assert.ok(events.some((e) => e.kind === 'status' && e.text.includes('SUCCESS')));
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('TeX Live compiles master resume.tex to strictly 1 page', async () => {
  const config = loadConfig();
  const env = buildToolEnv(config);
  const toolchain = await checkLatexToolchain(env);
  assert.equal(toolchain.installed, true, 'TeX Live must be installed in WSL');

  const masterPath = path.join(config.resumeRepoDir, 'resume.tex');
  const masterTex = await fs
    .readFile(masterPath, 'utf8')
    .catch(() => '\\documentclass{article}\\begin{document}Sample 1-page resume.\\end{document}\n');

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'resume-tailor-latex-test-'));
  try {
    await fs.writeFile(path.join(tmpDir, 'resume.tex'), masterTex, 'utf8');
    const result = await compileLatex({ workDir: tmpDir, texFilename: 'resume.tex', env });
    assert.equal(result.ok, true, `Compile failed: ${result.stdoutTail}`);
    assert.equal(result.logSummary.pageCount, 1);

    const header = (await fs.readFile(result.pdfPath)).subarray(0, 5).toString('ascii');
    assert.equal(header, '%PDF-');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('POSIX Chrome Native Messaging host speaks 4-byte framing and detects running server', async () => {
  const srv = http.createServer((req, res) => {
    if (req.url === '/api/ping') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const { port } = srv.address();

  try {
    const scriptPath = path.resolve(import.meta.dirname, '../../scripts/native-host.mjs');
    const reqJson = Buffer.from(JSON.stringify({ action: 'ensure_server' }), 'utf8');
    const frame = Buffer.alloc(4 + reqJson.length);
    frame.writeUInt32LE(reqJson.length, 0);
    reqJson.copy(frame, 4);

    const outBuf = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [scriptPath], {
        env: { ...process.env, PORT: String(port) },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const chunks = [];
      let stderr = '';
      child.stdout.on('data', (c) => chunks.push(c));
      child.stderr.on('data', (c) => {
        stderr += c.toString('utf8');
      });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code !== 0) reject(new Error(`native-host exited ${code}: ${stderr}`));
        else resolve(Buffer.concat(chunks));
      });
      child.stdin.end(frame);
    });

    assert.ok(outBuf.length >= 4, 'Expected 4-byte length prefix from native host');
    const msgLen = outBuf.readUInt32LE(0);
    const reply = JSON.parse(outBuf.subarray(4, 4 + msgLen).toString('utf8'));
    assert.equal(reply.ok, true);
    assert.equal(reply.alreadyRunning, true);
    assert.equal(reply.ready, true);
  } finally {
    await new Promise((resolve) => srv.close(resolve));
  }
});

test('extractLatexSlots and applyLatexSlots preserve immutable sections and fix double escapes', () => {
  const sampleTex = `\\documentclass{article}
\\begin{document}
\\section{Highlights}
\\resumeItemListStart
  \\resumeItem{Built \\textbf{Go} services achieving 99\\% uptime.}
\\resumeItemListEnd
\\section{Education}
\\resumeSubheading{Test University}{City}{B.Sc. CS}{2020 -- 2024}
\\section{Technical Skills}
\\begin{itemize}
  \\small{\\item{
    \\textbf{Languages}: Go, Python \\\\
    \\textbf{Cloud}: AWS
  }}
\\end{itemize}
\\end{document}`;

  const { slots, hasSlots } = extractLatexSlots(sampleTex);
  assert.equal(hasSlots, true);
  assert.deepEqual(
    slots.map((s) => s.id),
    ['B1', 'SKILLS'],
  );

  // Simulate accidental double backslashes from JSON output + unbalanced bad slot rejection
  const { latex, appliedCount, skippedIds } = applyLatexSlots(sampleTex, [
    { id: 'B1', latex: 'Engineered \\\\textbf{Kubernetes} microservices with \\\\textbf{Go}.' },
    { id: 'SKILLS', latex: '\\\\textbf{Languages}: Go, Rust \\\\\\\\\n\\\\textbf{Cloud}: AWS' },
    { id: 'BAD', latex: 'Missing { brace' },
  ]);

  assert.equal(appliedCount, 2);
  assert.deepEqual(skippedIds, ['BAD']);
  assert.match(latex, /\\textbf\{Kubernetes\} microservices with \\textbf\{Go\}\./);
  assert.doesNotMatch(latex, /\\\\textbf/);
  assert.match(latex, /\\section\{Education\}[\s\S]*2020 -- 2024/);
  assert.equal(sanitizeLatexCommands('```latex\n\\textbf{A} \\\\% test\n```'), '\\textbf{A} \\% test');
});

test('AntigravityCliAdapter reuses pre-warmed persistent stream-json worker across session turns', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'resume-tailor-persistent-agy-'));
  const fakeAgy = path.join(tmpDir, 'agy');
  const script = `#!/usr/bin/env node
const readline = require('node:readline');
if (process.argv[2] === 'models') {
  console.log('gemini-3.8-flash-low Fast\\n');
  process.exit(0);
}
console.log(JSON.stringify({ event: 'init', conversation_id: 'conv-persist', init: { model: 'gemini-3.8-flash-low' } }));
const rl = readline.createInterface({ input: process.stdin });
let turn = 0;
rl.on('line', (line) => {
  if (!line.trim()) return;
  turn += 1;
  const msg = JSON.parse(line);
  console.log(JSON.stringify({
    event: 'result',
    result: {
      conversation_id: 'conv-persist',
      status: 'SUCCESS',
      structured_output: {
        intent: turn === 1 ? 'generate' : 'qa',
        reply: 'pid:' + process.pid + ':turn:' + turn + ':' + msg.message.content,
        companyName: 'Acme',
        jobTitle: 'Backend Engineer',
        slots: [],
        tailoredLatex: turn === 1 ? '\\\\documentclass{article}\\\\begin{document}V1\\\\end{document}' : '',
      },
    },
  }));
});
`;
  await fs.writeFile(fakeAgy, script, { mode: 0o755 });

  const adapter = new AntigravityCliAdapter({ binaryPath: fakeAgy, env: process.env });
  const schema = { type: 'object', properties: { intent: { type: 'string' }, reply: { type: 'string' } } };

  try {
    await adapter.prewarm({ schema });
    const t1 = await adapter.runUnifiedTurn({ sessionKey: 'job-1', prompt: 'first', schema });
    assert.equal(adapter.isSessionSeeded('job-1'), true);
    const t2 = await adapter.runUnifiedTurn({ sessionKey: 'job-1', prompt: 'second', schema });

    const pid1 = t1.data.reply.split(':')[1];
    const pid2 = t2.data.reply.split(':')[1];
    assert.equal(pid1, pid2, 'Turn 2 must reuse the exact same live worker PID');
    assert.match(t1.data.reply, /:turn:1:first/);
    assert.match(t2.data.reply, /:turn:2:second/);
  } finally {
    adapter.dispose();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
