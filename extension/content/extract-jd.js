(() => {
  const MAX_JD_CHARS = 25000;

  const NOISE_BOARD_RE =
    /^(linkedin|indeed|glassdoor|greenhouse|lever|ashby|workday|myworkdayjobs|smartrecruiters|icims|jobvite|taleo|bamboohr|simplify|wellfound|ziprecruiter|monster|dice|careers?|jobs?|apply|job\s+application|job\s+details|search\s+jobs|home|menu|sign\s+in|log\s+in)$/i;

  const LOCATION_ONLY_RE =
    /^(canada|usa?|u\.s\.a?\.?|united\s+states|united\s+kingdom|uk|remote(\s+work)?|hybrid|on[-\s]?site|north\s+america|europe|emea|apac|global|worldwide|toronto|vancouver|montreal|ottawa|waterloo|hamilton|calgary|edmonton|mississauga|markham|ontario|quebec|british\s+columbia|alberta|new\s+york|san\s+francisco|seattle|austin|boston|chicago|los\s+angeles|london|berlin|singapore|india|china|japan|multiple\s+locations)(\s*,\s*[a-z.\s]+)?$/i;

  const ROLE_HINT_RE =
    /\b(engineer|engineering|developer|programmer|swe|sde|mts|architect|intern|internship|co-?op|new\s+grad|graduate|analyst|scientist|researcher|manager|lead|staff|senior|junior|principal|full[-\s]?stack|back[-\s]?end|front[-\s]?end|devops|sre|platform|infrastructure|systems|software|hardware|security|data|ml|ai|machine\s+learning|cloud|mobile|ios|android|web|qa|test|designer|product|barista|cashier|server|associate|crew|clerk|coordinator|specialist|consultant)\b/i;

  function cleanText(raw) {
    return String(raw || '')
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
  }

  function cleanJobTitle(raw) {
    let t = cleanText(raw);
    if (!t) return '';
    t = t
      .replace(/^job\s+application\s+for\s+/i, '')
      .replace(/^apply\s+(?:now\s+)?(?:for|to)\s+/i, '')
      .replace(/\s*[\(\[]\s*(?:remote(?:\s+work)?|hybrid|on[-\s]?site|canada|usa?|uk|toronto|vancouver|montreal|ontario|north\s+america|req(?:uisition)?\s*#?\s*\w+|job\s*id\s*[:#]?\s*\w+|\d{4})[^)\]]*[\)\]]/gi, '')
      .replace(/\s*[-–—|,]\s*(?:remote(?:\s+work)?|hybrid|on[-\s]?site|canada|toronto(?:\s*,\s*on)?|ontario|usa?|united\s+states|req(?:uisition)?\s*#?\s*\w+|job\s*id\s*[:#]?\s*\w+)$/gi, '')
      .trim();
    if (!t || NOISE_BOARD_RE.test(t) || LOCATION_ONLY_RE.test(t)) return '';
    return t;
  }

  function cleanCompany(raw) {
    let c = cleanText(raw);
    if (!c) return '';
    c = c
      .replace(/^at\s+/i, '')
      .replace(/\s+(?:careers?|jobs?)$/i, '')
      .trim();
    if (!c || c.length > 70 || /^wd\d+$/i.test(c) || NOISE_BOARD_RE.test(c) || LOCATION_ONLY_RE.test(c)) return '';
    return c;
  }

  function stripHtml(html) {
    if (!html) return '';
    try {
      const parser = new DOMParser();
      const doc = parser.parseFromString(String(html), 'text/html');
      doc.querySelectorAll('script, style, noscript').forEach((n) => n.remove());
      return cleanText(doc.body?.innerText || doc.body?.textContent || '');
    } catch {
      return cleanText(String(html).replace(/<[^>]+>/g, ' '));
    }
  }

  function firstText(selectors) {
    for (const sel of selectors) {
      try {
        const el = document.querySelector(sel);
        if (!el) continue;
        const txt = cleanText(el.innerText || el.textContent || '');
        if (txt) return txt;
      } catch {
        // ignore bad selector
      }
    }
    return '';
  }

  function parseJsonLdJobPosting() {
    const scripts = document.querySelectorAll('script[type="application/ld+json"]');
    const queue = [];

    for (const script of scripts) {
      try {
        const parsed = JSON.parse(script.textContent || '');
        if (Array.isArray(parsed)) queue.push(...parsed);
        else if (parsed && typeof parsed === 'object') queue.push(parsed);
      } catch {
        // ignore invalid JSON-LD
      }
    }

    while (queue.length > 0) {
      const node = queue.shift();
      if (!node || typeof node !== 'object') continue;
      if (Array.isArray(node['@graph'])) {
        queue.push(...node['@graph']);
      }
      const types = Array.isArray(node['@type']) ? node['@type'] : [node['@type']];
      if (types.some((t) => String(t || '').toLowerCase() === 'jobposting')) {
        const rawCompany =
          (typeof node.hiringOrganization === 'string'
            ? node.hiringOrganization
            : node.hiringOrganization?.name) || '';
        const rawTitle = node.title || node.name || '';
        const description = stripHtml(node.description || '');
        if (description.length >= 80 || rawTitle) {
          return {
            company: cleanCompany(rawCompany),
            jobTitle: cleanJobTitle(rawTitle),
            jobDescription: description.slice(0, MAX_JD_CHARS),
            source: 'json-ld',
          };
        }
      }
    }

    return null;
  }

  function parseTitleHeuristics(pageTitle, hostname) {
    const clean = cleanText(pageTitle);
    let company = '';
    let jobTitle = '';

    // Explicit "Role at Company" pattern
    const atMatch = clean.match(/^(.+?)\s+at\s+([^|\-–—]+)/i);
    if (atMatch) {
      jobTitle = cleanJobTitle(atMatch[1]);
      company = cleanCompany(atMatch[2]);
    } else {
      const parts = clean
        .split(/\s*[|\-–—•·]\s*/)
        .map(cleanText)
        .filter((p) => p && !NOISE_BOARD_RE.test(p) && !LOCATION_ONLY_RE.test(p));

      if (parts.length >= 2) {
        const roleIdx = parts.findIndex((p) => ROLE_HINT_RE.test(p));
        if (roleIdx !== -1) {
          jobTitle = cleanJobTitle(parts[roleIdx]);
          const other = parts.find((p, i) => i !== roleIdx && cleanCompany(p) && !ROLE_HINT_RE.test(p));
          if (other) company = cleanCompany(other);
        } else {
          jobTitle = cleanJobTitle(parts[0]);
          company = cleanCompany(parts[1]);
        }
      } else if (parts.length === 1) {
        if (ROLE_HINT_RE.test(parts[0])) jobTitle = cleanJobTitle(parts[0]);
        else company = cleanCompany(parts[0]);
      }
    }

    if (!company) {
      const ogSite = document.querySelector('meta[property="og:site_name"]')?.getAttribute('content');
      company = cleanCompany(ogSite);
    }

    if (!company && hostname) {
      const cleanHost = hostname.replace(/^www\./i, '');
      const hostParts = cleanHost.split('.');
      // Handle Workday: company.wd1.myworkdayjobs.com
      if (cleanHost.includes('myworkdayjobs.com') && hostParts[0]) {
        company = cleanCompany(hostParts[0]);
      } else {
        const candidate = hostParts.find(
          (p) =>
            p &&
            !/^(jobs|careers|boards|job-boards|apply|hire|talent|recruiting|wd\d+|com|org|io|co|net|ca|us|uk|eu|au|en|fr|de|ai|dev|app|inc|myworkdaysite|workable|breezy|recruitee|eightfold|oraclecloud|successfactors|dayforce|ultipro|paylocity|adp|ukg|avature|phenom|brassring)$/i.test(p) &&
            !NOISE_BOARD_RE.test(p),
        );
        if (candidate) {
          company = cleanCompany(candidate.charAt(0).toUpperCase() + candidate.slice(1));
        }
      }
    }

    return { company, jobTitle };
  }

  function extractSiteSpecific() {
    const host = location.hostname.toLowerCase();

    // LinkedIn Jobs
    if (host.includes('linkedin.com')) {
      const jobTitle = cleanJobTitle(
        firstText([
          '.job-details-jobs-unified-top-card__job-title h1',
          '.job-details-jobs-unified-top-card__job-title',
          '.jobs-unified-top-card__job-title',
          '[data-test-id="job-details-title"]',
          'h1.t-24',
          'main h1',
        ]),
      );
      const company = cleanCompany(
        firstText([
          '.job-details-jobs-unified-top-card__company-name a',
          '.job-details-jobs-unified-top-card__company-name',
          '.jobs-unified-top-card__company-name a',
          '.jobs-unified-top-card__company-name',
          '.jobs-details-top-card__company-url',
          'a[data-tracking-control-name*="company-name"]',
        ]),
      );
      const desc = firstText([
        '#job-details',
        '.jobs-description__content',
        '.jobs-box__html-content',
        '.jobs-description-content__text',
        '.show-more-less-html__markup',
      ]);
      if (desc.length >= 80) {
        return { company, jobTitle, jobDescription: desc.slice(0, MAX_JD_CHARS), source: 'linkedin' };
      }
    }

    // Greenhouse
    if (host.includes('greenhouse.io')) {
      const jobTitle = cleanJobTitle(firstText(['.app-title', 'h1.section-header', 'h1']));
      const company = cleanCompany(
        firstText(['.company-name']) || location.pathname.split('/').filter(Boolean)[0] || '',
      );
      const desc = firstText(['#content', '.job__description', 'main']);
      if (desc.length >= 80) {
        return { company, jobTitle, jobDescription: desc.slice(0, MAX_JD_CHARS), source: 'greenhouse' };
      }
    }

    // Lever
    if (host.includes('lever.co')) {
      const jobTitle = cleanJobTitle(firstText(['.posting-headline h2', 'h1', 'h2']));
      const company = cleanCompany(
        location.pathname.split('/').filter(Boolean)[0] ||
          document.querySelector('meta[property="og:site_name"]')?.getAttribute('content') ||
          '',
      );
      const desc = firstText(['.section-wrapper.page-full-width', '.content', 'main']);
      if (desc.length >= 80) {
        return { company, jobTitle, jobDescription: desc.slice(0, MAX_JD_CHARS), source: 'lever' };
      }
    }

    // Ashby
    if (host.includes('ashbyhq.com')) {
      const jobTitle = cleanJobTitle(firstText(['h1']));
      const company = cleanCompany(location.pathname.split('/').filter(Boolean)[0] || '');
      const desc = firstText(['[data-testid="job-posting-description"]', 'main', 'article']);
      if (desc.length >= 80) {
        return { company, jobTitle, jobDescription: desc.slice(0, MAX_JD_CHARS), source: 'ashby' };
      }
    }

    // Workday
    if (
      host.includes('myworkdayjobs.com') ||
      host.includes('myworkdaysite.com') ||
      host.includes('workday.com')
    ) {
      const jobTitle = cleanJobTitle(
        firstText(['[data-automation-id="jobPostingHeader"]', 'h2[data-automation-id]', 'h1']),
      );
      const company = cleanCompany(host.split('.')[0] || '');
      const desc = firstText(['[data-automation-id="jobPostingDescription"]', 'main']);
      if (desc.length >= 80) {
        return { company, jobTitle, jobDescription: desc.slice(0, MAX_JD_CHARS), source: 'workday' };
      }
    }

    // Indeed
    if (/(?:^|\.)indeed\./.test(host)) {
      const jobTitle = cleanJobTitle(
        firstText(['h1.jobsearch-JobInfoHeader-title', '[data-testid="jobsearch-JobInfoHeader-title"]', 'h1']),
      );
      const company = cleanCompany(
        firstText([
          '[data-testid="inlineHeader-companyName"] a',
          '[data-testid="inlineHeader-companyName"]',
          '.jobsearch-InlineCompanyRating a',
        ]),
      );
      const desc = firstText(['#jobDescriptionText', '.jobsearch-jobDescriptionText']);
      if (desc.length >= 80) {
        return { company, jobTitle, jobDescription: desc.slice(0, MAX_JD_CHARS), source: 'indeed' };
      }
    }

    return null;
  }

  function extractGenericContent() {
    const candidates = [
      document.querySelector('[itemprop="description"]'),
      document.querySelector('[class*="job-description" i]'),
      document.querySelector('[id*="job-description" i]'),
      document.querySelector('[class*="jobDescription" i]'),
      document.querySelector('main'),
      document.querySelector('article'),
      document.querySelector('[role="main"]'),
      document.body,
    ].filter(Boolean);

    for (const el of candidates) {
      const text = cleanText(el.innerText || el.textContent || '');
      if (text.length >= 120) {
        return text.slice(0, MAX_JD_CHARS);
      }
    }

    return cleanText(document.body?.innerText || '').slice(0, MAX_JD_CHARS);
  }

  const selection = cleanText(window.getSelection()?.toString() || '').slice(0, MAX_JD_CHARS);
  const jsonLd = parseJsonLdJobPosting();
  const specific = extractSiteSpecific();
  const titleHints = parseTitleHeuristics(document.title, location.hostname);

  const rawH1 = firstText(['main h1', 'article h1', 'h1']);
  const h1Title = rawH1.length <= 100 ? cleanJobTitle(rawH1) : '';

  const company = specific?.company || jsonLd?.company || titleHints.company || '';
  const jobTitle = specific?.jobTitle || jsonLd?.jobTitle || h1Title || titleHints.jobTitle || '';

  const JD_SECTION_PATTERNS = [
    /\bresponsibilities\b/i,
    /\bqualifications\b/i,
    /\brequirements\b/i,
    /\bwhat you(?:'ll| will) do\b/i,
    /\babout the role\b/i,
    /\bminimum qualifications\b/i,
    /\bpreferred qualifications\b/i,
    /\byou have\b/i,
    /\bexperience with\b/i,
    /\bbachelor(?:'s)?\b/i,
    /\bequal opportunity\b/i,
  ];

  const JOB_URL_RE =
    /(?:\/(?:jobs?|careers?|positions?|openings?|postings?|requisitions?|vacancies|role)\b|[?&](?:currentJobId|gh_jid|ashby_jid|jk|vjk|jobId|requisitionId)=)/i;

  function detectJobPage({ specific, jsonLd, jobTitle, jobDescription }) {
    const host = location.hostname.toLowerCase();
    const isLinkedInJobsRoute = host.includes('linkedin.com') && /^\/jobs\b/i.test(location.pathname);

    // Wait for LinkedIn Jobs SPA right-hand pane instead of scraping search card lists
    if (isLinkedInJobsRoute && !specific) {
      return { isJobPage: false, pendingSpaLoad: true };
    }

    if (specific && specific.jobDescription?.length >= 80) {
      return { isJobPage: true, pendingSpaLoad: false };
    }
    if (jsonLd && (jsonLd.jobDescription?.length >= 80 || jsonLd.jobTitle)) {
      return { isJobPage: true, pendingSpaLoad: false };
    }

    const hasExplicitJdContainer = Boolean(
      document.querySelector(
        '[itemprop="description"], [class*="job-description" i], [id*="job-description" i], [class*="jobDescription" i]',
      ),
    );
    if (hasExplicitJdContainer && jobDescription.length >= 200) {
      return { isJobPage: true, pendingSpaLoad: false };
    }

    const jdSignals = JD_SECTION_PATTERNS.reduce(
      (count, re) => count + (re.test(jobDescription) ? 1 : 0),
      0,
    );
    const hasJobUrl = JOB_URL_RE.test(location.pathname + location.search);

    if (hasJobUrl && jobDescription.length >= 250 && (jdSignals >= 2 || Boolean(jobTitle))) {
      return { isJobPage: true, pendingSpaLoad: false };
    }
    if (jobDescription.length >= 450 && jdSignals >= 3) {
      return { isJobPage: true, pendingSpaLoad: false };
    }

    const maybeSpaLoading =
      (host.includes('myworkdayjobs.com') ||
        host.includes('myworkdaysite.com') ||
        /(?:^|\.)indeed\./.test(host) ||
        hasJobUrl) &&
      jobDescription.length < 200;

    return { isJobPage: false, pendingSpaLoad: maybeSpaLoading };
  }

  let jobDescription = '';
  let extractorSource = 'generic';

  if (selection.length >= 100) {
    jobDescription = selection;
    extractorSource = 'selection';
  } else if (specific?.jobDescription) {
    jobDescription = specific.jobDescription;
    extractorSource = specific.source;
  } else if (jsonLd?.jobDescription) {
    jobDescription = jsonLd.jobDescription;
    extractorSource = 'json-ld';
  } else {
    jobDescription = extractGenericContent();
    extractorSource = 'generic';
  }

  const { isJobPage, pendingSpaLoad } = detectJobPage({
    specific,
    jsonLd,
    jobTitle,
    jobDescription,
  });

  return {
    url: location.href,
    pageTitle: document.title || '',
    company,
    jobTitle,
    jobDescription,
    selection,
    extractorSource,
    isJobPage,
    pendingSpaLoad,
  };
})();
