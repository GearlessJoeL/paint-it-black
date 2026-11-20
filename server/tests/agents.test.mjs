import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AntigravityCliAdapter, groupModelsByEffort } from '../agents/antigravity.mjs';
import { DirectApiAdapter } from '../agents/api-key.mjs';
import { ClaudeCodeCliAdapter } from '../agents/claude-code.mjs';
import { CodexCliAdapter, toStrictOpenAiSchema } from '../agents/codex.mjs';
import { buildChatPrompt, needsFullLatexEdit } from '../prompt-builder.mjs';

test('needsFullLatexEdit switches chat prompt to full LaTeX for structural section/role edits while keeping fast slot mode for bullet tweaks', () => {
  assert.equal(needsFullLatexEdit('you have to remove publication section, add a new item in work experience'), true);
  assert.equal(needsFullLatexEdit('delete the Projects section and add a bullet under my first role'), true);
  assert.equal(needsFullLatexEdit('change my graduation date to 2026'), true);
  assert.equal(needsFullLatexEdit('make bullet 2 shorter and emphasize Kubernetes'), false);
  assert.equal(needsFullLatexEdit('what skills am I missing for this job?'), false);

  const sampleTex = '\\documentclass{article}\n\\begin{document}\n\\section{Publications}Foo\n\\end{document}';
  const sampleSlots = [{ id: 'B1', label: 'Work', content: 'Built X' }];

  const structuralPrompt = buildChatPrompt({
    masterFilename: 'resume.tex',
    masterLatex: sampleTex,
    currentLatex: sampleTex,
    slots: sampleSlots,
    hasDraft: true,
    sessionSeeded: true,
    userMessage: 'remove publication section, add a new item in work experience',
  });
  assert.match(structuralPrompt, /FULL LATEX EDIT MODE/);
  assert.match(structuralPrompt, /\\section\{Publications\}/);

  const bulletPrompt = buildChatPrompt({
    masterFilename: 'resume.tex',
    masterLatex: sampleTex,
    currentLatex: sampleTex,
    slots: sampleSlots,
    hasDraft: true,
    sessionSeeded: true,
    userMessage: 'make bullet 1 shorter',
  });
  assert.doesNotMatch(bulletPrompt, /FULL LATEX EDIT MODE/);
  assert.match(bulletPrompt, /\[B1\]/);
});

test('groupModelsByEffort separates Antigravity models from effort tiers and resolves variants cleanly', () => {
  const raw = [
    { id: 'gemini-4-neon-high', label: 'gemini-4-neon-high (Gemini 4 Neon (High))' },
    { id: 'gemini-4-neon-xhigh', label: 'gemini-4-neon-xhigh (Gemini 4 Neon (XHigh))' },
    { id: 'gemini-4-neon-low', label: 'gemini-4-neon-low (Gemini 4 Neon (Low))' },
    { id: 'claude-sonnet-5-5-medium', label: 'claude-sonnet-5-5-medium (Claude Sonnet 5.5 (Medium))' },
    { id: 'claude-sonnet-5-5-high', label: 'claude-sonnet-5-5-high (Claude Sonnet 5.5 (High))' },
    { id: 'gemini-pro-orchestrator-neon', label: 'gemini-pro-orchestrator-neon (Orchestrator (Neon))' },
  ];
  const grouped = groupModelsByEffort(raw);
  assert.equal(grouped.length, 3);
  assert.equal(grouped[0].id, 'gemini-4-neon');
  assert.equal(grouped[0].label, 'Gemini 4 Neon');
  assert.deepEqual(grouped[0].efforts, ['low', 'high', 'xhigh']);
  assert.deepEqual(grouped[2].efforts, []);

  const adapter = new AntigravityCliAdapter({ binaryPath: '/nonexistent/agy', env: {} });
  adapter.lastKnownModels = grouped;

  // Base model + chosen effort resolves to the exact variant without passing --effort
  assert.deepEqual(adapter.resolveModelAndEffort({ model: 'gemini-4-neon', effort: 'xhigh' }), {
    modelArg: 'gemini-4-neon-xhigh',
    effortArg: '',
  });
  // Unsupported effort gracefully falls back to nearest valid tier
  assert.deepEqual(adapter.resolveModelAndEffort({ model: 'claude-sonnet-5-5', effort: 'xhigh' }), {
    modelArg: 'claude-sonnet-5-5-high',
    effortArg: '',
  });
  // Legacy suffixed model ID respects explicit effort override without conflict
  assert.deepEqual(adapter.resolveModelAndEffort({ model: 'gemini-4-neon-high', effort: 'low' }), {
    modelArg: 'gemini-4-neon-low',
    effortArg: '',
  });
  // Tierless orchestrator model omits --effort
  assert.deepEqual(adapter.resolveModelAndEffort({ model: 'gemini-pro-orchestrator-neon', effort: 'high' }), {
    modelArg: 'gemini-pro-orchestrator-neon',
    effortArg: '',
  });
  // cli-default passes --effort through
  assert.deepEqual(adapter.resolveModelAndEffort({ model: 'cli-default', effort: 'low' }), {
    modelArg: '',
    effortArg: 'low',
  });
});

test('toStrictOpenAiSchema adds additionalProperties=false and requires all keys recursively', () => {
  const input = {
    type: 'object',
    required: ['intent'],
    properties: {
      intent: { type: 'string' },
      slots: {
        type: 'array',
        items: {
          type: 'object',
          properties: { id: { type: 'string' }, latex: { type: 'string' } },
        },
      },
    },
  };
  const strict = toStrictOpenAiSchema(input);
  assert.equal(strict.additionalProperties, false);
  assert.deepEqual(strict.required, ['intent', 'slots']);
  assert.equal(strict.properties.slots.items.additionalProperties, false);
  assert.deepEqual(strict.properties.slots.items.required, ['id', 'latex']);
});

test('ClaudeCodeCliAdapter parses structured_output and resumes session_id across turns', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rt-claude-test-'));
  const fakeClaude = path.join(tmpDir, 'claude');
  const script = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log('2.1.0 (Claude Code)');
  process.exit(0);
}
const prompt = fs.readFileSync(0, 'utf8');
const resumeIdx = args.indexOf('--resume');
const resumed = resumeIdx !== -1 ? args[resumeIdx + 1] : '';
console.log(JSON.stringify({
  is_error: false,
  session_id: resumed || 'claude-sess-99',
  structured_output: {
    intent: resumed ? 'qa' : 'generate',
    reply: 'resumed:' + resumed + '|prompt:' + prompt.trim(),
    companyName: 'Acme',
    jobTitle: 'Backend Engineer',
    slots: [],
    tailoredLatex: resumed ? '' : '\\\\documentclass{article}\\\\begin{document}OK\\\\end{document}',
  },
}));
`;
  await fs.writeFile(fakeClaude, script, { mode: 0o755 });

  const adapter = new ClaudeCodeCliAdapter({ binaryPath: fakeClaude, env: process.env });
  const schema = { type: 'object', properties: { intent: { type: 'string' }, reply: { type: 'string' } } };

  try {
    const status = await adapter.checkStatus();
    assert.equal(status.installed, true);
    assert.equal(status.authenticated, true);

    const t1 = await adapter.runUnifiedTurn({ sessionKey: 'k1', prompt: 'first', schema, model: 'haiku' });
    assert.equal(t1.conversationId, 'claude-sess-99');
    assert.equal(adapter.isSessionSeeded('k1', { model: 'haiku' }), true);

    const t2 = await adapter.runUnifiedTurn({ sessionKey: 'k1', prompt: 'second', schema, model: 'haiku' });
    assert.match(t2.data.reply, /^resumed:claude-sess-99\|prompt:second$/);
  } finally {
    adapter.dispose();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('CodexCliAdapter runs codex exec with strict schema file and reads -o output', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rt-codex-test-'));
  const fakeCodex = path.join(tmpDir, 'codex');
  const script = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log('codex-cli 0.45.0');
  process.exit(0);
}
const schemaPath = args[args.indexOf('--output-schema') + 1];
const outPath = args[args.indexOf('-o') + 1];
const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
const prompt = fs.readFileSync(0, 'utf8').trim();
const payload = {
  intent: 'generate',
  reply: 'strictKeys:' + schema.required.join(',') + '|prompt:' + prompt,
  companyName: 'Stripe',
  jobTitle: 'SWE',
};
fs.writeFileSync(outPath, JSON.stringify(payload), 'utf8');
`;
  await fs.writeFile(fakeCodex, script, { mode: 0o755 });

  const adapter = new CodexCliAdapter({ binaryPath: fakeCodex, env: process.env });
  const schema = {
    type: 'object',
    required: ['intent'],
    properties: {
      intent: { type: 'string' },
      reply: { type: 'string' },
      companyName: { type: 'string' },
      jobTitle: { type: 'string' },
    },
  };

  try {
    const status = await adapter.checkStatus();
    assert.equal(status.installed, true);
    const res = await adapter.runStructuredPrompt({ prompt: 'tailor now', schema, model: 'gpt-5.4' });
    assert.equal(res.data.companyName, 'Stripe');
    assert.match(res.data.reply, /strictKeys:intent,reply,companyName,jobTitle\|prompt:tailor now/);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('DirectApiAdapter supports OpenAI, Anthropic, and Gemini APIs with session history and auth checks', async () => {
  const seenRequests = [];
  const srv = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk.toString('utf8');
    const body = raw ? JSON.parse(raw) : {};
    seenRequests.push({ url: req.url, headers: req.headers, body });

    if (req.url.endsWith('/chat/completions')) {
      if (req.headers.authorization === 'Bearer bad-key') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end('{"error":"invalid key"}');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  intent: 'qa',
                  reply: `openai-msgs:${body.messages.length}`,
                }),
              },
            },
          ],
          usage: { total_tokens: 42 },
        }),
      );
      return;
    }

    if (req.url.endsWith('/v1/messages')) {
      assert.equal(req.headers['x-api-key'], 'ant-test-key');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          content: [{ type: 'text', text: JSON.stringify({ intent: 'qa', reply: 'anthropic-ok' }) }],
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
      );
      return;
    }

    if (req.url.includes(':generateContent')) {
      assert.match(req.url, /key=gem-test-key/);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [{ text: JSON.stringify({ intent: 'qa', reply: 'gemini-ok' }) }],
              },
            },
          ],
        }),
      );
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const { port } = srv.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  const adapter = new DirectApiAdapter({ env: {} });
  const schema = { type: 'object', required: ['intent', 'reply'], properties: { intent: { type: 'string' }, reply: { type: 'string' } } };

  try {
    // 1. OpenAI multi-turn session reuse
    const o1 = await adapter.runUnifiedTurn({
      sessionKey: 's1',
      prompt: 'turn 1',
      schema,
      model: 'gpt-4o-mini',
      apiConfig: { provider: 'openai', apiKey: 'sk-test', baseUrl: `${baseUrl}/v1` },
    });
    assert.equal(o1.data.reply, 'openai-msgs:2');
    assert.equal(
      adapter.isSessionSeeded('s1', {
        model: 'gpt-4o-mini',
        apiConfig: { provider: 'openai', baseUrl: `${baseUrl}/v1` },
      }),
      true,
    );

    const o2 = await adapter.runUnifiedTurn({
      sessionKey: 's1',
      prompt: 'turn 2',
      schema,
      model: 'gpt-4o-mini',
      apiConfig: { provider: 'openai', apiKey: 'sk-test', baseUrl: `${baseUrl}/v1` },
    });
    assert.equal(o2.data.reply, 'openai-msgs:4');

    // 2. Anthropic
    const a1 = await adapter.runUnifiedTurn({
      sessionKey: 's2',
      prompt: 'hello claude',
      schema,
      model: 'claude-haiku-4-5',
      apiConfig: { provider: 'anthropic', apiKey: 'ant-test-key', baseUrl },
    });
    assert.equal(a1.data.reply, 'anthropic-ok');

    // 3. Gemini
    const g1 = await adapter.runUnifiedTurn({
      sessionKey: 's3',
      prompt: 'hello gemini',
      schema,
      model: 'gemini-2.5-flash',
      apiConfig: { provider: 'gemini', apiKey: 'gem-test-key', baseUrl },
    });
    assert.equal(g1.data.reply, 'gemini-ok');

    // 4. OpenRouter sends HTTP-Referer & X-Title headers and works with OPENROUTER_API_KEY
    const orAdapter = new DirectApiAdapter({ env: { OPENROUTER_API_KEY: 'or-env-key' } });
    const orRes = await orAdapter.runUnifiedTurn({
      sessionKey: 's-or',
      prompt: 'hello openrouter',
      schema,
      model: 'google/gemini-2.5-flash',
      apiConfig: { provider: 'openrouter', baseUrl: `${baseUrl}/v1` },
    });
    assert.equal(orRes.data.reply, 'openai-msgs:2');
    const orReq = seenRequests.at(-1);
    assert.equal(orReq.headers.authorization, 'Bearer or-env-key');
    assert.equal(orReq.headers['x-title'], 'Paint It Black');
    orAdapter.dispose();

    // 5. Local URL provider works without an API key
    const localRes = await adapter.runUnifiedTurn({
      sessionKey: 's-local',
      prompt: 'hello ollama',
      schema,
      model: 'qwen2.5:14b',
      apiConfig: { provider: 'local', baseUrl: `${baseUrl}/v1` },
    });
    assert.equal(localRes.data.reply, 'openai-msgs:2');
    const localReq = seenRequests.at(-1);
    assert.equal(localReq.headers.authorization, undefined);

    // 6. Invalid API key maps to AUTH_REQUIRED
    await assert.rejects(
      () =>
        adapter.runUnifiedTurn({
          sessionKey: 's4',
          prompt: 'fail auth',
          schema,
          model: 'gpt-4o-mini',
          apiConfig: { provider: 'openai', apiKey: 'bad-key', baseUrl: `${baseUrl}/v1` },
        }),
      (err) => err.code === 'AUTH_REQUIRED',
    );
  } finally {
    adapter.dispose();
    await new Promise((resolve) => srv.close(resolve));
  }
});
