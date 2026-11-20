const PARTTIME_KEYWORDS = [
  'barista',
  'cashier',
  'server',
  'waiter',
  'waitress',
  'retail',
  'sales associate',
  'hospitality',
  'dishwasher',
  'kitchen',
  'food service',
  'hostess',
  'bussing',
  'store associate',
  'stocking',
  'warehouse associate',
  'crew member',
  'front desk',
  'housekeeping',
  'delivery driver',
];

const TECH_KEYWORDS = [
  'software',
  'engineer',
  'developer',
  'backend',
  'frontend',
  'full-stack',
  'fullstack',
  'infrastructure',
  'devops',
  'sre',
  'kubernetes',
  'python',
  'golang',
  'typescript',
  'react',
  'machine learning',
  'data engineer',
  'platform',
  'cloud',
  'intern',
  'co-op',
  'new grad',
  'swe',
];

const SLOT_ARRAY_SCHEMA = {
  type: 'array',
  description:
    'Compact targeted LaTeX slot replacements ([{id, latex}]). Omit unmodified slots. Keep braces balanced and single backslashes.',
  items: {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'latex'],
    properties: {
      id: { type: 'string' },
      latex: { type: 'string' },
    },
  },
};

export const TAILOR_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'companyName',
    'jobTitle',
    'masterUsed',
    'tailoredLatex',
    'matchedKeywords',
    'missingKeywords',
    'changeSummary',
  ],
  properties: {
    companyName: {
      type: 'string',
      description: 'Clean hiring company name (short canonical name, e.g. Acme, Stripe, Google).',
    },
    jobTitle: {
      type: 'string',
      description: 'Clean target job title (e.g. Software Engineer Backend, New Grad SWE).',
    },
    masterUsed: {
      type: 'string',
      description: 'Filename of the master resume used (e.g. resume.tex or resume-parttime.tex).',
    },
    slots: SLOT_ARRAY_SCHEMA,
    tailoredLatex: {
      type: 'string',
      description:
        'Leave empty "" when returning `slots`. Otherwise provide the complete valid LaTeX document from \\documentclass to \\end{document} fitting strictly on 1 page.',
    },
    matchedKeywords: {
      type: 'array',
      items: { type: 'string' },
      description: 'Important JD keywords honestly supported by the master resume.',
    },
    missingKeywords: {
      type: 'array',
      items: { type: 'string' },
      description: 'Important JD requirements NOT present in the master resume (never fabricated).',
    },
    changeSummary: {
      type: 'array',
      items: { type: 'string' },
      description: 'Concise bullets summarizing what changed.',
    },
  },
};

export const REPAIR_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['tailoredLatex', 'fixNotes'],
  properties: {
    slots: SLOT_ARRAY_SCHEMA,
    tailoredLatex: {
      type: 'string',
      description:
        'Leave "" when using `slots`. Otherwise complete repaired LaTeX from \\documentclass to \\end{document} fitting strictly on 1 page.',
    },
    fixNotes: {
      type: 'array',
      items: { type: 'string' },
      description: 'Short notes describing what was tightened or repaired.',
    },
  },
};

export const FEEDBACK_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['tailoredLatex', 'matchedKeywords', 'missingKeywords', 'changeSummary'],
  properties: {
    slots: SLOT_ARRAY_SCHEMA,
    tailoredLatex: {
      type: 'string',
      description:
        'Leave "" when using `slots`. Otherwise complete revised LaTeX from \\documentclass to \\end{document} fitting strictly on 1 page.',
    },
    matchedKeywords: { type: 'array', items: { type: 'string' } },
    missingKeywords: { type: 'array', items: { type: 'string' } },
    changeSummary: { type: 'array', items: { type: 'string' } },
  },
};

export const CHAT_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['intent', 'reply'],
  properties: {
    intent: {
      type: 'string',
      enum: ['qa', 'edit', 'generate'],
      description:
        "Classify the user message: 'qa' for questions, advice, gap analysis, cover letters, outreach messages, or interview prep (no PDF edit); 'edit' to modify the current tailored resume draft; 'generate' to tailor from the master when no draft exists or when starting fresh.",
    },
    reply: {
      type: 'string',
      description:
        "Helpful, concise response for the chat UI. For 'qa', include the complete answer. For 'edit'/'generate', briefly summarize the updates and any honest gaps.",
    },
    companyName: { type: 'string' },
    jobTitle: { type: 'string' },
    masterUsed: { type: 'string' },
    slots: SLOT_ARRAY_SCHEMA,
    tailoredLatex: {
      type: 'string',
      description:
        "Use ONLY when no slot list applies or structural layout outside slots must change. Leave \"\" for 'qa' or when returning `slots`.",
    },
    matchedKeywords: { type: 'array', items: { type: 'string' } },
    missingKeywords: { type: 'array', items: { type: 'string' } },
    changeSummary: { type: 'array', items: { type: 'string' } },
  },
};

export const UNIFIED_OUTPUT_SCHEMA = CHAT_OUTPUT_SCHEMA;

export function selectMasterResume({ requestedMaster, jobTitle = '', jobDescription = '', availableMasters = [] }) {
  const filenames = availableMasters.map((m) => m.filename);
  if (requestedMaster && requestedMaster !== 'auto' && filenames.includes(requestedMaster)) {
    return requestedMaster;
  }

  const combined = `${jobTitle}\n${jobDescription}`.toLowerCase();
  const parttimeScore = PARTTIME_KEYWORDS.reduce(
    (score, kw) => score + (combined.includes(kw) ? 1 : 0),
    0,
  );
  const techScore = TECH_KEYWORDS.reduce(
    (score, kw) => score + (combined.includes(kw) ? 1 : 0),
    0,
  );

  if (parttimeScore >= 2 && techScore === 0 && filenames.includes('resume-parttime.tex')) {
    return 'resume-parttime.tex';
  }
  if (filenames.includes('resume.tex')) {
    return 'resume.tex';
  }
  return filenames[0] || 'resume.tex';
}

/**
 * Extract only tailoring & writing-rubric rules from SKILL.md (omits CLI/git/cover-letter workflows
 * to cut prompt tokens dramatically without losing quality rules).
 */
export function condenseSkillDoc(skillDoc = '') {
  const text = String(skillDoc || '').trim();
  if (!text) return '';
  if (text.length <= 2200) return text;

  const startMarker = text.indexOf('### Tailoring rules');
  const endMarker = text.indexOf('## 3. Hand off');
  if (startMarker !== -1 && endMarker > startMarker) {
    return text.slice(startMarker, endMarker).trim().slice(0, 2600);
  }
  return text.slice(0, 2200);
}

function buildJobMetaLines({ companyHint, jobTitleHint, companyManual, jobTitleManual, pageTitle, sourceUrl }) {
  const lines = [];
  if (companyHint) {
    lines.push(
      companyManual
        ? `User-specified Company (preserve exactly): ${companyHint}`
        : `Unverified scraped Company hint (ignore if location/job-board/wrong; read real company from JD/URL): ${companyHint}`,
    );
  }
  if (jobTitleHint) {
    lines.push(
      jobTitleManual
        ? `User-specified Job Title (preserve exactly): ${jobTitleHint}`
        : `Unverified scraped Job Title hint (ignore if noisy/wrong; extract concise core title from JD): ${jobTitleHint}`,
    );
  }
  if (pageTitle) lines.push(`Browser Page Title: ${pageTitle}`);
  if (sourceUrl) lines.push(`Source URL: ${sourceUrl}`);
  return lines;
}

function buildCompanyTitleRequirements({ masterFilename, companyHint, jobTitleHint, companyManual, jobTitleManual }) {
  return [
    `- Set \`masterUsed\` to "${masterFilename}".`,
    '- `companyName`: canonical short hiring company name from the JD/URL (e.g. "Acme", "Stripe", "Google"). NEVER output a location ("Canada", "Toronto", "Remote") or job board ("LinkedIn", "Workday", "Greenhouse").' +
      (companyManual && companyHint ? ` (User specified "${companyHint}" — preserve it.)` : ''),
    '- `jobTitle`: concise core role title (2–5 words, e.g. "Backend Software Engineer"). Strip locations, work mode ("Remote Work", "Hybrid"), req IDs, and parentheticals.' +
      (jobTitleManual && jobTitleHint ? ` (User specified "${jobTitleHint}" — preserve it.)` : ''),
  ];
}

export function formatSlotsForPrompt(slots = []) {
  return slots.map((s) => `[${s.id}] (${s.label})\n${s.content}`).join('\n\n');
}

export function buildTailorPrompt({
  skillDoc,
  masterFilename,
  masterLatex,
  slots = [],
  jobDescription,
  companyHint = '',
  jobTitleHint = '',
  companyManual = false,
  jobTitleManual = false,
  pageTitle = '',
  sourceUrl = '',
  userPrompt = '',
  polishPasses = 1,
  unified = false,
}) {
  const trimmedJd = String(jobDescription || '').trim().slice(0, 14_000);
  const trimmedCustom = String(userPrompt || '').trim();
  const useSlots = Array.isArray(slots) && slots.length > 0;
  const condensedSkill = condenseSkillDoc(skillDoc);

  const sections = [
    'Tailor the candidate\'s local LaTeX resume to the target job description.',
    'EXECUTION & STRICT GROUNDING RULES:',
    '- Do NOT call any file, shell, or web tools. Everything needed is inline below.',
    '- Return ONLY raw JSON conforming strictly to the JSON Schema (NO markdown fences).',
    ...(unified ? ['- Set `intent: "generate"` and write a brief tailored summary in `reply`.'] : []),
    '- NEVER invent skills, tools, metrics, employers, titles, or dates absent from the master resume (unless confirmed by the user below). Put missing JD requirements ONLY in `missingKeywords`.',
    '- Preserve valid LaTeX (`\\%`, `\\&`, `\\$`, `\\#`, `\\_`, `\\textbf{...}`) with single backslashes (keep `\\\\` line breaks in SKILLS). Keep total output strictly to **1 US Letter page**.',
    `- Apply ${polishPasses} writing critique pass(es): strong action verbs, CAR structure, keep every original number/tool, <=~35 words/bullet, no first-person pronouns, no em dashes or \`--\` in prose bullets, no stock buzzwords (spearheaded/leveraged/orchestrated/utilized/synergy).`,
    ...(useSlots
      ? [
          '- OPTIMIZED SLOT OUTPUT: Return ONLY changed `[id]` items in `slots: [{id, latex}]` and leave `tailoredLatex: ""`. Preamble, contact info, Education, Publications, dates, and employers stay locked automatically.',
          '- Only use `tailoredLatex` if the user explicitly requested structural changes outside those slots.',
        ]
      : [
          '- Output complete valid LaTeX in `tailoredLatex` (`\\documentclass` to `\\end{document}`), preserving `\\input{glyphtounicode}` and `\\pdfgentounicode=1`.',
        ]),
    ...buildCompanyTitleRequirements({ masterFilename, companyHint, jobTitleHint, companyManual, jobTitleManual }),
  ];

  if (condensedSkill) {
    sections.push('\n=== TAILORING RUBRIC ===\n' + condensedSkill);
  }

  const jobMetaLines = buildJobMetaLines({
    companyHint,
    jobTitleHint,
    companyManual,
    jobTitleManual,
    pageTitle,
    sourceUrl,
  });

  sections.push(
    '\n=== TARGET JOB DESCRIPTION ===\n' +
      (jobMetaLines.length ? jobMetaLines.join('\n') + '\n\n' : '') +
      trimmedJd,
  );

  if (useSlots) {
    sections.push(`\n=== MASTER EDITABLE SLOTS (${masterFilename}) ===\n` + formatSlotsForPrompt(slots));
  } else {
    sections.push(`\n=== MASTER RESUME (${masterFilename}) ===\n\`\`\`latex\n${masterLatex.trim()}\n\`\`\``);
  }

  if (trimmedCustom) {
    sections.push('\n=== USER CUSTOM INSTRUCTIONS (HIGH PRIORITY) ===\n' + trimmedCustom);
  }

  return sections.join('\n');
}

export function buildRepairPrompt({
  masterLatex,
  previousLatex,
  slots = [],
  compileResult,
  sessionSeeded = false,
  unified = false,
}) {
  const issues = [];
  if (!compileResult.ok) {
    issues.push(
      `LaTeX compilation failed (exit ${compileResult.exitCode}):\n` +
        (compileResult.logSummary.errors.length
          ? compileResult.logSummary.errors.join('\n')
          : compileResult.stdoutTail.slice(-1000)),
    );
  }
  if (compileResult.logSummary.pageCount && compileResult.logSummary.pageCount !== 1) {
    issues.push(
      `Page count is ${compileResult.logSummary.pageCount} (MUST be strictly 1 page). Tighten verbose bullets cleanly without dropping roles, education, or factual metrics.`,
    );
  }
  if (compileResult.logSummary.hasSevereOverfull) {
    issues.push(
      `Severe Overfull warnings:\n${compileResult.logSummary.overfullHbox
        .slice(0, 5)
        .map((w) => `- ${w.raw}`)
        .join('\n')}`,
    );
  }

  const useSlots = Array.isArray(slots) && slots.length > 0 && compileResult.ok;
  const sections = [
    'Fix the LaTeX/layout issues below so the resume compiles cleanly to strictly **1 page** with minimal overfull warnings.',
    '- Do NOT call tools; return ONLY raw JSON.',
    ...(unified ? ['- Set `intent: "edit"` and briefly note fixes in `reply`.'] : []),
    '- Keep all facts, numbers, dates, and escapes valid (`\\%`, `\\&`, `\\$`, `\\_`).',
    ...(useSlots
      ? ['- Return ONLY updated slots in `slots` (leave `tailoredLatex: ""`).']
      : ['- Return complete fixed LaTeX in `tailoredLatex` (and `slots: []`).']),
    '\n=== ISSUES TO FIX ===\n' + issues.join('\n\n'),
  ];

  if (useSlots) {
    sections.push('\n=== CURRENT SLOTS ===\n' + formatSlotsForPrompt(slots));
  } else {
    sections.push(`\n=== PREVIOUS LATEX ===\n\`\`\`latex\n${previousLatex.trim()}\n\`\`\``);
    if (!sessionSeeded) {
      sections.push(`\n=== MASTER RESUME (REFERENCE) ===\n\`\`\`latex\n${masterLatex.trim()}\n\`\`\``);
    }
  }

  return sections.join('\n');
}

export function buildFeedbackPrompt({
  skillDoc,
  masterFilename,
  masterLatex,
  currentLatex,
  slots = [],
  jobDescription,
  companyName = '',
  jobTitle = '',
  feedback = '',
  polishPasses = 1,
}) {
  const trimmedJd = String(jobDescription || '').trim().slice(0, 12_000);
  const useSlots = Array.isArray(slots) && slots.length > 0;
  const condensedSkill = condenseSkillDoc(skillDoc);

  const sections = [
    'Revise the tailored resume from user feedback while keeping strictly 1 page and zero fabricated facts.',
    '- Do NOT call tools; return ONLY raw JSON.',
    `- Apply ${polishPasses} writing critique pass(es) on changed lines (CAR, <=~35 words, no buzzwords, valid LaTeX single backslashes).`,
    ...(useSlots
      ? ['- Return ONLY modified `[id]` slots in `slots` (leave `tailoredLatex: ""`, or set `tailoredLatex` only if structural section edits are needed).']
      : ['- Return complete revised LaTeX in `tailoredLatex`.']),
    `\n=== TARGET ROLE ===\nCompany: ${companyName || 'Target Company'} | Job Title: ${jobTitle || 'Target Role'} | Master: ${masterFilename}`,
    '\n=== USER FEEDBACK ===\n' + String(feedback || '').trim(),
  ];

  if (useSlots) {
    sections.push('\n=== CURRENT DRAFT SLOTS ===\n' + formatSlotsForPrompt(slots));
  } else {
    sections.push(`\n=== CURRENT LATEX DRAFT ===\n\`\`\`latex\n${currentLatex.trim()}\n\`\`\``);
  }

  sections.push(`\n=== MASTER RESUME (${masterFilename}, FACT REFERENCE) ===\n\`\`\`latex\n${masterLatex.trim()}\n\`\`\``);
  if (condensedSkill) sections.push('\n=== RUBRIC ===\n' + condensedSkill);
  if (trimmedJd) sections.push('\n=== JOB DESCRIPTION ===\n' + trimmedJd);

  return sections.join('\n');
}

export function buildChatPrompt({
  skillDoc,
  masterFilename,
  masterLatex,
  currentLatex = '',
  slots = [],
  hasDraft = false,
  jobDescription = '',
  companyName = '',
  jobTitle = '',
  companyManual = false,
  jobTitleManual = false,
  pageTitle = '',
  sourceUrl = '',
  history = [],
  userMessage = '',
  polishPasses = 1,
  sessionSeeded = false,
}) {
  const useSlots = Array.isArray(slots) && slots.length > 0;
  const recentHistory = (Array.isArray(history) ? history : [])
    .slice(-6)
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${String(m.text || '').trim().slice(0, 800)}`)
    .filter(Boolean);

  // Fast delta prompt when reusing the already-seeded hot worker for the same job
  if (sessionSeeded) {
    const deltaSections = [
      'Continue this resume session:',
      '- Choose `intent`: `"qa"` (questions/advice/cover letter/outreach — no PDF edit, set `slots: []`, `tailoredLatex: ""`), `"edit"` (modify current draft), or `"generate"` (rebuild from scratch).',
      '- NEVER fabricate skills/metrics absent from master unless confirmed by the user.',
      ...(useSlots
        ? ['- For edits, return ONLY changed `[id]` slots in `slots` (leave `tailoredLatex: ""`) unless structural/section changes outside slots are requested. Keep strictly 1 page and single LaTeX backslashes.']
        : ['- For edits/generate, return complete valid 1-page LaTeX in `tailoredLatex`.']),
      userMessage ? `\n=== USER MESSAGE ===\n${String(userMessage).trim()}` : '',
    ];
    if (useSlots && hasDraft) {
      deltaSections.push('\n=== CURRENT DRAFT SLOTS (for ID reference) ===\n' + formatSlotsForPrompt(slots));
    }
    return deltaSections.filter(Boolean).join('\n');
  }

  const trimmedJd = String(jobDescription || '').trim().slice(0, 12_000);
  const condensedSkill = condenseSkillDoc(skillDoc);

  const sections = [
    'You are a local Resume Tailor assistant inside the user\'s Chrome sidebar.',
    'INTENT ROUTING (CHOOSE ONE `intent`):',
    '1. `"qa"` — Questions, gap analysis, cover letter, outreach DM, interview prep (no PDF edit). Set `slots: []`, `tailoredLatex: ""`, full answer in `reply`.',
    hasDraft
      ? '2. `"edit"` — Modify, shorten, reorder, or fix the current draft (keep 1 page & grounded facts; summarize changes in `reply`).'
      : '2. `"generate"` — No draft exists yet; generate a 1-page tailored resume from master (summarize in `reply`).',
    ...(hasDraft ? ['3. `"generate"` — Only if user asks to start fresh or switch master resume.'] : []),
    '',
    'RULES:',
    '- No external tool calls; return ONLY raw JSON matching schema.',
    '- Never fabricate facts/metrics/skills missing from master (unless user confirms).',
    ...(useSlots
      ? ['- For `"edit"`/`"generate"`, prefer compact `slots: [{id, latex}]` (leave `tailoredLatex: ""`) with single LaTeX backslashes; use `tailoredLatex` only for structural section changes outside slots.']
      : ['- For `"edit"`/`"generate"`, output complete valid 1-page LaTeX in `tailoredLatex`.']),
    `- ${polishPasses} writing critique pass(es) (CAR, <=~35 words/bullet, no buzzwords, valid escapes).`,
    ...buildCompanyTitleRequirements({
      masterFilename,
      companyHint: companyName,
      jobTitleHint: jobTitle,
      companyManual,
      jobTitleManual,
    }),
  ];

  if (condensedSkill) sections.push('\n=== RUBRIC ===\n' + condensedSkill);

  const jobMeta = buildJobMetaLines({
    companyHint: companyName,
    jobTitleHint: jobTitle,
    companyManual,
    jobTitleManual,
    pageTitle,
    sourceUrl,
  });
  if (jobMeta.length || trimmedJd) {
    sections.push(
      '\n=== ACTIVE JOB DESCRIPTION ===\n' +
        (jobMeta.length ? jobMeta.join('\n') + '\n\n' : '') +
        (trimmedJd || '(No job description loaded yet)'),
    );
  }

  if (useSlots) {
    sections.push(
      `\n=== ${hasDraft ? 'CURRENT DRAFT SLOTS' : 'MASTER EDITABLE SLOTS'} (${masterFilename}) ===\n` +
        formatSlotsForPrompt(slots),
    );
  } else {
    if (hasDraft && currentLatex) {
      sections.push(`\n=== CURRENT LATEX DRAFT ===\n\`\`\`latex\n${currentLatex.trim()}\n\`\`\``);
    }
    sections.push(`\n=== MASTER RESUME (${masterFilename}) ===\n\`\`\`latex\n${masterLatex.trim()}\n\`\`\``);
  }

  if (recentHistory.length > 0) {
    sections.push('\n=== RECENT CONVERSATION ===\n' + recentHistory.join('\n'));
  }

  sections.push('\n=== USER MESSAGE ===\n' + String(userMessage || '').trim());

  return sections.join('\n');
}

export function buildJobMarkdown({
  companyName,
  jobTitle,
  sourceUrl,
  extractedKeywords,
  matchedKeywords,
  missingKeywords,
  jobDescription,
}) {
  const kw = extractedKeywords || {};
  const listSection = (heading, items) => {
    if (!Array.isArray(items) || items.length === 0) return null;
    return `- **${heading}:**\n${items.map((item) => `  - ${item}`).join('\n')}`;
  };

  const parts = [
    listSection('Education Requirements', kw.educationRequirements),
    listSection('Required Skills', kw.requiredSkills),
    listSection('Preferred Skills', kw.preferredSkills),
    listSection('Experience Requirements', kw.experienceRequirements),
    listSection('Key Responsibilities', kw.keyResponsibilities),
    listSection('Domain Keywords', kw.domainKeywords),
    listSection('Matched Keywords', matchedKeywords),
    listSection('Missing Requirements (Not on Master)', missingKeywords),
  ].filter(Boolean);

  return [
    `# ${companyName} — ${jobTitle}`,
    '',
    sourceUrl ? `**Source:** ${sourceUrl}\n` : '',
    '## Extracted Keywords & Requirements',
    '',
    parts.length ? parts.join('\n') : '_No structured keywords extracted._',
    '',
    '---',
    '',
    '## Original Job Description',
    '',
    String(jobDescription || '').trim(),
    '',
  ]
    .filter((line, idx, arr) => !(line === '' && arr[idx - 1] === ''))
    .join('\n');
}
