const IMMUTABLE_SECTION_RE =
  /^(?:education|publications?|awards?|honors?|honours?|certifications?|references?)$/i;

const SKILLS_SECTION_RE = /(?:technical\s+)?skills/i;

/**
 * Fix accidental double-escaped LaTeX commands from JSON output (e.g. `\\textbf` -> `\textbf`, `\%` kept valid)
 * while preserving genuine LaTeX line breaks (`\\` followed by whitespace/newline/bracket).
 */
export function sanitizeLatexCommands(raw) {
  let tex = String(raw || '').trim();
  const fence = tex.match(/^```(?:latex|tex)?\s*([\s\S]*?)\s*```$/i);
  if (fence) {
    tex = fence[1].trim();
  }
  return tex.replace(/\\\\(?=[a-zA-Z%&$#_])/g, '\\');
}

/**
 * Find the matching closing brace `}` index for an opening `{` at `openIdx`,
 * skipping escaped braces (`\{`, `\}`) and `%` line comments.
 */
export function findMatchingBrace(text, openIdx) {
  if (text[openIdx] !== '{') return -1;
  let depth = 0;
  for (let i = openIdx; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '\\') {
      i += 1; // skip escaped char
      continue;
    }
    if (ch === '%') {
      const nl = text.indexOf('\n', i);
      if (nl === -1) break;
      i = nl;
      continue;
    }
    if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

export function hasBalancedLatexBraces(text) {
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if (ch === '%') {
      const nl = text.indexOf('\n', i);
      if (nl === -1) break;
      i = nl;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth < 0) return false;
    }
  }
  return depth === 0;
}

function parseSections(tex) {
  const sections = [];
  const re = /\\section\*?\s*\{/g;
  let match;
  while ((match = re.exec(tex)) !== null) {
    const braceStart = match.index + match[0].length - 1;
    const braceEnd = findMatchingBrace(tex, braceStart);
    if (braceEnd === -1) continue;
    sections.push({
      title: tex.slice(braceStart + 1, braceEnd).trim(),
      headerStart: match.index,
      bodyStart: braceEnd + 1,
    });
  }
  const endDocIdx = tex.indexOf('\\end{document}');
  const docEnd = endDocIdx === -1 ? tex.length : endDocIdx;
  for (let i = 0; i < sections.length; i += 1) {
    sections[i].bodyEnd = i + 1 < sections.length ? sections[i + 1].headerStart : docEnd;
  }
  return sections;
}

function findPrecedingSubheadingLabel(sectionBody, offsetInSection) {
  const prefix = sectionBody.slice(0, offsetInSection);
  const re = /\\resumeSubheading(?:Large)?\s*\{/g;
  let lastLabel = '';
  let m;
  while ((m = re.exec(prefix)) !== null) {
    const open = m.index + m[0].length - 1;
    const close = findMatchingBrace(prefix, open);
    if (close !== -1) {
      lastLabel = prefix.slice(open + 1, close).replace(/\s+/g, ' ').trim();
    }
  }
  return lastLabel;
}

/**
 * Parse a LaTeX master/draft into deterministic editable slots:
 * - Optional `INTRO` (candidate profile blurb if present before first \section)
 * - `B1..Bn` (\resumeItem{...} inside editable sections; skips Education/Publications)
 * - `SKILLS` (the item body of \section{Technical Skills} / \section{Core Skills})
 */
export function extractLatexSlots(tex) {
  const source = String(tex || '');
  if (!source) return { slots: [], hasSlots: false };

  const slots = [];
  const sections = parseSections(source);

  // Optional intro blurb (e.g. summary paragraph between heading and first \section)
  const beginDocIdx = source.indexOf('\\begin{document}');
  if (beginDocIdx !== -1 && sections.length > 0) {
    const preSection = source.slice(beginDocIdx, sections[0].headerStart);
    const smallMatch = preSection.match(/\\begin\{center\}\s*\\small\s*\{/);
    if (smallMatch && smallMatch.index !== undefined) {
      const openIdx = beginDocIdx + smallMatch.index + smallMatch[0].length - 1;
      const closeIdx = findMatchingBrace(source, openIdx);
      if (closeIdx !== -1 && closeIdx < sections[0].headerStart) {
        slots.push({
          id: 'INTRO',
          label: 'Profile Summary',
          kind: 'intro',
          start: openIdx + 1,
          end: closeIdx,
          content: source.slice(openIdx + 1, closeIdx).trim(),
        });
      }
    }
  }

  let bulletCounter = 0;

  for (const sec of sections) {
    if (IMMUTABLE_SECTION_RE.test(sec.title)) {
      continue;
    }

    const body = source.slice(sec.bodyStart, sec.bodyEnd);

    if (SKILLS_SECTION_RE.test(sec.title)) {
      // Match `\item{...}` inside `\small{\item{...}}` or `\item{...}` directly
      const itemMatch = body.match(/\\item\s*\{/);
      if (itemMatch && itemMatch.index !== undefined) {
        const openAbs = sec.bodyStart + itemMatch.index + itemMatch[0].length - 1;
        const closeAbs = findMatchingBrace(source, openAbs);
        if (closeAbs !== -1 && closeAbs <= sec.bodyEnd) {
          slots.push({
            id: 'SKILLS',
            label: sec.title,
            kind: 'skills',
            start: openAbs + 1,
            end: closeAbs,
            content: source.slice(openAbs + 1, closeAbs).trim(),
          });
          continue;
        }
      }
    }

    const itemRe = /\\resumeItem\s*\{/g;
    let m;
    while ((m = itemRe.exec(body)) !== null) {
      const openAbs = sec.bodyStart + m.index + m[0].length - 1;
      const closeAbs = findMatchingBrace(source, openAbs);
      if (closeAbs === -1 || closeAbs > sec.bodyEnd) continue;

      bulletCounter += 1;
      const subLabel = findPrecedingSubheadingLabel(body, m.index);
      slots.push({
        id: `B${bulletCounter}`,
        label: subLabel ? `${sec.title} · ${subLabel}` : sec.title,
        kind: 'bullet',
        start: openAbs + 1,
        end: closeAbs,
        content: source.slice(openAbs + 1, closeAbs).trim(),
      });
    }
  }

  return {
    slots,
    hasSlots: slots.length > 0,
  };
}

/**
 * Apply slot replacements cleanly back onto `baseTex` without altering preamble,
 * personal header, dates, employers, Education, or Publications.
 */
export function applyLatexSlots(baseTex, slotUpdates = []) {
  const source = String(baseTex || '');
  const { slots } = extractLatexSlots(source);
  const byId = new Map(slots.map((s) => [s.id, s]));

  const edits = [];
  const skippedIds = [];

  for (const item of Array.isArray(slotUpdates) ? slotUpdates : []) {
    const id = String(item?.id || '').trim();
    const target = byId.get(id);
    if (!target) {
      if (id) skippedIds.push(id);
      continue;
    }

    const cleaned = sanitizeLatexCommands(item?.latex);
    if (
      !cleaned ||
      cleaned.includes('\\documentclass') ||
      cleaned.includes('\\begin{document}') ||
      cleaned.includes('\\end{document}') ||
      !hasBalancedLatexBraces(cleaned)
    ) {
      skippedIds.push(id);
      continue;
    }

    // Preserve indentation/newline framing for multi-line SKILLS blocks
    const formatted =
      target.kind === 'skills'
        ? `\n    ${cleaned.replace(/\n\s*/g, '\n    ')}\n  `
        : cleaned;

    edits.push({
      id,
      start: target.start,
      end: target.end,
      replacement: formatted,
    });
  }

  // Deduplicate by slot ID (last wins) and splice from end to start
  const uniqueById = new Map(edits.map((e) => [e.id, e]));
  const sorted = [...uniqueById.values()].sort((a, b) => b.start - a.start);

  let nextTex = source;
  for (const edit of sorted) {
    nextTex = nextTex.slice(0, edit.start) + edit.replacement + nextTex.slice(edit.end);
  }

  return {
    latex: nextTex,
    appliedCount: sorted.length,
    skippedIds,
  };
}
