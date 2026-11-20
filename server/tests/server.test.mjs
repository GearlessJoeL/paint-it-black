import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AgentRegistry } from '../agents/registry.mjs';
import { loadConfig } from '../config.mjs';
import { createCompanionServer } from '../index.mjs';

const FALLBACK_SAMPLE_TEX = `\\documentclass[11pt,letterpaper]{article}
\\begin{document}
\\section*{Highlights of Qualifications}
Backend engineer experienced in Go, Kubernetes, and distributed systems.
\\section*{Technical Skills}
Go, Python, Kubernetes, gRPC, PostgreSQL, Linux
\\end{document}
`;

function parseSseStream(rawText) {
  const events = [];
  for (const block of rawText.split('\n\n')) {
    let event = 'message';
    const dataLines = [];
    for (const line of block.split('\n')) {
      if (!line || line.startsWith(':')) continue;
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    if (dataLines.length > 0) {
      events.push({ event, data: JSON.parse(dataLines.join('\n')) });
    }
  }
  return events;
}

test('Companion server tailors, auto-repairs 2-page overflow, archives in WSL, and serves PDF', async () => {
  const configuredRepo = loadConfig().resumeRepoDir;
  const masterTex = await fs
    .readFile(path.join(configuredRepo, 'resume.tex'), 'utf8')
    .catch(() => FALLBACK_SAMPLE_TEX);
  const skillDoc = await fs
    .readFile(path.join(configuredRepo, 'SKILL.md'), 'utf8')
    .catch(() => '# Resume Tailoring Rules\nKeep resume strictly to 1 page.\n');

  const tmpRepo = await fs.mkdtemp(path.join(os.tmpdir(), 'resume-tailor-server-test-'));
  const tmpRevs = await fs.mkdtemp(path.join(os.tmpdir(), 'resume-tailor-revs-test-'));
  await fs.writeFile(path.join(tmpRepo, 'resume.tex'), masterTex, 'utf8');
  await fs.writeFile(path.join(tmpRepo, 'SKILL.md'), skillDoc, 'utf8');

  // Mock agent:
  // Call 1 (initial tailor): intentionally overflows to 2 pages
  // Call 2 (auto-repair): returns clean 1-page LaTeX (becomes v1)
  // Call 3 (feedback regenerate): modifies Highlights heading text cleanly (becomes v2)
  let callCount = 0;
  const mockAgent = {
    id: 'antigravity',
    label: 'Mock Antigravity',
    description: 'Test adapter',
    async checkStatus() {
      return {
        id: this.id,
        label: this.label,
        description: this.description,
        installed: true,
        authenticated: true,
        models: [{ id: 'gemini-test', label: 'Gemini Test' }],
        message: 'Ready (mock)',
      };
    },
    async runStructuredPrompt({ onEvent }) {
      callCount += 1;
      onEvent?.({ kind: 'thought', text: `Mock agent pass ${callCount}` });

      if (callCount === 1) {
        const twoPageLatex = masterTex.replace('\\end{document}', '\\newpage\nOverflow test line.\n\\end{document}');
        return {
          conversationId: 'conv-test-1',
          usage: { total_tokens: 1234 },
          data: {
            companyName: 'Stripe, Inc.',
            jobTitle: 'Backend Engineer Intern',
            masterUsed: 'resume.tex',
            extractedKeywords: {
              requiredSkills: ['Go', 'Kubernetes', 'REST APIs'],
              preferredSkills: ['gRPC', 'AWS'],
              experienceRequirements: ['Backend distributed systems'],
              educationRequirements: ['BSc/MEng in CS or Engineering'],
              keyResponsibilities: ['Build developer tooling and backend APIs'],
              domainKeywords: ['Developer Infrastructure', 'Observability'],
            },
            tailoredLatex: twoPageLatex,
            matchedKeywords: ['Go', 'Kubernetes', 'gRPC', 'REST APIs'],
            missingKeywords: ['Ruby'],
            changeSummary: ['Emphasized Go/Kubernetes developer infrastructure work'],
          },
        };
      }

      if (callCount === 2) {
        // Repair pass returns valid 1-page LaTeX
        return {
          conversationId: 'conv-test-1',
          usage: { total_tokens: 456 },
          data: {
            tailoredLatex: masterTex,
            fixNotes: ['Removed overflow so resume fits strictly on 1 page'],
          },
        };
      }

      if (callCount === 3) {
        // Feedback regenerate pass returns updated 1-page LaTeX
        const revisedTex = masterTex.replace(
          'Highlights of Qualifications',
          'Summary of Qualifications',
        );
        return {
          conversationId: 'conv-test-2',
          usage: { total_tokens: 789 },
          data: {
            tailoredLatex: revisedTex,
            matchedKeywords: ['Go', 'Kubernetes', 'gRPC', 'REST APIs', 'Bazel'],
            missingKeywords: ['Ruby'],
            changeSummary: ['Applied review feedback: renamed Highlights heading and tightened bullets'],
          },
        };
      }

      if (callCount === 4) {
        // Unified chat Q&A turn — must NOT compile LaTeX or touch revisions
        return {
          conversationId: 'conv-test-3',
          usage: { total_tokens: 210 },
          data: {
            intent: 'qa',
            reply: 'Your main gap for this role is Ruby, which is not on your master resume.',
            tailoredLatex: '',
          },
        };
      }

      // Unified chat Edit turn — modifies resume and compiles v3
      const chatEditedTex = masterTex.replace(
        'Technical Skills',
        'Core Technical Skills',
      );
      return {
        conversationId: 'conv-test-4',
        usage: { total_tokens: 512 },
        data: {
          intent: 'edit',
          reply: 'Renamed Technical Skills to Core Technical Skills and kept 1-page layout.',
          tailoredLatex: chatEditedTex,
          matchedKeywords: ['Go', 'Kubernetes', 'gRPC'],
          missingKeywords: ['Ruby'],
          changeSummary: ['Renamed Technical Skills heading'],
        },
      };
    },
  };

  const registry = new AgentRegistry();
  registry.register(mockAgent);

  const { server } = createCompanionServer({
    config: {
      host: '127.0.0.1',
      port: 0,
      resumeRepoDir: tmpRepo,
      revisionsDir: tmpRevs,
      maxRepairAttempts: 2,
    },
    registry,
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. Forbidden cross-site origin must be rejected
    const evilRes = await fetch(`${baseUrl}/api/health`, {
      headers: { Origin: 'https://evil.example' },
    });
    assert.equal(evilRes.status, 403);

    // 2. Chrome extension origin health check succeeds
    const healthRes = await fetch(`${baseUrl}/api/health`, {
      headers: { Origin: 'chrome-extension://testextensionid' },
    });
    assert.equal(healthRes.status, 200);
    assert.equal(
      healthRes.headers.get('access-control-allow-origin'),
      'chrome-extension://testextensionid',
    );
    const health = await healthRes.json();
    assert.equal(health.status, 'ok');
    assert.equal(health.platform, process.platform);
    assert.equal(typeof health.isWsl, 'boolean');
    assert.equal(health.latex.installed, true);
    assert.equal(health.masters.length, 1);

    // 2.5 POST /api/warmup responds immediately
    const warmRes = await fetch(`${baseUrl}/api/warmup`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'chrome-extension://testextensionid',
      },
      body: JSON.stringify({ agentId: 'antigravity' }),
    });
    assert.equal(warmRes.status, 200);

    // 3. POST /api/tailor runs full flow + auto-repair pass, prefers AI-extracted company/title over bad scraped hints, and streams SSE
    const tailorRes = await fetch(`${baseUrl}/api/tailor`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'chrome-extension://testextensionid',
      },
      body: JSON.stringify({
        companyName: 'Canada',
        jobTitle: 'Backend Engineer Intern - Remote Work',
        companyManual: false,
        jobTitleManual: false,
        pageTitle: 'Backend Engineer Intern - Remote Work | Canada | LinkedIn',
        jobDescription:
          'Stripe is hiring a Backend Engineer Intern to build Go, Kubernetes, and developer infrastructure APIs with strong observability.',
        userPrompt: 'Highlight Go CLI and Kubernetes observability work.',
        masterResume: 'resume.tex',
      }),
    });
    assert.equal(tailorRes.status, 200);
    const sseText = await tailorRes.text();
    const events = parseSseStream(sseText);

    const doneEvent = events.find((e) => e.event === 'done');
    assert.ok(doneEvent, `Expected done event, got: ${JSON.stringify(events)}`);
    const result = doneEvent.data;

    assert.equal(callCount, 2, 'Expected automatic repair pass for 2-page overflow');
    assert.equal(result.pdfFilename, 'resume-stripe-backend-engineer-intern.pdf');
    assert.equal(result.pageCount, 1);
    assert.equal(result.repairAttempts, 1);

    // 4. Verify WSL archive files exist & master resume was untouched
    const archivedPdf = await fs.readFile(result.pdfPath);
    assert.equal(archivedPdf.subarray(0, 5).toString('ascii'), '%PDF-');
    const archivedJobMd = await fs.readFile(result.jobMdPath, 'utf8');
    assert.match(archivedJobMd, /Stripe, Inc\./);
    assert.equal(await fs.readFile(path.join(tmpRepo, 'resume.tex'), 'utf8'), masterTex);

    // 5. Verify PDF download endpoint serves exact filename header + PDF bytes
    const dlRes = await fetch(`${baseUrl}${result.downloadUrl}`);
    assert.equal(dlRes.status, 200);
    assert.equal(dlRes.headers.get('content-type'), 'application/pdf');
    assert.match(
      dlRes.headers.get('content-disposition') || '',
      /filename="resume-stripe-backend-engineer-intern\.pdf"/,
    );
    const dlBytes = Buffer.from(await dlRes.arrayBuffer());
    assert.equal(dlBytes.subarray(0, 5).toString('ascii'), '%PDF-');

    // 6. Verify history endpoint lists the generated resume
    const histRes = await fetch(`${baseUrl}/api/history`);
    assert.equal(histRes.status, 200);
    const { items } = await histRes.json();
    assert.equal(items.length, 1);
    assert.equal(items[0].pdfFilename, 'resume-stripe-backend-engineer-intern.pdf');
    assert.equal(result.activeVersion, 1);

    // 7. Verify POST /api/regenerate iterates on v1 -> produces v2 with preserved revision history
    const regenRes = await fetch(`${baseUrl}/api/regenerate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'chrome-extension://testextensionid',
      },
      body: JSON.stringify({
        folderSlug: result.folderSlug,
        feedback: 'Rename Highlights to Summary and emphasize Bazel.',
        mode: 'iterate',
      }),
    });
    assert.equal(regenRes.status, 200);
    const regenEvents = parseSseStream(await regenRes.text());
    const regenDone = regenEvents.find((e) => e.event === 'done');
    assert.ok(regenDone, 'Expected done event on regenerate');
    assert.equal(regenDone.data.activeVersion, 2);
    assert.equal(regenDone.data.revisions.length, 2);

    // 8. Verify details & historical v1 PDF endpoint work
    const detailsRes = await fetch(`${baseUrl}/api/tailored/${result.folderSlug}/details`);
    assert.equal(detailsRes.status, 200);
    const details = await detailsRes.json();
    assert.equal(details.revisions.length, 2);

    const v1PdfRes = await fetch(`${baseUrl}/api/tailored/${result.folderSlug}/revisions/1/pdf`);
    assert.equal(v1PdfRes.status, 200);
    assert.equal(Buffer.from(await v1PdfRes.arrayBuffer()).subarray(0, 5).toString('ascii'), '%PDF-');

    // 9. Verify restoring v1 updates active resume.tex back to v1
    const restoreRes = await fetch(
      `${baseUrl}/api/tailored/${result.folderSlug}/revisions/1/restore`,
      { method: 'POST' },
    );
    assert.equal(restoreRes.status, 200);
    const restored = await restoreRes.json();
    assert.equal(restored.activeVersion, 1);
    const restoredTex = await fs.readFile(result.texPath, 'utf8');
    assert.match(restoredTex, /Highlights of Qualifications/);

    // 10. Verify POST /api/chat Q&A intent answers directly without changing revisions
    const qaRes = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'chrome-extension://testextensionid',
      },
      body: JSON.stringify({
        message: 'What skills am I missing for this job?',
        folderSlug: result.folderSlug,
      }),
    });
    assert.equal(qaRes.status, 200);
    const qaEvents = parseSseStream(await qaRes.text());
    const chatEv = qaEvents.find((e) => e.event === 'chat');
    assert.ok(chatEv, `Expected chat event for Q&A, got: ${JSON.stringify(qaEvents)}`);
    assert.equal(chatEv.data.intent, 'qa');
    assert.match(chatEv.data.reply, /Ruby/);
    assert.equal(qaEvents.find((e) => e.event === 'done'), undefined);

    // 11. Verify POST /api/chat Edit intent modifies resume, compiles 1-page PDF, and creates v3
    const editRes = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'chrome-extension://testextensionid',
      },
      body: JSON.stringify({
        message: 'Rename Technical Skills to Core Technical Skills',
        folderSlug: result.folderSlug,
      }),
    });
    assert.equal(editRes.status, 200);
    const editEvents = parseSseStream(await editRes.text());
    const editDone = editEvents.find((e) => e.event === 'done');
    assert.ok(editDone, 'Expected done event for chat edit');
    assert.equal(editDone.data.intent, 'edit');
    assert.equal(editDone.data.activeVersion, 3);
    assert.equal(editDone.data.pageCount, 1);
    const v3Tex = await fs.readFile(result.texPath, 'utf8');
    assert.match(v3Tex, /Core Technical Skills/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(tmpRepo, { recursive: true, force: true });
    await fs.rm(tmpRevs, { recursive: true, force: true });
  }
});
