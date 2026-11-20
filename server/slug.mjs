import path from 'node:path';

const CORP_SUFFIX_RE =
  /\b(inc\.?|incorporated|corp\.?|corporation|ltd\.?|limited|llc|l\.l\.c\.?|plc|co\.?|company|technologies|labs?)\s*$/i;

const TITLE_NOISE_RE =
  /\s*[\(\[]\s*(?:remote(?:\s+work)?|hybrid|on[-\s]?site|canada|usa?|uk|toronto|vancouver|montreal|ontario|north\s+america|req(?:uisition)?\s*#?\s*\w+|job\s*id\s*[:#]?\s*\w+|\d{4})[^)\]]*[\)\]]/gi;

const TITLE_TRAILING_NOISE_RE =
  /(?:[-–—|,\s]+(?:remote(?:\s+work)?|hybrid|on[-\s]?site|canada|toronto|ontario|usa?|united\s+states))+$/i;

/**
 * Convert an arbitrary company name or job title into a clean lowercase kebab-case slug.
 */
export function slugifySegment(
  raw,
  { fallback = 'untitled', maxLength = 44, stripCorpSuffix = false, stripTitleNoise = false } = {},
) {
  let value = String(raw || '').trim();
  if (!value) return fallback;

  if (stripTitleNoise) {
    value = value.replace(TITLE_NOISE_RE, '').replace(TITLE_TRAILING_NOISE_RE, '').trim();
  }

  // Normalize accented characters and ampersands
  value = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .replace(/\+/g, ' plus ')
    .replace(/#/g, ' sharp ');

  if (stripCorpSuffix) {
    value = value.replace(CORP_SUFFIX_RE, '').trim();
  }

  let slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');

  if (!slug) return fallback;

  if (slug.length > maxLength) {
    const truncated = slug.slice(0, maxLength);
    const lastDash = truncated.lastIndexOf('-');
    slug = lastDash >= Math.floor(maxLength * 0.5) ? truncated.slice(0, lastDash) : truncated;
    slug = slug.replace(/-+$/g, '');
  }

  return slug || fallback;
}

/**
 * Build canonical folder name and exact requested PDF filename:
 * resume-{companyname}-{jobtitle}.pdf
 */
export function buildOutputNames(companyName, jobTitle) {
  const companySlug = slugifySegment(companyName, {
    fallback: 'company',
    maxLength: 36,
    stripCorpSuffix: true,
  });
  const jobTitleSlug = slugifySegment(jobTitle, {
    fallback: 'role',
    maxLength: 48,
    stripCorpSuffix: false,
    stripTitleNoise: true,
  });

  const folderSlug = `${companySlug}-${jobTitleSlug}`;
  const pdfFilename = `resume-${companySlug}-${jobTitleSlug}.pdf`;

  return {
    companySlug,
    jobTitleSlug,
    folderSlug,
    pdfFilename,
  };
}

/**
 * Safely resolve a child directory inside tailoredRoot, rejecting traversal attempts.
 */
export function resolveSafeTailoredDir(resumeRepoDir, folderSlug) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(folderSlug)) {
    throw new Error(`Unsafe folder slug: ${folderSlug}`);
  }
  const tailoredRoot = path.resolve(resumeRepoDir, 'tailored');
  const targetDir = path.resolve(tailoredRoot, folderSlug);
  if (targetDir !== tailoredRoot && !targetDir.startsWith(tailoredRoot + path.sep)) {
    throw new Error(`Refusing path outside tailored directory: ${targetDir}`);
  }
  return { tailoredRoot, targetDir };
}
