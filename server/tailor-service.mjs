import crypto from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { buildToolEnv, listMasterResumes } from './config.mjs';
import { checkLatexToolchain, compileLatex } from './latex.mjs';
import { applyLatexSlots, extractLatexSlots, sanitizeLatexCommands } from './latex-slots.mjs';
import {
  CHAT_OUTPUT_SCHEMA,
  FEEDBACK_OUTPUT_SCHEMA,
  REPAIR_OUTPUT_SCHEMA,
  TAILOR_OUTPUT_SCHEMA,
  UNIFIED_OUTPUT_SCHEMA,
  buildChatPrompt,
  buildFeedbackPrompt,
  buildJobMarkdown,
  buildRepairPrompt,
  buildTailorPrompt,
  selectMasterResume,
} from './prompt-builder.mjs';
import { buildOutputNames, resolveSafeTailoredDir } from './slug.mjs';

function cleanLatexString(raw) {
  return sanitizeLatexCommands(raw);
}

function assertValidLatexSkeleton(tex) {
  if (
    !tex ||
    !tex.includes('\\documentclass') ||
    !tex.includes('\\begin{document}') ||
    !tex.includes('\\end{document}')
  ) {
    throw new Error(
      'Generated LaTeX is incomplete (missing \\documentclass, \\begin{document}, or \\end{document}).',
    );
  }
}

function extractJdFromJobMd(jobMd) {
  const text = String(jobMd || '');
  const marker = '## Original Job Description';
  const idx = text.indexOf(marker);
  if (idx !== -1) {
    return text.slice(idx + marker.length).trim();
  }
  return text.trim();
}

export class TailorService {
  constructor({ config, registry }) {
    this.config = config;
    this.env = buildToolEnv(config);
    this.registry = registry;
    this.jobs = new Map();
  }

  #resolveSafeRevisionDir(folderSlug) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(folderSlug)) {
      throw new Error(`Unsafe folder slug: ${folderSlug}`);
    }
    const root = path.resolve(this.config.revisionsDir);
    const dir = path.resolve(root, folderSlug);
    if (dir !== root && !dir.startsWith(root + path.sep)) {
      throw new Error(`Refusing revision path outside revisionsDir: ${dir}`);
    }
    return dir;
  }

  async listRevisions(folderSlug) {
    const revDir = this.#resolveSafeRevisionDir(folderSlug);
    let entries;
    try {
      entries = await fs.readdir(revDir);
    } catch {
      return [];
    }

    const metaFiles = entries
      .map((name) => {
        const m = name.match(/^v(\d+)\.json$/);
        return m ? { version: Number(m[1]), name } : null;
      })
      .filter(Boolean)
      .sort((a, b) => a.version - b.version);

    const revisions = [];
    for (const item of metaFiles) {
      try {
        const raw = await fs.readFile(path.join(revDir, item.name), 'utf8');
        const parsed = JSON.parse(raw);
        revisions.push({
          ...parsed,
          version: item.version,
          pdfUrl: `/api/tailored/${folderSlug}/revisions/${item.version}/pdf`,
        });
      } catch {
        // skip corrupted revision file
      }
    }
    return revisions;
  }

  async #saveRevisionSnapshot({ folderSlug, texContent, pdfPath, meta }) {
    const revDir = this.#resolveSafeRevisionDir(folderSlug);
    await fs.mkdir(revDir, { recursive: true });

    const existing = await this.listRevisions(folderSlug);
    const nextVersion = existing.length > 0 ? existing[existing.length - 1].version + 1 : 1;

    const revTexPath = path.join(revDir, `v${nextVersion}.tex`);
    const revPdfPath = path.join(revDir, `v${nextVersion}.pdf`);
    const revMetaPath = path.join(revDir, `v${nextVersion}.json`);

    const snapshotMeta = {
      version: nextVersion,
      createdAt: meta.createdAt || new Date().toISOString(),
      feedback: meta.feedback || '',
      mode: meta.mode || (nextVersion === 1 ? 'initial' : 'iterate'),
      pageCount: meta.pageCount ?? null,
      overfullHboxCount: meta.overfullHboxCount ?? 0,
      pdfFilename: meta.pdfFilename || `resume-${folderSlug}.pdf`,
      matchedKeywords: Array.isArray(meta.matchedKeywords) ? meta.matchedKeywords : [],
      missingKeywords: Array.isArray(meta.missingKeywords) ? meta.missingKeywords : [],
      changeSummary: Array.isArray(meta.changeSummary) ? meta.changeSummary : [],
    };

    await Promise.all([
      fs.writeFile(revTexPath, texContent, 'utf8'),
      fs.copyFile(pdfPath, revPdfPath),
      fs.writeFile(revMetaPath, JSON.stringify(snapshotMeta, null, 2) + '\n', 'utf8'),
    ]);

    return {
      version: nextVersion,
      revisions: [...existing, { ...snapshotMeta, pdfUrl: `/api/tailored/${folderSlug}/revisions/${nextVersion}/pdf` }],
    };
  }

  async resolveRevisionPdf(folderSlug, version) {
    const verNum = Number(version);
    if (!Number.isInteger(verNum) || verNum < 1) return null;

    const revDir = this.#resolveSafeRevisionDir(folderSlug);
    const pdfPath = path.join(revDir, `v${verNum}.pdf`);
    const metaPath = path.join(revDir, `v${verNum}.json`);
    try {
      const stat = await fs.stat(pdfPath);
      if (!stat.isFile()) return null;
      let pdfFilename = `resume-${folderSlug}.pdf`;
      try {
        const meta = JSON.parse(await fs.readFile(metaPath, 'utf8'));
        if (meta.pdfFilename) pdfFilename = meta.pdfFilename;
      } catch {
        // default filename
      }
      return { pdfPath, pdfFilename, version: verNum };
    } catch {
      return null;
    }
  }

  async restoreRevision(folderSlug, version) {
    const verNum = Number(version);
    if (!Number.isInteger(verNum) || verNum < 1) {
      throw new Error('Invalid revision number');
    }

    const revDir = this.#resolveSafeRevisionDir(folderSlug);
    const revTexPath = path.join(revDir, `v${verNum}.tex`);
    const revPdfPath = path.join(revDir, `v${verNum}.pdf`);
    const revMetaPath = path.join(revDir, `v${verNum}.json`);

    const [texContent, revMetaRaw] = await Promise.all([
      fs.readFile(revTexPath, 'utf8'),
      fs.readFile(revMetaPath, 'utf8'),
    ]);
    const revMeta = JSON.parse(revMetaRaw);

    const { targetDir } = resolveSafeTailoredDir(this.config.resumeRepoDir, folderSlug);
    const existingMetaPath = path.join(targetDir, 'metadata.json');
    let existingMeta = {};
    try {
      existingMeta = JSON.parse(await fs.readFile(existingMetaPath, 'utf8'));
    } catch {
      // ignore
    }

    const pdfFilename = existingMeta.pdfFilename || revMeta.pdfFilename || `resume-${folderSlug}.pdf`;
    const texPath = path.join(targetDir, 'resume.tex');
    const standardPdfPath = path.join(targetDir, 'resume.pdf');
    const namedPdfPath = path.join(targetDir, pdfFilename);

    await fs.mkdir(targetDir, { recursive: true });
    await Promise.all([
      fs.writeFile(texPath, texContent, 'utf8'),
      fs.copyFile(revPdfPath, standardPdfPath),
      fs.copyFile(revPdfPath, namedPdfPath),
    ]);

    const stat = await fs.stat(namedPdfPath);
    const revisions = await this.listRevisions(folderSlug);
    const updatedMeta = {
      ...existingMeta,
      folderSlug,
      pdfFilename,
      wslDir: targetDir,
      texPath,
      pdfPath: namedPdfPath,
      standardPdfPath,
      pdfSizeBytes: stat.size,
      pageCount: revMeta.pageCount ?? existingMeta.pageCount ?? 1,
      isOnePage: (revMeta.pageCount ?? 1) === 1,
      overfullHboxCount: revMeta.overfullHboxCount ?? 0,
      matchedKeywords: revMeta.matchedKeywords || existingMeta.matchedKeywords || [],
      missingKeywords: revMeta.missingKeywords || existingMeta.missingKeywords || [],
      changeSummary: revMeta.changeSummary || existingMeta.changeSummary || [],
      activeVersion: verNum,
      updatedAt: new Date().toISOString(),
      downloadUrl: `/api/tailored/${folderSlug}/pdf`,
      tailoredDownloadUrl: `/api/tailored/${folderSlug}/pdf`,
    };

    await fs.writeFile(existingMetaPath, JSON.stringify(updatedMeta, null, 2) + '\n', 'utf8');
    return { ...updatedMeta, revisions };
  }

  async getTailoredDetails(folderSlug) {
    const { targetDir } = resolveSafeTailoredDir(this.config.resumeRepoDir, folderSlug);
    const metaPath = path.join(targetDir, 'metadata.json');
    const jobMdPath = path.join(targetDir, 'job.md');
    const texPath = path.join(targetDir, 'resume.tex');

    let meta = null;
    try {
      meta = JSON.parse(await fs.readFile(metaPath, 'utf8'));
    } catch {
      // Pre-existing folder created outside the extension
    }

    const resolvedPdf = await this.resolveHistoryPdf(folderSlug);
    if (!resolvedPdf) return null;

    const stat = await fs.stat(resolvedPdf.pdfPath);
    const jobMd = await fs.readFile(jobMdPath, 'utf8').catch(() => '');
    const jobDescription = extractJdFromJobMd(jobMd);
    const revisions = await this.listRevisions(folderSlug);

    const activeVersion =
      meta?.activeVersion || (revisions.length > 0 ? revisions[revisions.length - 1].version : 1);

    return {
      jobId: meta?.jobId || folderSlug,
      createdAt: meta?.createdAt || stat.mtime.toISOString(),
      agentId: meta?.agentId || 'antigravity',
      agentLabel: meta?.agentLabel || 'Antigravity CLI (agy)',
      model: meta?.model || 'default',
      masterUsed: meta?.masterUsed || 'resume.tex',
      companyName: meta?.companyName || folderSlug.split('-')[0] || folderSlug,
      jobTitle: meta?.jobTitle || folderSlug.split('-').slice(1).join(' ') || 'Role',
      sourceUrl: meta?.sourceUrl || '',
      folderSlug,
      pdfFilename: meta?.pdfFilename || resolvedPdf.pdfFilename,
      wslDir: targetDir,
      texPath,
      jobMdPath,
      pdfPath: resolvedPdf.pdfPath,
      pdfSizeBytes: stat.size,
      pageCount: meta?.pageCount ?? 1,
      isOnePage: (meta?.pageCount ?? 1) === 1,
      overfullHboxCount: meta?.overfullHboxCount ?? 0,
      matchedKeywords: meta?.matchedKeywords || [],
      missingKeywords: meta?.missingKeywords || [],
      changeSummary: meta?.changeSummary || [],
      activeVersion,
      revisions,
      jobDescription,
      downloadUrl: `/api/tailored/${folderSlug}/pdf`,
      tailoredDownloadUrl: `/api/tailored/${folderSlug}/pdf`,
    };
  }

  async getHealth({ forceRefresh = false } = {}) {
    const [latex, agents] = await Promise.all([
      checkLatexToolchain(this.env),
      this.registry.checkAllStatuses({ forceRefresh }),
    ]);
    const masters = listMasterResumes(this.config.resumeRepoDir);
    const hasSkillDoc = await fs
      .access(path.join(this.config.resumeRepoDir, 'SKILL.md'))
      .then(() => true)
      .catch(() => false);

    return {
      status: 'ok',
      platform: process.platform,
      isWsl:
        Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) ||
        (process.platform === 'linux' && fsSync.existsSync('/proc/sys/fs/binfmt_misc/WSLInterop')),
      host: this.config.host,
      port: this.config.port,
      resumeRepoDir: this.config.resumeRepoDir,
      hasSkillDoc,
      masters,
      latex,
      agents,
      defaultAgent: agents[0]?.id || 'antigravity',
    };
  }

  async warmup({ agentId = 'antigravity', model = '', effort = '' } = {}) {
    const agent = this.registry.get(agentId);
    if (!agent?.prewarm) return { ok: false };
    return agent.prewarm({ schema: UNIFIED_OUTPUT_SCHEMA, model, effort });
  }

  async reconnect({ agentId = 'antigravity', model = '', effort = '' } = {}) {
    this.registry.resetAll?.();
    const health = await this.getHealth({ forceRefresh: true });
    if (agentId === 'antigravity') {
      this.warmup({ agentId, model, effort }).catch(() => {});
    }
    return health;
  }

  #resolveOutputLatex(baseTex, payload) {
    const rawFull = cleanLatexString(payload?.tailoredLatex);
    if (rawFull) {
      assertValidLatexSkeleton(rawFull);
      return rawFull;
    }

    if (Array.isArray(payload?.slots)) {
      const { latex } = applyLatexSlots(baseTex, payload.slots);
      assertValidLatexSkeleton(latex);
      return latex;
    }

    throw new Error(
      'Generated LaTeX is incomplete (missing \\documentclass, \\begin{document}, or \\end{document}).',
    );
  }

  #extractApiConfig(input = {}) {
    return {
      provider: input.apiProvider || '',
      apiKey: input.apiKey || '',
      baseUrl: input.apiBaseUrl || '',
    };
  }

  async #invokeAgent({
    agent,
    sessionKey = '',
    prompt,
    fallbackSchema,
    model = '',
    effort = '',
    apiConfig = {},
    conversationId = '',
    signal,
    emit,
    jobId,
  }) {
    const onEvent = (ev) => emit('agent', { jobId, ...ev });
    if (typeof agent.runUnifiedTurn === 'function') {
      return agent.runUnifiedTurn({
        sessionKey,
        prompt,
        schema: UNIFIED_OUTPUT_SCHEMA,
        model,
        effort,
        apiConfig,
        signal,
        onEvent,
      });
    }
    return agent.runStructuredPrompt({
      prompt,
      schema: fallbackSchema,
      model,
      effort,
      apiConfig,
      cwd: this.config.resumeRepoDir,
      conversationId,
      signal,
      onEvent,
    });
  }

  async listHistory(limit = 20) {
    const tailoredRoot = path.resolve(this.config.resumeRepoDir, 'tailored');
    let entries;
    try {
      entries = await fs.readdir(tailoredRoot, { withFileTypes: true });
    } catch {
      return [];
    }

    const items = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(tailoredRoot, entry.name);
      const metaPath = path.join(dir, 'metadata.json');
      const fallbackPdf = path.join(dir, 'resume.pdf');

      try {
        const metaRaw = await fs.readFile(metaPath, 'utf8');
        const meta = JSON.parse(metaRaw);
        const namedPdfPath = path.join(dir, meta.pdfFilename || 'resume.pdf');
        const pdfPath = await fs
          .access(namedPdfPath)
          .then(() => namedPdfPath)
          .catch(() => fallbackPdf);
        const stat = await fs.stat(pdfPath);
        items.push({
          ...meta,
          folderSlug: entry.name,
          pdfPath,
          pdfSizeBytes: stat.size,
          updatedAt: meta.updatedAt || meta.createdAt || stat.mtime.toISOString(),
        });
      } catch {
        try {
          const stat = await fs.stat(fallbackPdf);
          items.push({
            folderSlug: entry.name,
            companyName: entry.name.split('-')[0] || entry.name,
            jobTitle: entry.name.split('-').slice(1).join(' ') || 'Resume',
            pdfFilename: `resume-${entry.name}.pdf`,
            pdfPath: fallbackPdf,
            texPath: path.join(dir, 'resume.tex'),
            jobMdPath: path.join(dir, 'job.md'),
            pdfSizeBytes: stat.size,
            pageCount: 1,
            updatedAt: stat.mtime.toISOString(),
          });
        } catch {
          // folder has no compiled PDF yet
        }
      }
    }

    items.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    return items.slice(0, limit);
  }

  getJob(jobId) {
    return this.jobs.get(jobId) || null;
  }

  async resolveHistoryPdf(folderSlug) {
    const { targetDir } = resolveSafeTailoredDir(this.config.resumeRepoDir, folderSlug);
    const metaPath = path.join(targetDir, 'metadata.json');
    let pdfFilename = `resume-${folderSlug}.pdf`;
    try {
      const meta = JSON.parse(await fs.readFile(metaPath, 'utf8'));
      if (meta.pdfFilename) pdfFilename = meta.pdfFilename;
    } catch {
      // use default filename
    }

    for (const candidate of [path.join(targetDir, pdfFilename), path.join(targetDir, 'resume.pdf')]) {
      try {
        const stat = await fs.stat(candidate);
        if (stat.isFile()) {
          return { pdfPath: candidate, pdfFilename };
        }
      } catch {
        // try next
      }
    }
    return null;
  }

  async #compileWithAutoRepair({
    jobId,
    targetDir,
    texPath,
    tailoredLatex,
    masterLatex,
    agent,
    sessionKey = '',
    model,
    effort,
    apiConfig = {},
    conversationId,
    signal,
    emit,
  }) {
    let currentTex = tailoredLatex;
    await fs.writeFile(texPath, currentTex + '\n', 'utf8');

    let compileResult = await compileLatex({
      workDir: targetDir,
      texFilename: 'resume.tex',
      env: this.env,
      signal,
    });

    const repairNotes = [];
    let attempts = 0;

    while (
      attempts < this.config.maxRepairAttempts &&
      (!compileResult.ok || !compileResult.logSummary.isOnePage || compileResult.logSummary.hasSevereOverfull)
    ) {
      attempts += 1;
      const reasonParts = [];
      if (!compileResult.ok) reasonParts.push('LaTeX compile error');
      if (compileResult.logSummary.pageCount && compileResult.logSummary.pageCount !== 1) {
        reasonParts.push(`${compileResult.logSummary.pageCount} pages (must be 1)`);
      }
      if (compileResult.logSummary.hasSevereOverfull) {
        reasonParts.push(`Overfull hbox ${compileResult.logSummary.maxOverfullHboxPt}pt`);
      }

      emit('stage', {
        jobId,
        step: 'repair',
        progress: 65 + attempts * 12,
        message: `Auto-fixing layout/LaTeX (${reasonParts.join(', ')}) — pass ${attempts}/${this.config.maxRepairAttempts}...`,
      });

      const currentSlots = extractLatexSlots(currentTex).slots;
      const isSeeded = Boolean(
        agent.isSessionSeeded?.(sessionKey, { model: model || '', effort: effort || '', apiConfig }),
      );
      const repairPrompt = buildRepairPrompt({
        masterLatex,
        previousLatex: currentTex,
        slots: currentSlots,
        compileResult,
        sessionSeeded: isSeeded,
        unified: typeof agent.runUnifiedTurn === 'function',
      });

      const repairResult = await this.#invokeAgent({
        agent,
        sessionKey,
        prompt: repairPrompt,
        fallbackSchema: REPAIR_OUTPUT_SCHEMA,
        model: model || '',
        effort: effort || '',
        apiConfig,
        conversationId: conversationId || '',
        signal,
        emit,
        jobId,
      });

      currentTex = this.#resolveOutputLatex(currentTex, repairResult.data);
      if (Array.isArray(repairResult.data?.fixNotes)) {
        repairNotes.push(...repairResult.data.fixNotes);
      } else if (repairResult.data?.reply) {
        repairNotes.push(repairResult.data.reply);
      }

      await fs.writeFile(texPath, currentTex + '\n', 'utf8');
      compileResult = await compileLatex({
        workDir: targetDir,
        texFilename: 'resume.tex',
        env: this.env,
        signal,
      });
    }

    if (!compileResult.ok) {
      const errorDetail =
        compileResult.logSummary.errors[0] ||
        compileResult.stdoutTail.slice(-600) ||
        'Unknown LaTeX error';
      throw new Error(`LaTeX compilation failed after ${attempts} repair attempt(s): ${errorDetail}`);
    }

    return { tailoredLatex: currentTex, compileResult, attempts, repairNotes };
  }

  /**
   * Run the full initial tailoring pipeline and emit progress events to `emit(eventName, payload)`.
   */
  async runTailorJob(input, { signal, emit = () => {} } = {}) {
    const jobId = crypto.randomUUID();
    const startedAt = new Date().toISOString();

    const jobDescription = String(input.jobDescription || '').trim();
    if (jobDescription.length < 30) {
      throw new Error('Job description is too short (at least 30 characters required).');
    }

    const agentId = input.agentId || 'antigravity';
    const agent = this.registry.get(agentId);
    if (!agent) {
      throw new Error(`Unknown local AI agent "${agentId}".`);
    }

    const resumeRepoDir = this.config.resumeRepoDir;
    const availableMasters = listMasterResumes(resumeRepoDir);
    if (availableMasters.length === 0) {
      throw new Error(`No master .tex resumes found in ${resumeRepoDir}.`);
    }

    const masterFilename = selectMasterResume({
      requestedMaster: input.masterResume || 'auto',
      jobTitle: input.jobTitle || '',
      jobDescription,
      availableMasters,
    });

    const masterPath = path.join(resumeRepoDir, masterFilename);
    emit('stage', {
      jobId,
      step: 'prepare',
      progress: 10,
      message: `Loaded master resume ${masterFilename}`,
    });

    const [masterLatex, skillDoc] = await Promise.all([
      fs.readFile(masterPath, 'utf8'),
      fs.readFile(path.join(resumeRepoDir, 'SKILL.md'), 'utf8').catch(() => ''),
    ]);

    const masterSlots = extractLatexSlots(masterLatex).slots;
    const sessionKey = String(input.sessionKey || input.sourceUrl || '').trim() || jobId;
    const polishPasses = input.fastMode === false ? 2 : 1;
    const prompt = buildTailorPrompt({
      skillDoc,
      masterFilename,
      masterLatex,
      slots: masterSlots,
      jobDescription,
      companyHint: input.companyName || '',
      jobTitleHint: input.jobTitle || '',
      companyManual: Boolean(input.companyManual),
      jobTitleManual: Boolean(input.jobTitleManual),
      pageTitle: input.pageTitle || '',
      sourceUrl: input.sourceUrl || '',
      userPrompt: input.userPrompt || '',
      polishPasses,
      unified: typeof agent.runUnifiedTurn === 'function',
    });

    emit('stage', {
      jobId,
      step: 'agent',
      progress: 25,
      message: `Tailoring resume with ${agent.label} (${polishPasses}-pass writing rubric)...`,
    });

    const apiConfig = this.#extractApiConfig(input);
    const agentResult = await this.#invokeAgent({
      agent,
      sessionKey,
      prompt,
      fallbackSchema: TAILOR_OUTPUT_SCHEMA,
      model: input.model || '',
      effort: input.effort || '',
      apiConfig,
      signal,
      emit,
      jobId,
    });

    const payload = agentResult.data;
    // Prefer AI-extracted canonical company & job title from the JD unless the user explicitly typed overrides
    const companyName = String(
      (input.companyManual && input.companyName) ||
        payload.companyName ||
        input.companyName ||
        'Company',
    ).trim();
    const jobTitle = String(
      (input.jobTitleManual && input.jobTitle) ||
        payload.jobTitle ||
        input.jobTitle ||
        'Role',
    ).trim();
    let tailoredLatex = this.#resolveOutputLatex(masterLatex, payload);

    const names = buildOutputNames(companyName, jobTitle);
    const { targetDir } = resolveSafeTailoredDir(resumeRepoDir, names.folderSlug);
    await fs.mkdir(targetDir, { recursive: true });

    const jobMdPath = path.join(targetDir, 'job.md');
    const texPath = path.join(targetDir, 'resume.tex');
    const namedPdfPath = path.join(targetDir, names.pdfFilename);

    const jobMd = buildJobMarkdown({
      companyName,
      jobTitle,
      sourceUrl: input.sourceUrl || '',
      extractedKeywords: payload.extractedKeywords,
      matchedKeywords: payload.matchedKeywords,
      missingKeywords: payload.missingKeywords,
      jobDescription,
    });
    await fs.writeFile(jobMdPath, jobMd, 'utf8');

    emit('stage', {
      jobId,
      step: 'compile',
      progress: 65,
      message: `Compiling LaTeX (${names.folderSlug}/resume.tex)...`,
    });

    const compiled = await this.#compileWithAutoRepair({
      jobId,
      targetDir,
      texPath,
      tailoredLatex,
      masterLatex,
      agent,
      sessionKey,
      model: input.model || '',
      effort: input.effort || '',
      apiConfig,
      conversationId: agentResult.conversationId || '',
      signal,
      emit,
    });

    tailoredLatex = compiled.tailoredLatex;
    const { compileResult, attempts, repairNotes } = compiled;

    await fs.copyFile(compileResult.pdfPath, namedPdfPath);

    const completedAt = new Date().toISOString();
    const snapshot = await this.#saveRevisionSnapshot({
      folderSlug: names.folderSlug,
      texContent: tailoredLatex + '\n',
      pdfPath: namedPdfPath,
      meta: {
        createdAt: completedAt,
        feedback: String(input.userPrompt || '').trim(),
        mode: 'initial',
        pageCount: compileResult.logSummary.pageCount,
        overfullHboxCount: compileResult.logSummary.overfullHbox.length,
        pdfFilename: names.pdfFilename,
        matchedKeywords: payload.matchedKeywords,
        missingKeywords: payload.missingKeywords,
        changeSummary: payload.changeSummary,
      },
    });

    const resultRecord = {
      jobId,
      createdAt: completedAt,
      updatedAt: completedAt,
      startedAt,
      agentId: agent.id,
      agentLabel: agent.label,
      model: input.model || 'default',
      masterUsed: masterFilename,
      companyName,
      jobTitle,
      sourceUrl: input.sourceUrl || '',
      folderSlug: names.folderSlug,
      pdfFilename: names.pdfFilename,
      wslDir: targetDir,
      texPath,
      jobMdPath,
      pdfPath: namedPdfPath,
      standardPdfPath: compileResult.pdfPath,
      pdfSizeBytes: compileResult.pdfSizeBytes,
      pageCount: compileResult.logSummary.pageCount,
      isOnePage: compileResult.logSummary.isOnePage,
      overfullHboxCount: compileResult.logSummary.overfullHbox.length,
      maxOverfullHboxPt: compileResult.logSummary.maxOverfullHboxPt,
      overfullVboxCount: compileResult.logSummary.overfullVbox.length,
      repairAttempts: attempts,
      repairNotes,
      matchedKeywords: Array.isArray(payload.matchedKeywords) ? payload.matchedKeywords : [],
      missingKeywords: Array.isArray(payload.missingKeywords) ? payload.missingKeywords : [],
      changeSummary: Array.isArray(payload.changeSummary) ? payload.changeSummary : [],
      usage: agentResult.usage || null,
      activeVersion: snapshot.version,
      revisions: snapshot.revisions,
      downloadUrl: `/api/jobs/${jobId}/pdf`,
      tailoredDownloadUrl: `/api/tailored/${names.folderSlug}/pdf`,
    };

    await fs.writeFile(
      path.join(targetDir, 'metadata.json'),
      JSON.stringify(resultRecord, null, 2) + '\n',
      'utf8',
    );

    this.jobs.set(jobId, resultRecord);

    emit('stage', {
      jobId,
      step: 'done',
      progress: 100,
      message: `Ready: ${names.pdfFilename} (v${snapshot.version}, ${resultRecord.pageCount ?? '?'} page)`,
    });
    emit('done', resultRecord);

    return resultRecord;
  }

  /**
   * Regenerate an existing tailored resume from review feedback (either iterating on the
   * current draft or rebuilding fresh from the master .tex) while preserving revision history.
   */
  async runRegenerateJob(input, { signal, emit = () => {} } = {}) {
    const jobId = crypto.randomUUID();
    const startedAt = new Date().toISOString();

    const folderSlug = String(input.folderSlug || '').trim();
    if (!folderSlug) {
      throw new Error('folderSlug is required to regenerate a draft.');
    }

    const feedback = String(input.feedback || '').trim();
    if (feedback.length < 3) {
      throw new Error('Please enter feedback describing what you want changed.');
    }

    const mode = input.mode === 'fresh' ? 'fresh' : 'iterate';
    const agentId = input.agentId || 'antigravity';
    const agent = this.registry.get(agentId);
    if (!agent) {
      throw new Error(`Unknown local AI agent "${agentId}".`);
    }

    const resumeRepoDir = this.config.resumeRepoDir;
    const { targetDir } = resolveSafeTailoredDir(resumeRepoDir, folderSlug);
    const texPath = path.join(targetDir, 'resume.tex');
    const jobMdPath = path.join(targetDir, 'job.md');
    const metaPath = path.join(targetDir, 'metadata.json');

    let existingMeta = {};
    try {
      existingMeta = JSON.parse(await fs.readFile(metaPath, 'utf8'));
    } catch {
      // Pre-existing tailored folder without metadata.json
    }

    const currentLatex = await fs.readFile(texPath, 'utf8');
    const jobMd = await fs.readFile(jobMdPath, 'utf8').catch(() => '');
    const jobDescription = String(input.jobDescription || '').trim() || extractJdFromJobMd(jobMd);

    const availableMasters = listMasterResumes(resumeRepoDir);
    const masterFilename = selectMasterResume({
      requestedMaster: input.masterResume || existingMeta.masterUsed || 'auto',
      jobTitle: existingMeta.jobTitle || '',
      jobDescription,
      availableMasters,
    });

    const masterPath = path.join(resumeRepoDir, masterFilename);
    const [masterLatex, skillDoc] = await Promise.all([
      fs.readFile(masterPath, 'utf8'),
      fs.readFile(path.join(resumeRepoDir, 'SKILL.md'), 'utf8').catch(() => ''),
    ]);

    const companyName = String(existingMeta.companyName || folderSlug.split('-')[0] || 'Company').trim();
    const jobTitle = String(existingMeta.jobTitle || folderSlug.split('-').slice(1).join(' ') || 'Role').trim();
    const pdfFilename = existingMeta.pdfFilename || `resume-${folderSlug}.pdf`;
    const namedPdfPath = path.join(targetDir, pdfFilename);

    // If reviewing a pre-existing tailored folder that has no snapshots yet, snapshot v1 first so user can always revert!
    const existingRevs = await this.listRevisions(folderSlug);
    if (existingRevs.length === 0) {
      const existingPdf = await this.resolveHistoryPdf(folderSlug);
      if (existingPdf) {
        await this.#saveRevisionSnapshot({
          folderSlug,
          texContent: currentLatex,
          pdfPath: existingPdf.pdfPath,
          meta: {
            createdAt: existingMeta.createdAt || startedAt,
            feedback: 'Baseline draft',
            mode: 'baseline',
            pageCount: existingMeta.pageCount ?? 1,
            overfullHboxCount: existingMeta.overfullHboxCount ?? 0,
            pdfFilename,
            matchedKeywords: existingMeta.matchedKeywords || [],
            missingKeywords: existingMeta.missingKeywords || [],
            changeSummary: existingMeta.changeSummary || [],
          },
        });
      }
    }

    emit('stage', {
      jobId,
      step: 'prepare',
      progress: 12,
      message:
        mode === 'iterate'
          ? `Loaded current draft (${folderSlug}/resume.tex) + ground-truth ${masterFilename}`
          : `Regenerating fresh from ${masterFilename} with your feedback`,
    });

    const sessionKey = String(input.sessionKey || folderSlug).trim();
    const polishPasses = input.fastMode === false ? 2 : 1;
    const activeSlots = extractLatexSlots(mode === 'iterate' ? currentLatex : masterLatex).slots;
    const prompt =
      mode === 'iterate'
        ? buildFeedbackPrompt({
            skillDoc,
            masterFilename,
            masterLatex,
            currentLatex,
            slots: activeSlots,
            jobDescription,
            companyName,
            jobTitle,
            feedback,
            polishPasses,
          })
        : buildTailorPrompt({
            skillDoc,
            masterFilename,
            masterLatex,
            slots: activeSlots,
            jobDescription,
            companyHint: companyName,
            jobTitleHint: jobTitle,
            sourceUrl: existingMeta.sourceUrl || '',
            userPrompt: feedback,
            polishPasses,
            unified: typeof agent.runUnifiedTurn === 'function',
          });

    emit('stage', {
      jobId,
      step: 'agent',
      progress: 30,
      message: `Applying feedback with ${agent.label}...`,
    });

    const apiConfig = this.#extractApiConfig(input);
    const agentResult = await this.#invokeAgent({
      agent,
      sessionKey,
      prompt,
      fallbackSchema: mode === 'iterate' ? FEEDBACK_OUTPUT_SCHEMA : TAILOR_OUTPUT_SCHEMA,
      model: input.model || '',
      effort: input.effort || '',
      apiConfig,
      signal,
      emit,
      jobId,
    });

    const payload = agentResult.data;
    let tailoredLatex = this.#resolveOutputLatex(mode === 'iterate' ? currentLatex : masterLatex, payload);

    emit('stage', {
      jobId,
      step: 'compile',
      progress: 65,
      message: `Compiling updated LaTeX (${folderSlug}/resume.tex)...`,
    });

    const compiled = await this.#compileWithAutoRepair({
      jobId,
      targetDir,
      texPath,
      tailoredLatex,
      masterLatex,
      agent,
      sessionKey,
      model: input.model || '',
      effort: input.effort || '',
      apiConfig,
      conversationId: agentResult.conversationId || '',
      signal,
      emit,
    });

    tailoredLatex = compiled.tailoredLatex;
    const { compileResult, attempts, repairNotes } = compiled;

    await fs.copyFile(compileResult.pdfPath, namedPdfPath);

    const completedAt = new Date().toISOString();
    const snapshot = await this.#saveRevisionSnapshot({
      folderSlug,
      texContent: tailoredLatex + '\n',
      pdfPath: namedPdfPath,
      meta: {
        createdAt: completedAt,
        feedback,
        mode,
        pageCount: compileResult.logSummary.pageCount,
        overfullHboxCount: compileResult.logSummary.overfullHbox.length,
        pdfFilename,
        matchedKeywords: payload.matchedKeywords || existingMeta.matchedKeywords || [],
        missingKeywords: payload.missingKeywords || existingMeta.missingKeywords || [],
        changeSummary: payload.changeSummary || [],
      },
    });

    const resultRecord = {
      ...existingMeta,
      jobId,
      createdAt: existingMeta.createdAt || completedAt,
      updatedAt: completedAt,
      startedAt,
      agentId: agent.id,
      agentLabel: agent.label,
      model: input.model || existingMeta.model || 'default',
      masterUsed: masterFilename,
      companyName,
      jobTitle,
      sourceUrl: existingMeta.sourceUrl || '',
      folderSlug,
      pdfFilename,
      wslDir: targetDir,
      texPath,
      jobMdPath,
      pdfPath: namedPdfPath,
      standardPdfPath: compileResult.pdfPath,
      pdfSizeBytes: compileResult.pdfSizeBytes,
      pageCount: compileResult.logSummary.pageCount,
      isOnePage: compileResult.logSummary.isOnePage,
      overfullHboxCount: compileResult.logSummary.overfullHbox.length,
      maxOverfullHboxPt: compileResult.logSummary.maxOverfullHboxPt,
      overfullVboxCount: compileResult.logSummary.overfullVbox.length,
      repairAttempts: attempts,
      repairNotes,
      lastFeedback: feedback,
      matchedKeywords: Array.isArray(payload.matchedKeywords)
        ? payload.matchedKeywords
        : existingMeta.matchedKeywords || [],
      missingKeywords: Array.isArray(payload.missingKeywords)
        ? payload.missingKeywords
        : existingMeta.missingKeywords || [],
      changeSummary: Array.isArray(payload.changeSummary) ? payload.changeSummary : [],
      usage: agentResult.usage || null,
      activeVersion: snapshot.version,
      revisions: snapshot.revisions,
      downloadUrl: `/api/jobs/${jobId}/pdf`,
      tailoredDownloadUrl: `/api/tailored/${folderSlug}/pdf`,
    };

    await fs.writeFile(metaPath, JSON.stringify(resultRecord, null, 2) + '\n', 'utf8');
    this.jobs.set(jobId, resultRecord);

    emit('stage', {
      jobId,
      step: 'done',
      progress: 100,
      message: `Updated to v${snapshot.version}: ${pdfFilename} (${resultRecord.pageCount ?? '?'} page)`,
    });
    emit('done', resultRecord);

    return resultRecord;
  }

  /**
   * Unified conversational turn: Antigravity classifies the user message as either
   * Q&A (`qa`) or resume modification/generation (`edit` / `generate`).
   * - `qa`: replies immediately with no LaTeX build or file writes.
   * - `edit` / `generate`: writes LaTeX, compiles 1-page PDF with auto-repair, snapshots revision, emits `done`.
   */
  async runChatTurn(input, { signal, emit = () => {} } = {}) {
    const jobId = crypto.randomUUID();
    const startedAt = new Date().toISOString();

    const userMessage = String(input.message || '').trim();
    if (!userMessage) {
      throw new Error('Please type a message.');
    }

    const agentId = input.agentId || 'antigravity';
    const agent = this.registry.get(agentId);
    if (!agent) {
      throw new Error(`Unknown local AI agent "${agentId}".`);
    }

    const resumeRepoDir = this.config.resumeRepoDir;
    const availableMasters = listMasterResumes(resumeRepoDir);
    if (availableMasters.length === 0) {
      throw new Error(`No master .tex resumes found in ${resumeRepoDir}.`);
    }

    let folderSlug = String(input.folderSlug || '').trim();
    let existingMeta = {};
    let currentLatex = '';
    let existingJobMd = '';
    let hasDraft = false;

    if (folderSlug) {
      try {
        const { targetDir } = resolveSafeTailoredDir(resumeRepoDir, folderSlug);
        currentLatex = await fs.readFile(path.join(targetDir, 'resume.tex'), 'utf8');
        hasDraft = Boolean(currentLatex.trim());
        existingJobMd = await fs.readFile(path.join(targetDir, 'job.md'), 'utf8').catch(() => '');
        existingMeta = JSON.parse(
          await fs.readFile(path.join(targetDir, 'metadata.json'), 'utf8').catch(() => '{}'),
        );
      } catch {
        hasDraft = false;
        folderSlug = '';
      }
    }

    const jobDescription =
      String(input.jobDescription || '').trim() || extractJdFromJobMd(existingJobMd);
    const companyHint = String(input.companyName || existingMeta.companyName || '').trim();
    const jobTitleHint = String(input.jobTitle || existingMeta.jobTitle || '').trim();
    const sourceUrl = String(input.sourceUrl || existingMeta.sourceUrl || '').trim();

    const masterFilename = selectMasterResume({
      requestedMaster: input.masterResume || existingMeta.masterUsed || 'auto',
      jobTitle: jobTitleHint,
      jobDescription,
      availableMasters,
    });

    const masterPath = path.join(resumeRepoDir, masterFilename);
    const [masterLatex, skillDoc] = await Promise.all([
      fs.readFile(masterPath, 'utf8'),
      fs.readFile(path.join(resumeRepoDir, 'SKILL.md'), 'utf8').catch(() => ''),
    ]);

    emit('stage', {
      jobId,
      step: 'agent',
      progress: 25,
      message: `Thinking with ${agent.label}…`,
    });

    const sessionKey = String(input.sessionKey || folderSlug || sourceUrl || '').trim() || jobId;
    const baseTexForSlots = hasDraft ? currentLatex : masterLatex;
    const activeSlots = extractLatexSlots(baseTexForSlots).slots;
    const apiConfig = this.#extractApiConfig(input);
    const sessionSeeded = Boolean(
      agent.isSessionSeeded?.(sessionKey, { model: input.model || '', effort: input.effort || '', apiConfig }),
    );
    const polishPasses = input.fastMode === false ? 2 : 1;

    const prompt = buildChatPrompt({
      skillDoc,
      masterFilename,
      masterLatex,
      currentLatex,
      slots: activeSlots,
      hasDraft,
      jobDescription,
      companyName: companyHint,
      jobTitle: jobTitleHint,
      companyManual: Boolean(input.companyManual),
      jobTitleManual: Boolean(input.jobTitleManual),
      pageTitle: input.pageTitle || '',
      sourceUrl,
      history: input.history,
      userMessage,
      polishPasses,
      sessionSeeded,
    });

    const agentResult = await this.#invokeAgent({
      agent,
      sessionKey,
      prompt,
      fallbackSchema: CHAT_OUTPUT_SCHEMA,
      model: input.model || '',
      effort: input.effort || '',
      apiConfig,
      signal,
      emit,
      jobId,
    });

    const payload = agentResult.data || {};
    const intent = ['qa', 'edit', 'generate'].includes(payload.intent) ? payload.intent : 'qa';
    const reply = String(payload.reply || '').trim() || 'Done.';
    const rawFullTex = cleanLatexString(payload.tailoredLatex || '');
    const hasSlotEdits = Array.isArray(payload.slots) && payload.slots.length > 0;

    // Pure Q&A path (or graceful fallback if agent chose qa / returned neither LaTeX nor slot edits)
    if (intent === 'qa' || (!rawFullTex && !hasSlotEdits)) {
      const chatPayload = {
        jobId,
        intent: 'qa',
        reply,
        usage: agentResult.usage || null,
      };
      emit('stage', { jobId, step: 'done', progress: 100, message: 'Answered' });
      emit('chat', chatPayload);
      return chatPayload;
    }

    // Modification or Generation path -> resolve LaTeX, compile 1-page PDF + auto-repair + archive
    const baseTexForCompile = intent === 'generate' || !hasDraft ? masterLatex : currentLatex;
    const rawTex = this.#resolveOutputLatex(baseTexForCompile, payload);

    const isFreshGenerate = intent === 'generate' || !hasDraft;
    const companyName = String(
      (input.companyManual && input.companyName) ||
        payload.companyName ||
        companyHint ||
        'Company',
    ).trim();
    const jobTitle = String(
      (input.jobTitleManual && input.jobTitle) ||
        payload.jobTitle ||
        jobTitleHint ||
        'Role',
    ).trim();

    const names = buildOutputNames(companyName, jobTitle);
    const resolvedSlug = hasDraft && intent === 'edit' ? folderSlug : names.folderSlug;
    const pdfFilename =
      hasDraft && intent === 'edit' && existingMeta.pdfFilename
        ? existingMeta.pdfFilename
        : names.pdfFilename;

    const { targetDir } = resolveSafeTailoredDir(resumeRepoDir, resolvedSlug);
    await fs.mkdir(targetDir, { recursive: true });

    const jobMdPath = path.join(targetDir, 'job.md');
    const texPath = path.join(targetDir, 'resume.tex');
    const namedPdfPath = path.join(targetDir, pdfFilename);

    // Snapshot baseline v1 if editing a pre-existing folder with no revisions yet
    if (hasDraft && intent === 'edit') {
      const existingRevs = await this.listRevisions(resolvedSlug);
      if (existingRevs.length === 0) {
        const existingPdf = await this.resolveHistoryPdf(resolvedSlug);
        if (existingPdf) {
          await this.#saveRevisionSnapshot({
            folderSlug: resolvedSlug,
            texContent: currentLatex,
            pdfPath: existingPdf.pdfPath,
            meta: {
              createdAt: existingMeta.createdAt || startedAt,
              feedback: 'Baseline draft',
              mode: 'baseline',
              pageCount: existingMeta.pageCount ?? 1,
              overfullHboxCount: existingMeta.overfullHboxCount ?? 0,
              pdfFilename,
              matchedKeywords: existingMeta.matchedKeywords || [],
              missingKeywords: existingMeta.missingKeywords || [],
              changeSummary: existingMeta.changeSummary || [],
            },
          });
        }
      }
    }

    if (isFreshGenerate || !existingJobMd) {
      const jobMd = buildJobMarkdown({
        companyName,
        jobTitle,
        sourceUrl,
        extractedKeywords: payload.extractedKeywords,
        jobDescription,
      });
      await fs.writeFile(jobMdPath, jobMd, 'utf8');
    }

    emit('stage', {
      jobId,
      step: 'compile',
      progress: 65,
      message: `Compiling updated LaTeX (${resolvedSlug}/resume.tex)…`,
    });

    const compiled = await this.#compileWithAutoRepair({
      jobId,
      targetDir,
      texPath,
      tailoredLatex: rawTex,
      masterLatex,
      agent,
      sessionKey,
      model: input.model || '',
      effort: input.effort || '',
      apiConfig,
      conversationId: agentResult.conversationId || '',
      signal,
      emit,
    });

    const { tailoredLatex, compileResult, attempts, repairNotes } = compiled;
    await fs.copyFile(compileResult.pdfPath, namedPdfPath);

    const completedAt = new Date().toISOString();
    const snapshot = await this.#saveRevisionSnapshot({
      folderSlug: resolvedSlug,
      texContent: tailoredLatex + '\n',
      pdfPath: namedPdfPath,
      meta: {
        createdAt: completedAt,
        feedback: userMessage,
        mode: intent,
        pageCount: compileResult.logSummary.pageCount,
        overfullHboxCount: compileResult.logSummary.overfullHbox.length,
        pdfFilename,
        matchedKeywords: payload.matchedKeywords || existingMeta.matchedKeywords || [],
        missingKeywords: payload.missingKeywords || existingMeta.missingKeywords || [],
        changeSummary: payload.changeSummary || [],
      },
    });

    const resultRecord = {
      ...existingMeta,
      jobId,
      intent,
      reply,
      createdAt: existingMeta.createdAt || completedAt,
      updatedAt: completedAt,
      startedAt,
      agentId: agent.id,
      agentLabel: agent.label,
      model: input.model || existingMeta.model || 'default',
      masterUsed: masterFilename,
      companyName,
      jobTitle,
      sourceUrl,
      folderSlug: resolvedSlug,
      pdfFilename,
      wslDir: targetDir,
      texPath,
      jobMdPath,
      pdfPath: namedPdfPath,
      standardPdfPath: compileResult.pdfPath,
      pdfSizeBytes: compileResult.pdfSizeBytes,
      pageCount: compileResult.logSummary.pageCount,
      isOnePage: compileResult.logSummary.isOnePage,
      overfullHboxCount: compileResult.logSummary.overfullHbox.length,
      maxOverfullHboxPt: compileResult.logSummary.maxOverfullHboxPt,
      overfullVboxCount: compileResult.logSummary.overfullVbox.length,
      repairAttempts: attempts,
      repairNotes,
      lastFeedback: userMessage,
      matchedKeywords: Array.isArray(payload.matchedKeywords)
        ? payload.matchedKeywords
        : existingMeta.matchedKeywords || [],
      missingKeywords: Array.isArray(payload.missingKeywords)
        ? payload.missingKeywords
        : existingMeta.missingKeywords || [],
      changeSummary: Array.isArray(payload.changeSummary) ? payload.changeSummary : [],
      usage: agentResult.usage || null,
      activeVersion: snapshot.version,
      revisions: snapshot.revisions,
      downloadUrl: `/api/jobs/${jobId}/pdf`,
      tailoredDownloadUrl: `/api/tailored/${resolvedSlug}/pdf`,
    };

    await fs.writeFile(path.join(targetDir, 'metadata.json'), JSON.stringify(resultRecord, null, 2) + '\n', 'utf8');
    this.jobs.set(jobId, resultRecord);

    emit('stage', {
      jobId,
      step: 'done',
      progress: 100,
      message: `Ready: ${pdfFilename} (v${snapshot.version}, ${resultRecord.pageCount ?? '?'} page)`,
    });
    emit('done', resultRecord);

    return resultRecord;
  }
}
