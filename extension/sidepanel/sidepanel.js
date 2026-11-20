import {
  clearSavedFolder,
  getSavedFolder,
  isFolderPickerSupported,
  pickOutputFolder,
  requestFolderPermission,
  writePdfToFolder,
} from './folder-store.js';

const DEFAULT_SETTINGS = {
  serverUrl: 'http://127.0.0.1:8787',
  agentId: 'antigravity',
  model: '',
  customModel: '',
  effort: 'low',
  apiProvider: 'openai',
  apiKey: '',
  apiBaseUrl: '',
  masterResume: 'auto',
  autoSaveAs: true,
  fastMode: true,
};

const TRACKING_QUERY_PARAMS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
  'trk',
  'trkid',
  'trkinfo',
  'refid',
  'trackingid',
  'ebp',
  'recommendedflavor',
  'misid',
  'fbclid',
  'gclid',
  'mc_cid',
  'mc_eid',
  'lipi',
]);

const state = {
  settings: { ...DEFAULT_SETTINGS },
  health: null,
  hostWindowId: null,
  sessionKey: crypto.randomUUID(),
  sessionUrl: '',
  sessionToken: 0,
  sourceUrl: '',
  pageTitle: '',
  companyManual: false,
  jobTitleManual: false,
  folder: null,
  activeAbortController: null,
  lastResult: null,
  viewingVersion: null,
  messages: [], // { role: 'user'|'assistant', text, intent?, result?, missingKeywords? }
  navDebounceTimer: null,
  navRetryTimer: null,
  navCheckSeq: 0,
  toastReturnFocusEl: null,
  toastTimer: null,
};

const els = {
  btnStatusDot: document.getElementById('btn-status-dot'),
  statusShort: document.getElementById('status-short'),
  btnReconnect: document.getElementById('btn-reconnect'),
  btnOpenHistory: document.getElementById('btn-open-history'),
  btnOpenSettings: document.getElementById('btn-open-settings'),
  alertStrip: document.getElementById('alert-strip'),
  alertStripText: document.getElementById('alert-strip-text'),
  btnRetryHealth: document.getElementById('btn-retry-health'),

  jobHeadline: document.getElementById('job-headline'),
  filenamePreview: document.getElementById('filename-preview-text'),
  jdCountBadge: document.getElementById('jd-count-badge'),
  btnExtractTab: document.getElementById('btn-extract-tab'),
  btnToggleJobEdit: document.getElementById('btn-toggle-job-edit'),
  jobEditor: document.getElementById('job-editor'),
  companyInput: document.getElementById('company-input'),
  jobTitleInput: document.getElementById('job-title-input'),
  jdTextarea: document.getElementById('jd-textarea'),

  btnGenerate: document.getElementById('btn-generate'),
  btnOpenPreview: document.getElementById('btn-open-preview'),
  btnSavePdf: document.getElementById('btn-save-pdf'),
  draftStrip: document.getElementById('draft-strip'),
  draftPageBadge: document.getElementById('draft-page-badge'),
  revisionBar: document.getElementById('revision-bar'),
  btnRestoreRevision: document.getElementById('btn-restore-revision'),

  chatMessages: document.getElementById('chat-messages'),
  chatForm: document.getElementById('chat-form'),
  chatInput: document.getElementById('chat-input'),
  btnSend: document.getElementById('btn-send'),
  btnStop: document.getElementById('btn-stop'),
  btnPickFolderInline: document.getElementById('btn-pick-folder-inline'),
  btnModelInline: document.getElementById('btn-model-inline'),
  btnClearChat: document.getElementById('btn-clear-chat'),

  historyDialog: document.getElementById('history-dialog'),
  historyList: document.getElementById('history-list'),

  settingsDialog: document.getElementById('settings-dialog'),
  settingsForm: document.getElementById('settings-form'),
  masterRadioContainer: document.getElementById('master-radio-container'),
  agentSelect: document.getElementById('agent-select'),
  modelSelect: document.getElementById('model-select'),
  apiSettingsGroup: document.getElementById('api-settings-group'),
  apiProviderSelect: document.getElementById('api-provider-select'),
  apiKeyInput: document.getElementById('api-key-input'),
  apiKeyHint: document.getElementById('api-key-hint'),
  apiBaseUrlLabel: document.getElementById('api-base-url-label'),
  apiBaseUrlInput: document.getElementById('api-base-url-input'),
  customModelInput: document.getElementById('custom-model-input'),
  settingEffort: document.getElementById('setting-effort'),
  selectedFolderName: document.getElementById('selected-folder-name'),
  btnPickFolder: document.getElementById('btn-pick-folder'),
  btnClearFolder: document.getElementById('btn-clear-folder'),
  autoSaveAs: document.getElementById('auto-save-as'),
  settingFastMode: document.getElementById('setting-fast-mode'),
  settingServerUrl: document.getElementById('setting-server-url'),
  settingRepoPath: document.getElementById('setting-repo-path'),

  toast: document.getElementById('app-toast'),
  toastMessage: document.getElementById('toast-message'),
  toastDismiss: document.getElementById('toast-dismiss'),
  srAnnouncer: document.getElementById('sr-announcer'),
};

const TITLE_NOISE_RE =
  /\s*[\(\[]\s*(?:remote(?:\s+work)?|hybrid|on[-\s]?site|canada|usa?|uk|toronto|vancouver|montreal|ontario|north\s+america|req(?:uisition)?\s*#?\s*\w+|job\s*id\s*[:#]?\s*\w+|\d{4})[^)\]]*[\)\]]/gi;

const TITLE_TRAILING_NOISE_RE =
  /(?:[-–—|,\s]+(?:remote(?:\s+work)?|hybrid|on[-\s]?site|canada|toronto|ontario|usa?|united\s+states))+$/i;

function slugifyClient(raw, fallback, maxLen, { stripCorp = false, stripTitleNoise = false } = {}) {
  let value = String(raw || '').trim();
  if (!value) return fallback;
  if (stripTitleNoise) {
    value = value.replace(TITLE_NOISE_RE, '').replace(TITLE_TRAILING_NOISE_RE, '').trim();
  }
  value = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .replace(/\+/g, ' plus ')
    .replace(/#/g, ' sharp ');
  if (stripCorp) {
    value = value.replace(
      /\b(inc\.?|incorporated|corp\.?|corporation|ltd\.?|limited|llc|plc|co\.?|company|technologies|labs?)\s*$/i,
      '',
    );
  }
  let slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
  if (!slug) return fallback;
  if (slug.length > maxLen) {
    const truncated = slug.slice(0, maxLen);
    const lastDash = truncated.lastIndexOf('-');
    slug = lastDash >= Math.floor(maxLen * 0.5) ? truncated.slice(0, lastDash) : truncated;
    slug = slug.replace(/-+$/g, '');
  }
  return slug || fallback;
}

function normalizeServerUrl(url) {
  return String(url || DEFAULT_SETTINGS.serverUrl).trim().replace(/\/+$/, '');
}

function isMacClient() {
  const plat = navigator.userAgentData?.platform || navigator.platform || navigator.userAgent || '';
  return /mac/i.test(plat);
}

function isTrackableWebUrl(url) {
  return /^https?:\/\//i.test(String(url || ''));
}

function normalizeJobUrl(rawUrl) {
  const input = String(rawUrl || '').trim();
  if (!input) return '';
  if (!/^https?:\/\//i.test(input)) return input;
  try {
    const u = new URL(input);
    for (const key of [...u.searchParams.keys()]) {
      if (TRACKING_QUERY_PARAMS.has(key.toLowerCase()) || key.toLowerCase().startsWith('utm_')) {
        u.searchParams.delete(key);
      }
    }
    // Preserve SPA hash routes (#/... or #!/...), strip bare scroll anchors
    if (!u.hash.startsWith('#/') && !u.hash.startsWith('#!/')) {
      u.hash = '';
    }
    return u.toString();
  } catch {
    return input.split('#')[0];
  }
}

function updateJobDisplay() {
  const company = els.companyInput.value.trim();
  const title = els.jobTitleInput.value.trim();
  const jdLen = els.jdTextarea.value.trim().length;

  if (company && title) {
    els.jobHeadline.textContent = `${company} · ${title}`;
  } else if (title) {
    els.jobHeadline.textContent = title;
  } else if (company) {
    els.jobHeadline.textContent = company;
  } else if (jdLen > 0) {
    els.jobHeadline.textContent = 'Job loaded (auto-detect company & title)';
  } else {
    els.jobHeadline.textContent = 'Open a job tab or click Edit to paste JD';
  }

  if (state.lastResult?.pdfFilename && !state.companyManual && !state.jobTitleManual) {
    els.filenamePreview.textContent = state.lastResult.pdfFilename;
  } else {
    const companySlug = company ? slugifyClient(company, '<auto>', 36, { stripCorp: true }) : '<auto>';
    const titleSlug = title ? slugifyClient(title, '<auto>', 48, { stripTitleNoise: true }) : '<auto>';
    els.filenamePreview.textContent = `resume-${companySlug}-${titleSlug}.pdf`;
  }
  els.jdCountBadge.textContent = `${jdLen.toLocaleString()} chars`;
}

function announceScreenReader(text) {
  if (typeof document.ariaNotify === 'function') {
    try {
      document.ariaNotify(text);
      return;
    } catch {
      // fallback
    }
  }
  els.srAnnouncer.textContent = '';
  requestAnimationFrame(() => {
    els.srAnnouncer.textContent = text;
  });
}

function showToast(message, variant = 'info', { autoHideMs = 5000 } = {}) {
  if (els.settingsDialog.open || els.historyDialog.open) return;
  if (state.toastTimer) {
    clearTimeout(state.toastTimer);
    state.toastTimer = null;
  }

  state.toastReturnFocusEl = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  els.toast.dataset.variant = variant;
  els.toastMessage.textContent = message;

  try {
    if (typeof els.toast.showPopover === 'function') {
      els.toast.showPopover();
    } else {
      els.toast.classList.add(':popover-open');
    }
  } catch {
    els.toast.classList.add(':popover-open');
  }

  announceScreenReader(message);

  if (autoHideMs > 0) {
    const scheduleHide = () => {
      state.toastTimer = setTimeout(() => {
        if (els.toast.contains(document.activeElement)) {
          scheduleHide();
          return;
        }
        hideToast(false);
      }, autoHideMs);
    };
    scheduleHide();
  }
}

function hideToast(restoreFocus = false) {
  if (state.toastTimer) {
    clearTimeout(state.toastTimer);
    state.toastTimer = null;
  }
  try {
    if (typeof els.toast.hidePopover === 'function' && els.toast.matches(':popover-open')) {
      els.toast.hidePopover();
    }
  } catch {
    // ignore
  }
  els.toast.classList.remove(':popover-open');

  if (restoreFocus && state.toastReturnFocusEl && document.contains(state.toastReturnFocusEl)) {
    state.toastReturnFocusEl.focus();
  }
}

async function openOrFocusPreviewWindowDirect({ focus = true } = {}) {
  const previewUrl = chrome.runtime.getURL('preview/preview.html');

  try {
    const allWindows = await chrome.windows.getAll({ populate: true });
    for (const win of allWindows) {
      const matchTab = win.tabs?.find((t) => t.url && t.url.startsWith(previewUrl));
      if (matchTab && typeof win.id === 'number') {
        const updateOpts = {};
        if (win.state === 'minimized') updateOpts.state = 'normal';
        if (focus) {
          updateOpts.focused = true;
          updateOpts.drawAttention = true;
        }
        if (Object.keys(updateOpts).length > 0) {
          await chrome.windows.update(win.id, updateOpts);
        }
        if (typeof matchTab.id === 'number' && focus) {
          await chrome.tabs.update(matchTab.id, { active: true });
        }
        return { ok: true, windowId: win.id, reused: true };
      }
    }
  } catch (err) {
    console.warn('Could not scan existing windows:', err);
  }

  const availLeft = globalThis.screen?.availLeft ?? 0;
  const availTop = globalThis.screen?.availTop ?? 0;
  const availW = globalThis.screen?.availWidth || 1280;
  const availH = globalThis.screen?.availHeight || 860;
  const width = Math.max(520, Math.min(820, availW - 60));
  const height = Math.max(560, Math.min(920, availH - 80));

  let left;
  let top;
  try {
    const hostWin = await chrome.windows.getLastFocused();
    if (hostWin && typeof hostWin.left === 'number' && typeof hostWin.top === 'number') {
      const hostW = hostWin.width || availW;
      const desiredLeft = Math.round(hostWin.left + Math.max(20, (hostW - width - 420) / 2));
      const minLeft = availLeft + 16;
      const maxLeft = Math.max(minLeft, availLeft + availW - width - 16);
      left = Math.min(maxLeft, Math.max(minLeft, desiredLeft));
      top = Math.max(availTop + 20, Math.round(hostWin.top + 28));
    }
  } catch {
    // let Chrome decide
  }

  const createOpts = {
    url: previewUrl,
    type: 'popup',
    width,
    height,
    focused: Boolean(focus),
  };
  if (typeof left === 'number' && typeof top === 'number') {
    createOpts.left = left;
    createOpts.top = top;
  }

  try {
    const created = await chrome.windows.create(createOpts);
    return { ok: true, windowId: created?.id ?? null, reused: false };
  } catch {
    const created = await chrome.windows.create({
      url: previewUrl,
      type: 'popup',
      width,
      height,
      focused: Boolean(focus),
    });
    return { ok: true, windowId: created?.id ?? null, reused: false };
  }
}

async function persistActiveSession() {
  try {
    await chrome.storage.session.set({
      activeSidebarSession: {
        sessionKey: state.sessionKey,
        sessionUrl: state.sessionUrl,
        sourceUrl: state.sourceUrl,
        pageTitle: state.pageTitle,
        company: els.companyInput.value,
        jobTitle: els.jobTitleInput.value,
        jobDescription: els.jdTextarea.value,
        lastResult: state.lastResult,
        viewingVersion: state.viewingVersion,
        messages: state.messages.slice(-40),
      },
    });
  } catch {
    // ignore
  }
}

async function clearPreviewSession() {
  try {
    await chrome.storage.session.set({
      previewSession: {
        serverUrl: normalizeServerUrl(state.settings.serverUrl),
        result: null,
        viewingVersion: 1,
        status: 'idle',
        progress: 0,
        statusMessage: '',
        revisionNonce: Date.now(),
      },
    });
    await chrome.storage.local.remove('lastPreviewSession');
  } catch {
    // ignore
  }
}

async function resetSession() {
  state.sessionToken += 1;
  state.sessionKey = crypto.randomUUID();

  if (state.activeAbortController) {
    state.activeAbortController.abort();
    state.activeAbortController = null;
    setBusy(false);
  }

  state.sessionUrl = '';
  state.sourceUrl = '';
  state.pageTitle = '';
  state.companyManual = false;
  state.jobTitleManual = false;
  state.lastResult = null;
  state.viewingVersion = null;
  state.messages = [];

  els.companyInput.value = '';
  els.jobTitleInput.value = '';
  els.jdTextarea.value = '';
  els.jobEditor.hidden = true;
  els.btnToggleJobEdit.setAttribute('aria-expanded', 'false');

  updateJobDisplay();
  renderActiveDraftStrip();
  renderChatThread();

  await Promise.all([
    clearPreviewSession(),
    chrome.storage.session.remove('activeSidebarSession').catch(() => {}),
  ]);
}

async function publishPreviewSession({
  result = state.lastResult,
  viewingVersion = state.viewingVersion,
  status = 'ready',
  progress = 100,
  statusMessage = '',
  bumpNonce = false,
  openWindow = false,
  focusWindow = false,
} = {}) {
  const existing = (await chrome.storage.session.get('previewSession')).previewSession || {};
  const nextSession = {
    serverUrl: normalizeServerUrl(state.settings.serverUrl),
    result: result || existing.result || null,
    viewingVersion: viewingVersion || result?.activeVersion || existing.viewingVersion || 1,
    status,
    progress,
    statusMessage,
    revisionNonce: bumpNonce ? Date.now() : existing.revisionNonce || Date.now(),
  };

  await chrome.storage.session.set({ previewSession: nextSession });
  await chrome.storage.local.set({ lastPreviewSession: nextSession });

  if (openWindow) {
    return openOrFocusPreviewWindowDirect({ focus: focusWindow });
  }
  return { ok: true };
}

function getCurrentPreviewUrl(result, version = null) {
  if (!result) return '';
  const baseUrl = normalizeServerUrl(state.settings.serverUrl);
  const revisions = Array.isArray(result.revisions) ? result.revisions : [];
  if (version && revisions.some((r) => r.version === version)) {
    return `${baseUrl}/api/tailored/${encodeURIComponent(result.folderSlug)}/revisions/${version}/pdf`;
  }
  if (result.downloadUrl) {
    return `${baseUrl}${result.downloadUrl}`;
  }
  return `${baseUrl}/api/tailored/${encodeURIComponent(result.folderSlug)}/pdf`;
}

function getActiveAgentDisplayName() {
  const id = state.settings.agentId || 'antigravity';
  if (id === 'claude') return 'Claude Code';
  if (id === 'codex') return 'Codex';
  if (id === 'api') {
    const p = state.settings.apiProvider || 'openai';
    if (p === 'openrouter') return 'OpenRouter';
    if (p === 'local') return 'Local API';
    if (p === 'anthropic') return 'Anthropic API';
    if (p === 'gemini') return 'Gemini API';
    return 'OpenAI API';
  }
  return 'Antigravity';
}

function getEffectiveModel() {
  if (state.settings.agentId === 'api' && state.settings.customModel?.trim()) {
    return state.settings.customModel.trim();
  }
  return state.settings.model || '';
}

const EFFORT_LABELS = {
  low: 'Low (fastest)',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra High',
};

function renderComposerPills() {
  if (state.folder) {
    els.btnPickFolderInline.textContent = `Folder: ${state.folder.name}`;
  } else {
    els.btnPickFolderInline.textContent = 'Folder: Save As';
  }
  const agentName = getActiveAgentDisplayName();
  const effectiveModel = getEffectiveModel();
  const agyModels = state.health?.agents?.find((a) => a.id === 'antigravity')?.models || [];
  const matchedAgy = state.settings.agentId === 'antigravity' ? agyModels.find((m) => m.id === effectiveModel) : null;
  let modelLabel =
    effectiveModel === 'cli-default'
      ? 'CLI default'
      : matchedAgy?.label || effectiveModel || (state.settings.agentId === 'antigravity' ? 'Auto Fast' : 'default');
  if (state.settings.agentId === 'antigravity' && state.settings.effort && effectiveModel !== 'cli-default') {
    const supportsEffort = !matchedAgy || !Array.isArray(matchedAgy.efforts) || matchedAgy.efforts.length > 0;
    if (supportsEffort) {
      modelLabel = `${modelLabel} (${state.settings.effort})`;
    }
  }
  els.btnModelInline.textContent = `${agentName} · ${modelLabel}`;
  els.btnClearChat.hidden = state.messages.length === 0;
}

function renderFolderState() {
  if (!isFolderPickerSupported()) {
    els.selectedFolderName.textContent = 'Unavailable (uses Save As window)';
    els.btnPickFolder.disabled = true;
    els.btnClearFolder.hidden = true;
  } else if (!state.folder) {
    els.selectedFolderName.textContent = 'Not selected (uses Save As window)';
    els.btnPickFolder.textContent = 'Choose';
    els.btnClearFolder.hidden = true;
  } else {
    const suffix = state.folder.permission === 'granted' ? ' (ready)' : ' (re-confirm on save)';
    els.selectedFolderName.textContent = `${state.folder.name}${suffix}`;
    els.btnPickFolder.textContent = 'Change';
    els.btnClearFolder.hidden = false;
  }
  renderComposerPills();
}

async function loadSettings() {
  const stored = await chrome.storage.local.get(['settings', 'cachedHealthAgents']);
  state.settings = { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
  if (!state.health && Array.isArray(stored.cachedHealthAgents) && stored.cachedHealthAgents.length > 0) {
    state.health = { agents: stored.cachedHealthAgents };
    renderAgentsAndModels(stored.cachedHealthAgents);
  }
  els.autoSaveAs.checked = Boolean(state.settings.autoSaveAs);
  els.settingServerUrl.value = state.settings.serverUrl;
  els.settingEffort.value = state.settings.effort || '';
  els.settingFastMode.checked = Boolean(state.settings.fastMode);
  els.apiProviderSelect.value = state.settings.apiProvider || 'openai';
  els.apiKeyInput.value = state.settings.apiKey || '';
  els.apiBaseUrlInput.value = state.settings.apiBaseUrl || '';
  els.customModelInput.value = state.settings.customModel || '';

  const masterRadio = els.settingsForm.querySelector(
    `input[name="masterResume"][value="${CSS.escape(state.settings.masterResume || 'auto')}"]`,
  );
  if (masterRadio) masterRadio.checked = true;
  renderComposerPills();
}

async function saveSettings(partial) {
  state.settings = { ...state.settings, ...partial };
  await chrome.storage.local.set({ settings: state.settings });
  renderComposerPills();
}

function setConnectionStatus(connState, shortLabel, alertText = '') {
  els.btnStatusDot.dataset.state = connState;
  els.statusShort.textContent = shortLabel;
  if (alertText) {
    els.alertStrip.hidden = false;
    els.alertStripText.textContent = alertText;
  } else {
    els.alertStrip.hidden = true;
    els.alertStripText.textContent = '';
  }
}

function renderMasters(masters = []) {
  const currentSelected = state.settings.masterResume || 'auto';
  els.masterRadioContainer.replaceChildren();

  const options = [
    { value: 'auto', label: 'Auto-detect from job description' },
    ...masters.map((m) => ({ value: m.filename, label: m.label })),
  ];

  for (const opt of options) {
    const row = document.createElement('div');
    row.className = 'radio-row';

    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'masterResume';
    input.value = opt.value;
    input.id = `master-opt-${opt.value.replace(/[^a-z0-9]/gi, '-')}`;
    input.checked = opt.value === currentSelected;

    const label = document.createElement('label');
    label.htmlFor = input.id;
    label.textContent = opt.label;

    row.append(input, label);
    els.masterRadioContainer.append(row);
  }
}

function updateEffortOptionsForSelection(preferredEffort = els.settingEffort.value || state.settings.effort || 'low') {
  const agentId = els.agentSelect.value || 'antigravity';
  const modelId = els.modelSelect.value || '';
  const agents = state.health?.agents || [];
  const selectedAgent = agents.find((a) => a.id === agentId);

  els.settingEffort.replaceChildren();
  els.settingEffort.disabled = false;

  if (agentId === 'antigravity' && modelId !== 'cli-default') {
    const modelMeta =
      modelId === ''
        ? selectedAgent?.models?.find((m) => m.id === 'gemini-3.8-flash') ||
          selectedAgent?.models?.find((m) => Array.isArray(m.efforts) && m.efforts.length > 0)
        : selectedAgent?.models?.find((m) => m.id === modelId);

    const efforts = Array.isArray(modelMeta?.efforts) ? modelMeta.efforts : ['low', 'medium', 'high', 'xhigh'];

    if (efforts.length === 0) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'Default (fixed for this model)';
      els.settingEffort.append(opt);
      els.settingEffort.value = '';
      els.settingEffort.disabled = true;
      return;
    }

    for (const tier of efforts) {
      const opt = document.createElement('option');
      opt.value = tier;
      opt.textContent =
        efforts.length === 1 ? `${EFFORT_LABELS[tier] || tier} (only tier)` : EFFORT_LABELS[tier] || tier;
      els.settingEffort.append(opt);
    }

    if (preferredEffort && efforts.includes(preferredEffort)) {
      els.settingEffort.value = preferredEffort;
    } else {
      els.settingEffort.value = efforts[0];
    }
    return;
  }

  for (const [val, label] of [
    ['low', 'Low (fastest)'],
    ['medium', 'Medium'],
    ['high', 'High'],
    ['xhigh', 'Extra High'],
    ['', 'Auto (default)'],
  ]) {
    const opt = document.createElement('option');
    opt.value = val;
    opt.textContent = label;
    els.settingEffort.append(opt);
  }
  els.settingEffort.value = [...els.settingEffort.options].some((o) => o.value === preferredEffort)
    ? preferredEffort
    : 'low';
}

function renderModelOptionsForAgent(agentId, preferredModel = '', preferredEffort = state.settings.effort) {
  const agents = state.health?.agents || [];
  const selectedAgent = agents.find((a) => a.id === agentId) || agents[0];
  const isApi = agentId === 'api';
  els.apiSettingsGroup.hidden = !isApi;

  els.modelSelect.replaceChildren();

  let normalizedModel = preferredModel;
  let normalizedEffort = preferredEffort;

  if (agentId === 'antigravity') {
    const defaultOpt = document.createElement('option');
    defaultOpt.value = '';
    defaultOpt.textContent = 'Auto Fast — Gemini 3.8 Flash';
    els.modelSelect.append(defaultOpt);

    const cliDefaultOpt = document.createElement('option');
    cliDefaultOpt.value = 'cli-default';
    cliDefaultOpt.textContent = 'Antigravity CLI default';
    els.modelSelect.append(cliDefaultOpt);

    for (const model of selectedAgent?.models || []) {
      const opt = document.createElement('option');
      opt.value = model.id;
      opt.textContent = model.label;
      els.modelSelect.append(opt);
    }

    // Seamlessly migrate legacy effort-suffixed model IDs (e.g. gemini-4-hydrogen-high -> gemini-4-hydrogen + high)
    if (normalizedModel && ![...els.modelSelect.options].some((o) => o.value === normalizedModel)) {
      const m = String(normalizedModel).match(/^(.+)-(low|medium|high|xhigh)$/i);
      if (m && [...els.modelSelect.options].some((o) => o.value === m[1])) {
        normalizedModel = m[1];
        if (!normalizedEffort) normalizedEffort = m[2].toLowerCase();
      }
    }
  } else if (isApi) {
    const provider = els.apiProviderSelect.value || state.settings.apiProvider || 'openai';
    const providerMeta = selectedAgent?.providers?.[provider];
    const providerModels = providerMeta?.models || selectedAgent?.models || [];
    const envHasKey = Boolean(selectedAgent?.envKeys?.[provider]);
    const isLocalProvider = provider === 'local';
    const envVarName = providerMeta?.envVar || `${provider.toUpperCase()}_API_KEY`;

    if (isLocalProvider) {
      els.apiKeyInput.placeholder = 'Optional (leave blank for Ollama / LM Studio / vLLM)';
      els.apiKeyHint.textContent =
        'API key is optional for local OpenAI-compatible servers. Set your local Base URL & model.';
      els.apiBaseUrlLabel.textContent = 'Local server Base URL';
      els.apiBaseUrlInput.placeholder = providerMeta?.baseUrl || 'http://127.0.0.1:11434/v1';
      els.customModelInput.placeholder = 'e.g. qwen2.5:14b or local model ID';
    } else {
      els.apiKeyInput.placeholder = envHasKey
        ? `Using server ${envVarName} (paste to override)`
        : provider === 'openrouter'
          ? 'sk-or-v1-… (or set OPENROUTER_API_KEY on server)'
          : `Paste API key (or set ${envVarName} on server)`;
      els.apiKeyHint.textContent = envHasKey
        ? `Server ${envVarName} detected for ${providerMeta?.label || provider}. Leave blank to use it.`
        : 'Stored locally in Chrome; sent only to your local server and chosen API provider.';
      els.apiBaseUrlLabel.textContent = 'Base URL (optional)';
      els.apiBaseUrlInput.placeholder = providerMeta?.baseUrl || 'https://api.openai.com/v1';
      els.customModelInput.placeholder =
        provider === 'openrouter'
          ? 'e.g. anthropic/claude-sonnet-4.5'
          : `e.g. ${providerMeta?.defaultModel || 'gpt-4o-mini'}`;
    }

    const defOpt = document.createElement('option');
    defOpt.value = '';
    defOpt.textContent = `Provider default (${providerMeta?.defaultModel || 'auto'})`;
    els.modelSelect.append(defOpt);

    for (const model of providerModels) {
      const opt = document.createElement('option');
      opt.value = model.id;
      opt.textContent = model.label;
      els.modelSelect.append(opt);
    }
  } else {
    const defOpt = document.createElement('option');
    defOpt.value = '';
    defOpt.textContent = agentId === 'claude' ? 'Recommended (sonnet)' : 'CLI default';
    els.modelSelect.append(defOpt);

    for (const model of selectedAgent?.models || []) {
      const opt = document.createElement('option');
      opt.value = model.id;
      opt.textContent = model.label;
      els.modelSelect.append(opt);
    }
  }

  if (normalizedModel && [...els.modelSelect.options].some((o) => o.value === normalizedModel)) {
    els.modelSelect.value = normalizedModel;
  } else {
    els.modelSelect.value = '';
  }
  updateEffortOptionsForSelection(normalizedEffort);
}

function renderAgentsAndModels(agents = []) {
  const preserveUiSelection = els.settingsDialog.open;
  const activeAgentVal = preserveUiSelection ? els.agentSelect.value : state.settings.agentId;
  const activeModelVal = preserveUiSelection ? els.modelSelect.value : state.settings.model;
  const activeEffortVal = preserveUiSelection ? els.settingEffort.value : state.settings.effort;

  els.agentSelect.replaceChildren();
  for (const agent of agents) {
    const opt = document.createElement('option');
    opt.value = agent.id;
    const tag = agent.installed === false ? ' (not installed)' : '';
    opt.textContent = `${agent.label}${tag}`;
    els.agentSelect.append(opt);
  }
  if (agents.some((a) => a.id === activeAgentVal)) {
    els.agentSelect.value = activeAgentVal;
  }
  renderModelOptionsForAgent(els.agentSelect.value || 'antigravity', activeModelVal, activeEffortVal);
}

function triggerServerWarmup() {
  if ((state.settings.agentId || 'antigravity') !== 'antigravity') return;
  const baseUrl = normalizeServerUrl(state.settings.serverUrl);
  fetch(`${baseUrl}/api/warmup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      agentId: 'antigravity',
      model: state.settings.model || '',
      effort: state.settings.effort || '',
    }),
  }).catch(() => {});
}

async function applyHealthResponse(health) {
  if (!health) {
    state.health = null;
    const envName = isMacClient() ? 'macOS Terminal' : 'WSL';
    setConnectionStatus(
      'offline',
      'Offline',
      `Companion server offline. Run ./scripts/install-autostart.sh or ./scripts/start-server.sh in ${envName}.`,
    );
    return false;
  }

  state.health = health;
  els.settingRepoPath.textContent = health.resumeRepoDir || '~/code/resume';
  if (Array.isArray(health.masters) && health.masters.length > 0) {
    renderMasters(health.masters);
  }
  if (Array.isArray(health.agents) && health.agents.length > 0) {
    renderAgentsAndModels(health.agents);
    const agyAgent = health.agents.find((a) => a.id === 'antigravity');
    if (agyAgent?.models?.length > 0) {
      await chrome.storage.local.set({ cachedHealthAgents: health.agents }).catch(() => {});
    }
  }

  const activeAgent = health.agents?.find((a) => a.id === state.settings.agentId) || health.agents?.[0];
  const shellHint = isMacClient() || health.platform === 'darwin' ? 'Terminal' : 'WSL';
  const apiProvider = state.settings.apiProvider || 'openai';
  const apiProviderMeta = activeAgent?.providers?.[apiProvider];
  const apiHasLocalEndpoint =
    apiProvider === 'local' ||
    /^https?:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\]|host\.docker\.internal|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|[^/]+\.local)(:\d+)?(\/|$)/i.test(
      state.settings.apiBaseUrl || '',
    );
  const apiReady =
    activeAgent?.id === 'api' &&
    (Boolean(state.settings.apiKey?.trim()) ||
      Boolean(activeAgent?.envKeys?.[apiProvider]) ||
      apiHasLocalEndpoint);

  if (!health.latex?.installed) {
    const installHint =
      isMacClient() || health.platform === 'darwin'
        ? 'LaTeX (MacTeX/BasicTeX) not found on macOS.'
        : 'TeX Live compiler not found in WSL.';
    setConnectionStatus('offline', 'No TeX', installHint);
    return false;
  }
  if (activeAgent?.id === 'api') {
    if (apiReady) {
      setConnectionStatus('ready', 'Ready');
      return true;
    }
    const providerName = apiProviderMeta?.label || apiProvider.toUpperCase();
    const envVar = apiProviderMeta?.envVar || `${apiProvider.toUpperCase()}_API_KEY`;
    setConnectionStatus(
      'auth-needed',
      'API key',
      `Open Settings to paste an API key for ${providerName} (or set ${envVar} on the server).`,
    );
    return false;
  }
  if (!activeAgent?.installed) {
    setConnectionStatus(
      'offline',
      `No ${activeAgent?.id || 'CLI'}`,
      activeAgent?.message || `${activeAgent?.label || 'AI CLI'} not found in ${shellHint}.`,
    );
    return false;
  }
  if (!activeAgent?.authenticated) {
    const loginCmd =
      activeAgent.id === 'claude' ? 'claude login' : activeAgent.id === 'codex' ? 'codex login' : 'agy';
    setConnectionStatus(
      'auth-needed',
      'Sign in',
      `Run \`${loginCmd}\` once in ${shellHint} to sign in, then click Reconnect.`,
    );
    return false;
  }
  setConnectionStatus('ready', 'Ready');
  return true;
}

async function checkServerHealth({ allowAutoWake = true, forceRefresh = false } = {}) {
  const baseUrl = normalizeServerUrl(state.settings.serverUrl);
  setConnectionStatus('checking', 'Checking…');

  const fetchHealth = async () => {
    const qs = forceRefresh ? '?refresh=1' : '';
    const res = await fetch(`${baseUrl}/api/health${qs}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  };

  let health = null;
  try {
    health = await fetchHealth();
  } catch {
    if (allowAutoWake && /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(baseUrl)) {
      setConnectionStatus('checking', 'Waking…');
      try {
        const wakeRes = await chrome.runtime.sendMessage({ type: 'ENSURE_SERVER' });
        if (wakeRes?.ok) {
          health = await fetchHealth();
        }
      } catch {
        // fall through
      }
    }
  }

  return applyHealthResponse(health);
}

async function reconnectLocalClients({ silent = false } = {}) {
  const baseUrl = normalizeServerUrl(state.settings.serverUrl);
  els.btnReconnect.disabled = true;
  els.btnReconnect.classList.add('is-spinning');
  setConnectionStatus('checking', 'Reconnecting…');

  const callReconnect = async () => {
    const res = await fetch(`${baseUrl}/api/reconnect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentId: state.settings.agentId || 'antigravity',
        model: getEffectiveModel(),
        effort: state.settings.effort || '',
      }),
      cache: 'no-store',
    });
    if (res.status === 404) {
      const fallback = await fetch(`${baseUrl}/api/health?refresh=1`, { cache: 'no-store' });
      if (!fallback.ok) throw new Error(`HTTP ${fallback.status}`);
      return fallback.json();
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  };

  let health = null;
  try {
    try {
      health = await callReconnect();
    } catch {
      if (/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(baseUrl)) {
        setConnectionStatus('checking', 'Waking…');
        try {
          const wakeRes = await chrome.runtime.sendMessage({ type: 'ENSURE_SERVER' });
          if (wakeRes?.ok) {
            health = await callReconnect();
          }
        } catch {
          // fall through
        }
      }
    }

    const isReady = await applyHealthResponse(health);
    if (!silent) {
      if (isReady) {
        showToast(`Reconnected (${getActiveAgentDisplayName()} ready).`, 'success');
      } else if (!health) {
        showToast('Could not reach local companion server.', 'error');
      } else {
        showToast(els.alertStripText.textContent || 'Server reachable, but backend needs setup.', 'info');
      }
    }
    return isReady;
  } finally {
    els.btnReconnect.disabled = false;
    els.btnReconnect.classList.remove('is-spinning');
  }
}

function renderActiveDraftStrip() {
  const result = state.lastResult;
  if (!result) {
    els.btnOpenPreview.hidden = true;
    els.btnSavePdf.hidden = true;
    els.draftStrip.hidden = true;
    els.btnGenerate.textContent = 'Generate Resume';
    return;
  }

  els.btnOpenPreview.hidden = false;
  els.btnSavePdf.hidden = false;
  els.btnGenerate.textContent = 'Regenerate Fresh';
  els.draftStrip.hidden = false;

  const warn = result.overfullHboxCount > 0 ? ` · ${result.overfullHboxCount} overfull` : '';
  els.draftPageBadge.textContent = `${result.pageCount ?? 1}p${warn}`;
  els.draftPageBadge.classList.toggle('is-warn', result.pageCount !== 1);

  const revisions = Array.isArray(result.revisions) ? result.revisions : [];
  const activeVersion = result.activeVersion || (revisions.length ? revisions.at(-1).version : 1);
  if (!state.viewingVersion || !revisions.some((r) => r.version === state.viewingVersion)) {
    state.viewingVersion = activeVersion;
  }

  els.revisionBar.replaceChildren();
  for (const rev of revisions) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'rev-pill';
    btn.textContent = `v${rev.version}`;
    btn.setAttribute('aria-pressed', String(rev.version === state.viewingVersion));
    btn.addEventListener('click', async () => {
      state.viewingVersion = rev.version;
      renderActiveDraftStrip();
      await publishPreviewSession({
        result: state.lastResult,
        viewingVersion: rev.version,
        status: 'ready',
      });
    });
    els.revisionBar.append(btn);
  }

  const isOlder = revisions.length > 0 && state.viewingVersion !== activeVersion;
  els.btnRestoreRevision.hidden = !isOlder;
  if (isOlder) {
    els.btnRestoreRevision.textContent = `Use v${state.viewingVersion}`;
  }
}

/**
 * Safely render simple plain-text / bullet / bold / inline-code prose without innerHTML.
 */
function renderFormattedText(container, rawText) {
  const lines = String(rawText || '').split('\n');
  let listEl = null;
  let listTag = null;

  const appendInline = (parent, line) => {
    const tokenRe = /(\*\*[^*]+\*\*|`[^`]+`)/g;
    let last = 0;
    let match;
    while ((match = tokenRe.exec(line)) !== null) {
      if (match.index > last) {
        parent.append(document.createTextNode(line.slice(last, match.index)));
      }
      const token = match[0];
      if (token.startsWith('**')) {
        const strong = document.createElement('strong');
        strong.textContent = token.slice(2, -2);
        parent.append(strong);
      } else {
        const code = document.createElement('code');
        code.textContent = token.slice(1, -1);
        parent.append(code);
      }
      last = match.index + token.length;
    }
    if (last < line.length) {
      parent.append(document.createTextNode(line.slice(last)));
    }
  };

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) {
      listEl = null;
      listTag = null;
      continue;
    }
    if (/^[-*_]{3,}$/.test(trimmed)) {
      listEl = null;
      listTag = null;
      container.append(document.createElement('hr'));
      continue;
    }
    const headingMatch = trimmed.match(/^#{1,4}\s+(.*)$/);
    if (headingMatch) {
      listEl = null;
      listTag = null;
      const h = document.createElement('h3');
      appendInline(h, headingMatch[1]);
      container.append(h);
      continue;
    }
    const ulMatch = trimmed.match(/^[-*•]\s+(.*)$/);
    if (ulMatch) {
      if (!listEl || listTag !== 'ul') {
        listEl = document.createElement('ul');
        listTag = 'ul';
        container.append(listEl);
      }
      const li = document.createElement('li');
      appendInline(li, ulMatch[1]);
      listEl.append(li);
      continue;
    }
    const olMatch = trimmed.match(/^\d+\.\s+(.*)$/);
    if (olMatch) {
      if (!listEl || listTag !== 'ol') {
        listEl = document.createElement('ol');
        listTag = 'ol';
        container.append(listEl);
      }
      const li = document.createElement('li');
      appendInline(li, olMatch[1]);
      listEl.append(li);
      continue;
    }
    listEl = null;
    listTag = null;
    const p = document.createElement('p');
    appendInline(p, trimmed);
    container.append(p);
  }
}

function scrollChatToBottom() {
  els.chatMessages.scrollTop = els.chatMessages.scrollHeight;
}

function renderEmptyWelcome() {
  const empty = document.createElement('div');
  empty.className = 'chat-empty';

  const heading = document.createElement('p');
  heading.className = 'chat-empty-title';
  heading.textContent = 'Ready to tailor';

  const body = document.createElement('p');
  body.className = 'chat-empty-body';
  body.textContent =
    'Click Generate Resume above to compile a 1-page PDF for this role, or write below to ask about fit, draft a note, or edit specific bullets.';

  empty.append(heading, body);
  els.chatMessages.replaceChildren(empty);
}

function createMessageElement(msg) {
  const wrap = document.createElement('article');
  wrap.className = msg.role === 'user' ? 'msg msg-user' : 'msg msg-assistant';

  if (msg.role === 'user') {
    wrap.textContent = msg.text;
    return wrap;
  }

  if (msg.intent) {
    const header = document.createElement('div');
    header.className = 'msg-header';
    const label = document.createElement('span');
    label.textContent = msg.result?.agentLabel || getActiveAgentDisplayName();

    const badge = document.createElement('span');
    badge.className = 'msg-intent';
    badge.dataset.intent = msg.intent;
    if (msg.intent === 'qa') badge.textContent = 'Q&A';
    else if (msg.intent === 'edit') badge.textContent = `Updated v${msg.result?.activeVersion || 1}`;
    else if (msg.intent === 'generate') badge.textContent = `Generated v${msg.result?.activeVersion || 1}`;
    else if (msg.intent === 'error') badge.textContent = 'Error';

    header.append(label, badge);
    wrap.append(header);
  }

  const body = document.createElement('div');
  body.className = 'msg-body';
  renderFormattedText(body, msg.text);
  wrap.append(body);

  if (Array.isArray(msg.missingKeywords) && msg.missingKeywords.length > 0) {
    const gaps = document.createElement('p');
    gaps.className = 'msg-gaps';
    gaps.textContent = `Gaps (not on master): ${msg.missingKeywords.slice(0, 8).join(', ')}`;
    wrap.append(gaps);
  }

  if (msg.intent === 'error') {
    const actions = document.createElement('div');
    actions.className = 'msg-actions';

    const retryBtn = document.createElement('button');
    retryBtn.type = 'button';
    retryBtn.className = 'btn btn-secondary btn-xs';
    retryBtn.textContent = msg.retryAction ? 'Reconnect & Retry' : 'Reconnect';
    retryBtn.addEventListener('click', async () => {
      if (state.activeAbortController) return;
      const ok = await reconnectLocalClients({ silent: Boolean(msg.retryAction) });
      if (!ok || !msg.retryAction) return;
      if (msg.retryAction.type === 'generate') {
        await handleOneClickGenerate();
      } else if (msg.retryAction.type === 'chat' && msg.retryAction.text) {
        els.chatInput.value = msg.retryAction.text;
        await handleChatSubmit(new Event('submit'));
      }
    });

    actions.append(retryBtn);
    wrap.append(actions);
  }

  if (msg.result) {
    const actions = document.createElement('div');
    actions.className = 'msg-actions';

    const previewBtn = document.createElement('button');
    previewBtn.type = 'button';
    previewBtn.className = 'btn btn-secondary btn-xs';
    previewBtn.textContent = `Preview v${msg.result.activeVersion || 1}`;
    previewBtn.addEventListener('click', async () => {
      state.lastResult = msg.result;
      state.viewingVersion = msg.result.activeVersion || 1;
      renderActiveDraftStrip();
      await openPreviewFromGesture();
    });

    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'btn btn-ghost btn-xs';
    saveBtn.textContent = 'Save PDF';
    saveBtn.addEventListener('click', async () => {
      await saveCurrentPdf(msg.result, msg.result.activeVersion || 1);
    });

    actions.append(previewBtn, saveBtn);
    wrap.append(actions);
  }

  return wrap;
}

function renderChatThread() {
  if (state.messages.length === 0) {
    renderEmptyWelcome();
    renderComposerPills();
    return;
  }

  const frag = document.createDocumentFragment();
  for (const msg of state.messages) {
    frag.append(createMessageElement(msg));
  }
  els.chatMessages.replaceChildren(frag);
  renderComposerPills();
  scrollChatToBottom();
}

function appendStreamingPlaceholder(initialText) {
  if (state.messages.length === 0) {
    els.chatMessages.replaceChildren();
  }
  const el = document.createElement('article');
  el.className = 'msg msg-assistant';

  const box = document.createElement('div');
  box.className = 'msg-progress';

  const bar = document.createElement('progress');
  bar.max = 100;
  bar.value = 10;

  const text = document.createElement('p');
  text.className = 'msg-progress-text';
  text.textContent = initialText;

  box.append(bar, text);
  el.append(box);
  els.chatMessages.append(el);
  scrollChatToBottom();

  return {
    el,
    update(progress, msg) {
      if (typeof progress === 'number') bar.value = progress;
      if (msg) text.textContent = msg;
      scrollChatToBottom();
    },
    remove() {
      el.remove();
    },
  };
}

function setBusy(busy) {
  els.btnGenerate.disabled = busy;
  els.btnSend.hidden = busy;
  els.btnStop.hidden = !busy;
}

async function triggerSaveAsDialog(url, filename) {
  const resp = await chrome.runtime.sendMessage({
    type: 'SAVE_PDF_AS',
    url,
    filename,
  });
  if (!resp?.ok) {
    showToast(`Save As failed: ${resp?.error || 'Unknown error'}`, 'error');
    return false;
  }
  return true;
}

async function savePdfToSelectedFolder(downloadUrl, filename, { interactive = false } = {}) {
  if (!state.folder?.handle) return { saved: false, reason: 'no-folder' };

  if (interactive) {
    const perm = await requestFolderPermission(state.folder.handle);
    state.folder.permission = perm;
    renderFolderState();
    if (perm !== 'granted') return { saved: false, reason: 'denied' };
  } else if (state.folder.permission !== 'granted') {
    return { saved: false, reason: 'permission-needed' };
  }

  const res = await fetch(downloadUrl, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buffer = await res.arrayBuffer();
  await writePdfToFolder(state.folder.handle, filename, buffer);
  return { saved: true, folderName: state.folder.name };
}

async function saveCurrentPdf(result = state.lastResult, version = state.viewingVersion) {
  if (!result) return;
  const url = getCurrentPreviewUrl(result, version);

  if (state.folder?.handle) {
    try {
      const folderRes = await savePdfToSelectedFolder(url, result.pdfFilename, { interactive: true });
      if (folderRes.saved) {
        showToast(`Saved ${result.pdfFilename} to "${folderRes.folderName}".`, 'success');
      }
    } catch (err) {
      showToast(`Folder save failed: ${err.message}`, 'error');
    }
  }
  await triggerSaveAsDialog(url, result.pdfFilename);
}

async function openPreviewFromGesture() {
  if (!chrome.runtime?.id) {
    showToast('Extension reloaded — close and reopen the side panel.', 'error');
    return;
  }
  if (!state.lastResult) {
    showToast('Generate or load a resume from History first.', 'info');
    return;
  }
  try {
    const res = await publishPreviewSession({
      result: state.lastResult,
      viewingVersion: state.viewingVersion,
      status: 'ready',
      openWindow: true,
      focusWindow: true,
    });
    if (!res?.ok) {
      showToast(`Could not open preview window: ${res?.error || 'Unknown error'}`, 'error');
    }
  } catch (err) {
    const msg = String(err?.message || err);
    showToast(
      msg.includes('Extension context invalidated')
        ? 'Extension reloaded — close and reopen the side panel.'
        : `Could not open preview window: ${msg}`,
      'error',
    );
  }
}

async function ensureServerAwake(baseUrl, progressHandle) {
  if (state.health || !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(baseUrl)) return;
  progressHandle.update(8, 'Waking local companion server…');
  const wakeRes = await chrome.runtime.sendMessage({ type: 'ENSURE_SERVER' });
  if (wakeRes?.ok) {
    await checkServerHealth({ allowAutoWake: false });
  }
}

async function streamEndpoint({ endpoint, requestBody, initialStatus, notifyPopup = false, retryAction = null }) {
  const mySessionToken = state.sessionToken;
  const baseUrl = normalizeServerUrl(state.settings.serverUrl);
  const progressHandle = appendStreamingPlaceholder(initialStatus);
  const abortController = new AbortController();
  state.activeAbortController = abortController;
  setBusy(true);

  if (notifyPopup && state.lastResult) {
    await publishPreviewSession({
      status: 'regenerating',
      progress: 15,
      statusMessage: initialStatus,
    });
  }

  try {
    await ensureServerAwake(baseUrl, progressHandle);
    if (state.sessionToken !== mySessionToken) return;

    const response = await fetch(`${baseUrl}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
      signal: abortController.signal,
    });

    if (state.sessionToken !== mySessionToken) return;

    if (!response.ok || !response.body) {
      let detail = `HTTP ${response.status}`;
      try {
        const errJson = await response.json();
        if (errJson.error) detail = errJson.error;
      } catch {
        // ignore
      }
      throw new Error(detail);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let donePayload = null;
    let chatPayload = null;
    let streamError = null;

    const handleBlock = async (block) => {
      if (state.sessionToken !== mySessionToken) return;
      let eventName = 'message';
      const dataLines = [];
      for (const rawLine of block.split('\n')) {
        const line = rawLine.replace(/\r$/, '');
        if (!line || line.startsWith(':')) continue;
        if (line.startsWith('event:')) eventName = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
      }
      if (dataLines.length === 0) return;

      let data;
      try {
        data = JSON.parse(dataLines.join('\n'));
      } catch {
        return;
      }

      if (eventName === 'stage') {
        progressHandle.update(data.progress, data.message);
        if (notifyPopup && state.lastResult && data.step !== 'done') {
          await publishPreviewSession({
            status: 'regenerating',
            progress: typeof data.progress === 'number' ? data.progress : 45,
            statusMessage: data.message || 'Updating PDF…',
          });
        }
      } else if (eventName === 'agent' && data.kind === 'status' && data.text) {
        progressHandle.update(undefined, data.text);
      } else if (eventName === 'chat') {
        chatPayload = data;
      } else if (eventName === 'done') {
        donePayload = data;
      } else if (eventName === 'error') {
        streamError = data;
      }
    };

    while (true) {
      const { value, done } = await reader.read();
      if (state.sessionToken !== mySessionToken) return;
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split('\n\n');
      buffer = blocks.pop() ?? '';
      for (const block of blocks) {
        await handleBlock(block);
      }
    }
    if (buffer.trim()) await handleBlock(buffer);
    if (state.sessionToken !== mySessionToken) return;

    if (streamError) {
      const err = new Error(streamError.message || 'Request failed');
      err.code = streamError.code;
      throw err;
    }

    progressHandle.remove();

    // Case 1: Q&A reply (no PDF modified)
    if (chatPayload) {
      if (notifyPopup && state.lastResult) {
        await publishPreviewSession({ status: 'ready', progress: 100, statusMessage: '' });
      }
      state.messages.push({
        role: 'assistant',
        intent: 'qa',
        text: chatPayload.reply,
      });
      renderChatThread();
      await persistActiveSession();
      return;
    }

    // Case 2: Generated or Edited PDF
    if (!donePayload) {
      throw new Error('Server stream closed without returning a result.');
    }

    state.lastResult = donePayload;
    state.viewingVersion = donePayload.activeVersion || 1;

    if (donePayload.companyName) {
      els.companyInput.value = donePayload.companyName;
    }
    if (donePayload.jobTitle) {
      els.jobTitleInput.value = donePayload.jobTitle;
    }
    state.companyManual = false;
    state.jobTitleManual = false;
    updateJobDisplay();
    renderActiveDraftStrip();

    const fullDownloadUrl = `${baseUrl}${donePayload.downloadUrl}`;
    if (state.folder?.handle && state.folder.permission === 'granted') {
      try {
        await savePdfToSelectedFolder(fullDownloadUrl, donePayload.pdfFilename, { interactive: false });
      } catch {
        // non-fatal; user can still click Save PDF
      }
    }

    if (state.sessionToken !== mySessionToken) return;

    const intent = donePayload.intent || (endpoint === '/api/tailor' ? 'generate' : 'edit');
    const summaryText =
      donePayload.reply ||
      (donePayload.changeSummary?.length
        ? donePayload.changeSummary.map((c) => `- ${c}`).join('\n')
        : `Generated \`${donePayload.pdfFilename}\` (${donePayload.pageCount ?? 1} page).`);

    state.messages.push({
      role: 'assistant',
      intent,
      text: summaryText,
      result: donePayload,
      missingKeywords: donePayload.missingKeywords || [],
    });
    renderChatThread();
    await persistActiveSession();

    // Open or live-refresh floating preview window while leaving sidebar open
    await publishPreviewSession({
      result: donePayload,
      viewingVersion: state.viewingVersion,
      status: 'ready',
      progress: 100,
      statusMessage: '',
      bumpNonce: true,
      openWindow: true,
      focusWindow: intent === 'generate',
    });

    if (els.autoSaveAs.checked && intent === 'generate') {
      await triggerSaveAsDialog(fullDownloadUrl, donePayload.pdfFilename);
    }
  } catch (err) {
    progressHandle.remove();
    if (state.sessionToken !== mySessionToken) return;
    if (notifyPopup && state.lastResult) {
      await publishPreviewSession({ status: 'ready', progress: 100, statusMessage: '' });
    }
    if (err.name === 'AbortError') {
      showToast('Cancelled.', 'info');
    } else {
      state.messages.push({
        role: 'assistant',
        intent: 'error',
        text: err.message,
        retryAction,
      });
      renderChatThread();
      await persistActiveSession();
      if (err.code === 'AUTH_REQUIRED') {
        await checkServerHealth({ allowAutoWake: false });
      }
    }
  } finally {
    if (state.sessionToken === mySessionToken) {
      state.activeAbortController = null;
      setBusy(false);
    }
  }
}

async function handleOneClickGenerate() {
  const jd = els.jdTextarea.value.trim();
  if (jd.length < 30) {
    els.jobEditor.hidden = false;
    els.btnToggleJobEdit.setAttribute('aria-expanded', 'true');
    els.jdTextarea.focus();
    showToast('Open a job posting tab and refresh, or paste the job description.', 'error');
    return;
  }

  state.messages.push({
    role: 'user',
    text: `Generate tailored resume for ${els.companyInput.value.trim() || 'this job'}${els.jobTitleInput.value.trim() ? ` — ${els.jobTitleInput.value.trim()}` : ''}`,
  });
  renderChatThread();

  await streamEndpoint({
    endpoint: '/api/tailor',
    initialStatus: `Tailoring resume with ${getActiveAgentDisplayName()}…`,
    notifyPopup: Boolean(state.lastResult),
    retryAction: { type: 'generate' },
    requestBody: {
      sessionKey: state.sessionKey,
      companyName: els.companyInput.value.trim(),
      jobTitle: els.jobTitleInput.value.trim(),
      companyManual: state.companyManual,
      jobTitleManual: state.jobTitleManual,
      pageTitle: state.pageTitle,
      sourceUrl: state.sourceUrl,
      jobDescription: jd,
      userPrompt: '',
      masterResume: state.settings.masterResume || 'auto',
      agentId: state.settings.agentId || 'antigravity',
      model: getEffectiveModel(),
      effort: state.settings.effort || '',
      apiProvider: state.settings.apiProvider || 'openai',
      apiKey: state.settings.agentId === 'api' ? state.settings.apiKey || '' : '',
      apiBaseUrl: state.settings.agentId === 'api' ? state.settings.apiBaseUrl || '' : '',
      fastMode: Boolean(state.settings.fastMode),
    },
  });
}

async function handleChatSubmit(event) {
  event.preventDefault();
  if (state.activeAbortController) return;

  const text = els.chatInput.value.trim();
  if (!text) return;

  const priorHistory = state.messages
    .filter((m) => m.intent !== 'error')
    .slice(-8)
    .map((m) => ({ role: m.role, text: m.text }));

  els.chatInput.value = '';
  state.messages.push({ role: 'user', text });
  renderChatThread();

  await streamEndpoint({
    endpoint: '/api/chat',
    initialStatus: `Thinking with ${getActiveAgentDisplayName()}…`,
    notifyPopup: Boolean(state.lastResult),
    retryAction: { type: 'chat', text },
    requestBody: {
      sessionKey: state.sessionKey,
      message: text,
      history: priorHistory,
      folderSlug: state.lastResult?.folderSlug || '',
      companyName: els.companyInput.value.trim(),
      jobTitle: els.jobTitleInput.value.trim(),
      companyManual: state.companyManual,
      jobTitleManual: state.jobTitleManual,
      pageTitle: state.pageTitle,
      sourceUrl: state.sourceUrl,
      jobDescription: els.jdTextarea.value.trim(),
      masterResume: state.settings.masterResume || 'auto',
      agentId: state.settings.agentId || 'antigravity',
      model: getEffectiveModel(),
      effort: state.settings.effort || '',
      apiProvider: state.settings.apiProvider || 'openai',
      apiKey: state.settings.agentId === 'api' ? state.settings.apiKey || '' : '',
      apiBaseUrl: state.settings.agentId === 'api' ? state.settings.apiBaseUrl || '' : '',
      fastMode: Boolean(state.settings.fastMode),
    },
  });
}

async function loadHistoryDialog() {
  const baseUrl = normalizeServerUrl(state.settings.serverUrl);
  els.historyList.replaceChildren();
  const loading = document.createElement('li');
  loading.className = 'history-empty';
  loading.textContent = 'Loading recent resumes…';
  els.historyList.append(loading);
  els.historyDialog.showModal();

  try {
    const res = await fetch(`${baseUrl}/api/history?limit=20`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { items = [] } = await res.json();
    els.historyList.replaceChildren();

    if (items.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'history-empty';
      empty.textContent = 'No tailored resumes yet.';
      els.historyList.append(empty);
      return;
    }

    for (const item of items) {
      const li = document.createElement('li');
      li.className = 'history-item';

      const meta = document.createElement('div');
      meta.className = 'history-item-meta';
      const title = document.createElement('p');
      title.className = 'history-item-title';
      title.textContent = `${item.companyName} — ${item.jobTitle}`;
      const sub = document.createElement('p');
      sub.className = 'history-item-sub';
      sub.textContent = item.pdfFilename;
      meta.append(title, sub);

      const actions = document.createElement('div');
      actions.className = 'history-item-actions';

      const openBtn = document.createElement('button');
      openBtn.type = 'button';
      openBtn.className = 'btn btn-primary btn-xs';
      openBtn.textContent = 'Open';
      openBtn.addEventListener('click', async () => {
        els.historyDialog.close('open');
        await openHistoryDraft(item.folderSlug);
      });

      const saveBtn = document.createElement('button');
      saveBtn.type = 'button';
      saveBtn.className = 'btn btn-secondary btn-xs';
      saveBtn.textContent = 'Save';
      saveBtn.addEventListener('click', async () => {
        const dlUrl = `${baseUrl}/api/tailored/${encodeURIComponent(item.folderSlug)}/pdf`;
        await triggerSaveAsDialog(dlUrl, item.pdfFilename);
      });

      actions.append(openBtn, saveBtn);
      li.append(meta, actions);
      els.historyList.append(li);
    }
  } catch (err) {
    els.historyList.replaceChildren();
    const errLi = document.createElement('li');
    errLi.className = 'history-empty';
    errLi.textContent = `Could not load history: ${err.message}`;
    els.historyList.append(errLi);
  }
}

async function openHistoryDraft(folderSlug) {
  const baseUrl = normalizeServerUrl(state.settings.serverUrl);
  try {
    const res = await fetch(`${baseUrl}/api/tailored/${encodeURIComponent(folderSlug)}/details`, {
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const details = await res.json();

    await resetSession();
    state.lastResult = details;
    state.viewingVersion = details.activeVersion || 1;
    els.companyInput.value = details.companyName || '';
    els.jobTitleInput.value = details.jobTitle || '';
    if (details.jobDescription) els.jdTextarea.value = details.jobDescription;
    state.sourceUrl = details.sourceUrl || '';
    state.sessionUrl = normalizeJobUrl(details.sourceUrl) || `history:${folderSlug}`;
    state.pageTitle = '';
    state.companyManual = false;
    state.jobTitleManual = false;
    updateJobDisplay();
    renderActiveDraftStrip();

    state.messages = [
      {
        role: 'assistant',
        intent: 'qa',
        text: `Loaded \`${details.pdfFilename}\` (v${state.viewingVersion}). Ask any question about it or tell me what to change.`,
        result: details,
        missingKeywords: details.missingKeywords || [],
      },
    ];
    renderChatThread();
    await persistActiveSession();

    await publishPreviewSession({
      result: details,
      viewingVersion: state.viewingVersion,
      status: 'ready',
      bumpNonce: true,
      openWindow: true,
      focusWindow: true,
    });
  } catch (err) {
    showToast(`Could not open draft: ${err.message}`, 'error');
  }
}

async function consumePendingSelection() {
  try {
    const { pendingSelection } = await chrome.storage.session.get('pendingSelection');
    if (pendingSelection?.text) {
      await chrome.storage.session.remove('pendingSelection');
      const nextUrl = pendingSelection.url || '';
      const nextNorm = normalizeJobUrl(nextUrl);
      if (
        (nextNorm && state.sessionUrl && nextNorm !== state.sessionUrl) ||
        (nextNorm && state.lastResult?.sourceUrl && nextNorm !== normalizeJobUrl(state.lastResult.sourceUrl))
      ) {
        await resetSession();
      }
      els.companyInput.value = '';
      els.jobTitleInput.value = '';
      els.jdTextarea.value = pendingSelection.text;
      state.sourceUrl = nextUrl;
      state.sessionUrl = nextNorm;
      state.pageTitle = pendingSelection.pageTitle || '';
      state.companyManual = false;
      state.jobTitleManual = false;
      updateJobDisplay();
      await persistActiveSession();
      showToast('Loaded highlighted job description.', 'success');
      return true;
    }
  } catch {
    // ignore
  }
  return false;
}

async function extractTabFields(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content/extract-jd.js'],
  });
  return results?.[0]?.result || null;
}

async function startNewJobSession(extracted, tab, { forceReset = true } = {}) {
  if (forceReset) {
    await resetSession();
  }
  const rawUrl = extracted?.url || tab?.url || '';
  state.sourceUrl = rawUrl;
  state.sessionUrl = normalizeJobUrl(rawUrl);
  state.pageTitle = extracted?.pageTitle || tab?.title || '';
  els.companyInput.value = extracted?.company || '';
  els.jobTitleInput.value = extracted?.jobTitle || '';
  els.jdTextarea.value = extracted?.jobDescription || '';
  state.companyManual = false;
  state.jobTitleManual = false;
  updateJobDisplay();
  renderActiveDraftStrip();
  renderChatThread();
  await persistActiveSession();
  triggerServerWarmup();
}

async function extractFromActiveTab({ silent = false, forceReset = true } = {}) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !isTrackableWebUrl(tab.url)) {
      if (!silent) {
        showToast('Switch to a job posting tab first, then click Refresh.', 'info');
      }
      updateJobDisplay();
      return;
    }

    const extracted = await extractTabFields(tab.id);
    if (!extracted) {
      if (!silent) showToast('Could not extract job details from this page.', 'error');
      return;
    }

    const nextNorm = normalizeJobUrl(extracted.url || tab.url);
    const sameJob = Boolean(nextNorm && state.sessionUrl && nextNorm === state.sessionUrl);

    if (forceReset || !sameJob) {
      await startNewJobSession(extracted, tab, { forceReset: true });
    } else {
      state.sourceUrl = extracted.url || tab.url;
      state.pageTitle = extracted.pageTitle || tab.title || '';
      if (!els.jdTextarea.value.trim() && extracted.jobDescription) {
        els.jdTextarea.value = extracted.jobDescription;
      }
      updateJobDisplay();
      await persistActiveSession();
    }

    if (!silent) {
      const label =
        extracted.company && extracted.jobTitle
          ? `${extracted.company} · ${extracted.jobTitle}`
          : extracted.jobTitle || extracted.company || 'Company/title will auto-detect on generate';
      showToast(
        `New session: ${label} (${extracted.jobDescription.length.toLocaleString()} chars)`,
        'success',
      );
    }
  } catch (err) {
    if (!silent) showToast(`Could not read tab: ${err.message}`, 'error');
  }
}

async function checkTabForNewJobPage(tabId, { allowRetry = false } = {}) {
  const myCheckSeq = ++state.navCheckSeq;
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab?.active) return;
    if (state.hostWindowId !== null && tab.windowId !== state.hostWindowId) return;
    if (!isTrackableWebUrl(tab.url)) return;

    const nextNorm = normalizeJobUrl(tab.url);
    if (!nextNorm || nextNorm === state.sessionUrl) return;

    const extracted = await extractTabFields(tabId);
    if (myCheckSeq !== state.navCheckSeq || !extracted) return;

    // Re-verify tab didn't navigate away while extract-jd.js ran
    const freshTab = await chrome.tabs.get(tabId).catch(() => null);
    if (myCheckSeq !== state.navCheckSeq || !freshTab?.active) return;

    const freshNorm = normalizeJobUrl(extracted.url || freshTab.url);
    if (!freshNorm || freshNorm === state.sessionUrl) return;

    if (!extracted.isJobPage) {
      if (extracted.pendingSpaLoad && allowRetry) {
        clearTimeout(state.navRetryTimer);
        state.navRetryTimer = setTimeout(() => {
          checkTabForNewJobPage(tabId, { allowRetry: false });
        }, 750);
      }
      return;
    }

    await startNewJobSession(extracted, freshTab, { forceReset: true });
  } catch {
    // Tab closed, restricted, or navigation mid-flight — ignore safely
  }
}

function scheduleAutoPageCheck(tabId, { delayMs = 200, allowRetry = false } = {}) {
  if (typeof tabId !== 'number') return;
  clearTimeout(state.navDebounceTimer);
  clearTimeout(state.navRetryTimer);
  state.navDebounceTimer = setTimeout(() => {
    checkTabForNewJobPage(tabId, { allowRetry });
  }, delayMs);
}

function installClosedByFallback() {
  if ('closedBy' in HTMLDialogElement.prototype) return;
  const outside = (e, dialog) => {
    const r = dialog.getBoundingClientRect();
    return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
  };
  for (const dialog of document.querySelectorAll('dialog[closedby="any"]')) {
    let pressedOutside = false;
    dialog.addEventListener('pointerdown', (e) => {
      pressedOutside = outside(e, dialog);
    });
    dialog.addEventListener('pointerup', (e) => {
      if (pressedOutside && outside(e, dialog)) dialog.close();
    });
  }
}

async function handlePickFolder() {
  try {
    state.folder = await pickOutputFolder();
    renderFolderState();
    showToast(`Save folder set to "${state.folder.name}".`, 'success');
  } catch (err) {
    if (err.name !== 'AbortError') {
      showToast(`Could not pick folder: ${err.message}`, 'error');
    }
  }
}

function wireEvents() {
  installClosedByFallback();

  els.btnStatusDot.addEventListener('click', async () => {
    await reconnectLocalClients();
  });
  els.btnReconnect.addEventListener('click', async () => {
    await reconnectLocalClients();
  });
  els.btnRetryHealth.addEventListener('click', async () => {
    await reconnectLocalClients();
  });

  els.btnExtractTab.addEventListener('click', async () => {
    await extractFromActiveTab({ silent: false, forceReset: true });
  });

  els.btnToggleJobEdit.addEventListener('click', () => {
    const opening = els.jobEditor.hidden;
    els.jobEditor.hidden = !opening;
    els.btnToggleJobEdit.setAttribute('aria-expanded', String(opening));
    if (opening) els.companyInput.focus();
  });

  els.companyInput.addEventListener('input', () => {
    state.companyManual = Boolean(els.companyInput.value.trim());
    updateJobDisplay();
  });
  els.jobTitleInput.addEventListener('input', () => {
    state.jobTitleManual = Boolean(els.jobTitleInput.value.trim());
    updateJobDisplay();
  });
  els.jdTextarea.addEventListener('input', updateJobDisplay);

  els.btnGenerate.addEventListener('click', handleOneClickGenerate);
  els.btnOpenPreview.addEventListener('click', openPreviewFromGesture);
  els.btnSavePdf.addEventListener('click', async () => {
    await saveCurrentPdf();
  });

  els.btnRestoreRevision.addEventListener('click', async () => {
    if (!state.lastResult?.folderSlug || !state.viewingVersion) return;
    const baseUrl = normalizeServerUrl(state.settings.serverUrl);
    try {
      const res = await fetch(
        `${baseUrl}/api/tailored/${encodeURIComponent(state.lastResult.folderSlug)}/revisions/${state.viewingVersion}/restore`,
        { method: 'POST' },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const restored = await res.json();
      state.lastResult = restored;
      state.viewingVersion = restored.activeVersion;
      renderActiveDraftStrip();
      await persistActiveSession();
      await publishPreviewSession({
        result: restored,
        viewingVersion: restored.activeVersion,
        status: 'ready',
        bumpNonce: true,
      });
      showToast(`Restored v${restored.activeVersion} as active draft.`, 'success');
    } catch (err) {
      showToast(`Restore failed: ${err.message}`, 'error');
    }
  });

  // IME-safe Enter to send (Shift+Enter inserts newline)
  els.chatInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (event.isComposing || event.keyCode === 229) return;
      els.chatForm.requestSubmit();
    }
  });

  els.chatForm.addEventListener('submit', handleChatSubmit);
  els.btnStop.addEventListener('click', () => {
    state.activeAbortController?.abort();
  });

  els.btnPickFolderInline.addEventListener('click', handlePickFolder);
  els.btnPickFolder.addEventListener('click', handlePickFolder);
  els.btnClearFolder.addEventListener('click', async () => {
    await clearSavedFolder();
    state.folder = null;
    renderFolderState();
    showToast('Cleared direct save folder.', 'info');
  });

  els.btnClearChat.addEventListener('click', async () => {
    state.messages = [];
    renderChatThread();
    await persistActiveSession();
  });

  els.btnOpenHistory.addEventListener('click', loadHistoryDialog);
  els.historyDialog.addEventListener('close', () => {
    els.historyDialog.returnValue = '';
  });

  const openSettings = () => {
    els.settingServerUrl.value = state.settings.serverUrl;
    els.settingEffort.value = state.settings.effort || '';
    els.settingFastMode.checked = Boolean(state.settings.fastMode);
    els.autoSaveAs.checked = Boolean(state.settings.autoSaveAs);
    els.apiProviderSelect.value = state.settings.apiProvider || 'openai';
    els.apiKeyInput.value = state.settings.apiKey || '';
    els.apiBaseUrlInput.value = state.settings.apiBaseUrl || '';
    els.customModelInput.value = state.settings.customModel || '';
    if ([...els.agentSelect.options].some((o) => o.value === state.settings.agentId)) {
      els.agentSelect.value = state.settings.agentId;
    }
    renderModelOptionsForAgent(els.agentSelect.value || 'antigravity', state.settings.model, state.settings.effort);
    const radio = els.settingsForm.querySelector(
      `input[name="masterResume"][value="${CSS.escape(state.settings.masterResume || 'auto')}"]`,
    );
    if (radio) radio.checked = true;
    els.settingsDialog.showModal();

    const agyHealth = state.health?.agents?.find((a) => a.id === 'antigravity');
    if (!state.health || !agyHealth?.models?.length) {
      checkServerHealth({ forceRefresh: true }).catch(() => {});
    }
  };

  els.agentSelect.addEventListener('change', () => {
    renderModelOptionsForAgent(els.agentSelect.value, '', els.settingEffort.value || 'low');
  });
  els.modelSelect.addEventListener('change', () => {
    updateEffortOptionsForSelection(els.settingEffort.value || state.settings.effort || 'low');
  });
  els.apiProviderSelect.addEventListener('change', () => {
    // Clear previous provider's Base URL override so we don't send e.g. a local Ollama URL to OpenRouter
    els.apiBaseUrlInput.value = '';
    renderModelOptionsForAgent('api', '', els.settingEffort.value || 'low');
  });

  els.btnOpenSettings.addEventListener('click', openSettings);
  els.btnModelInline.addEventListener('click', openSettings);

  els.settingsDialog.addEventListener('close', async () => {
    const val = els.settingsDialog.returnValue;
    els.settingsDialog.returnValue = '';
    if (val !== 'save') return;

    const masterResume =
      els.settingsForm.querySelector('input[name="masterResume"]:checked')?.value || 'auto';
    await saveSettings({
      serverUrl: normalizeServerUrl(els.settingServerUrl.value) || DEFAULT_SETTINGS.serverUrl,
      masterResume,
      agentId: els.agentSelect.value || 'antigravity',
      model: els.modelSelect.value || '',
      customModel: els.customModelInput.value.trim(),
      effort: els.settingEffort.value || '',
      apiProvider: els.apiProviderSelect.value || 'openai',
      apiKey: els.apiKeyInput.value.trim(),
      apiBaseUrl: els.apiBaseUrlInput.value.trim().replace(/\/+$/, ''),
      autoSaveAs: els.autoSaveAs.checked,
      fastMode: els.settingFastMode.checked,
    });
    showToast('Settings saved.', 'success');
    await checkServerHealth();
    triggerServerWarmup();
  });

  els.toastDismiss.addEventListener('click', () => hideToast(true));

  // Sync revision selection / restore from floating Preview Popup Window
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'session' || !changes.previewSession?.newValue) return;
    const next = changes.previewSession.newValue;
    if (!next.result) return;
    if (
      !state.lastResult ||
      state.lastResult.folderSlug !== next.result.folderSlug ||
      state.lastResult.activeVersion !== next.result.activeVersion ||
      state.viewingVersion !== next.viewingVersion
    ) {
      state.lastResult = next.result;
      state.viewingVersion = next.viewingVersion || next.result.activeVersion || 1;
      renderActiveDraftStrip();
      persistActiveSession();
    }
  });

  chrome.tabs.onActivated.addListener((activeInfo) => {
    if (state.hostWindowId !== null && activeInfo.windowId !== state.hostWindowId) return;
    scheduleAutoPageCheck(activeInfo.tabId, { delayMs: 150, allowRetry: true });
  });

  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (!tab?.active) return;
    if (state.hostWindowId !== null && tab.windowId !== state.hostWindowId) return;
    if (!isTrackableWebUrl(tab.url)) return;

    if (changeInfo.url) {
      const delay = tab.status === 'complete' ? 550 : 900;
      scheduleAutoPageCheck(tabId, { delayMs: delay, allowRetry: true });
    } else if (changeInfo.status === 'complete') {
      scheduleAutoPageCheck(tabId, { delayMs: 250, allowRetry: true });
    }
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'CONTEXT_MENU_CAPTURED') {
      (async () => {
        const loaded = await consumePendingSelection();
        if (!loaded) await extractFromActiveTab({ silent: false, forceReset: true });
      })();
    }
  });
}

async function restoreSavedSessionIntoState(savedSession) {
  if (savedSession.sessionKey) {
    state.sessionKey = savedSession.sessionKey;
  }
  state.lastResult = savedSession.lastResult || null;
  state.viewingVersion =
    savedSession.viewingVersion || savedSession.lastResult?.activeVersion || null;
  state.sessionUrl =
    savedSession.sessionUrl || normalizeJobUrl(savedSession.lastResult?.sourceUrl || '');
  state.sourceUrl =
    savedSession.sourceUrl || savedSession.lastResult?.sourceUrl || '';
  state.pageTitle = savedSession.pageTitle || '';
  els.companyInput.value =
    savedSession.company || savedSession.lastResult?.companyName || '';
  els.jobTitleInput.value =
    savedSession.jobTitle || savedSession.lastResult?.jobTitle || '';
  els.jdTextarea.value =
    savedSession.jobDescription || savedSession.lastResult?.jobDescription || '';
  state.messages = Array.isArray(savedSession.messages) ? savedSession.messages : [];
  state.companyManual = false;
  state.jobTitleManual = false;
  updateJobDisplay();
  renderActiveDraftStrip();
  renderChatThread();
}

async function init() {
  wireEvents();
  await loadSettings();
  state.folder = isFolderPickerSupported() ? await getSavedFolder() : null;
  renderFolderState();
  renderChatThread();
  updateJobDisplay();

  try {
    const win = await chrome.windows.getCurrent();
    if (typeof win?.id === 'number') state.hostWindowId = win.id;
  } catch {
    // ignore
  }

  // Run server health check & warmup in parallel so sidebar opens instantaneously
  const healthPromise = (async () => {
    await checkServerHealth();
    triggerServerWarmup();
  })();

  const usedSelection = await consumePendingSelection();
  if (usedSelection) {
    await healthPromise;
    return;
  }

  const [{ activeSidebarSession }, { previewSession }, { lastPreviewSession }] = await Promise.all([
    chrome.storage.session.get('activeSidebarSession'),
    chrome.storage.session.get('previewSession'),
    chrome.storage.local.get('lastPreviewSession'),
  ]);

  const fallbackResult = previewSession?.result || lastPreviewSession?.result || null;
  const savedSession =
    activeSidebarSession ||
    (fallbackResult
      ? {
          sessionUrl: normalizeJobUrl(fallbackResult.sourceUrl || ''),
          sourceUrl: fallbackResult.sourceUrl || '',
          lastResult: fallbackResult,
          viewingVersion:
            previewSession?.viewingVersion ||
            lastPreviewSession?.viewingVersion ||
            fallbackResult.activeVersion ||
            1,
          messages: [],
        }
      : null);

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && typeof tab.windowId === 'number' && state.hostWindowId === null) {
    state.hostWindowId = tab.windowId;
  }

  if (!tab?.id || !isTrackableWebUrl(tab.url)) {
    if (savedSession) await restoreSavedSessionIntoState(savedSession);
    return;
  }

  const extracted = await extractTabFields(tab.id).catch(() => null);
  const tabNorm = normalizeJobUrl(extracted?.url || tab.url);
  const savedNorm = normalizeJobUrl(savedSession?.sessionUrl || savedSession?.lastResult?.sourceUrl || '');

  if (extracted?.isJobPage) {
    if (savedSession && savedNorm && tabNorm === savedNorm) {
      await restoreSavedSessionIntoState(savedSession);
      if (!els.jdTextarea.value.trim() && extracted.jobDescription) {
        els.jdTextarea.value = extracted.jobDescription;
        updateJobDisplay();
      }
    } else {
      // Entered a new job description page: clean previous session and start fresh
      await startNewJobSession(extracted, tab, { forceReset: Boolean(savedSession) });
    }
    return;
  }

  if (savedSession) {
    await restoreSavedSessionIntoState(savedSession);
  } else if (extracted) {
    // Fresh empty state on a non-standard page: populate fields without locking sessionUrl unless JD exists
    await startNewJobSession(extracted, tab, { forceReset: false });
    if (!extracted.jobDescription || extracted.jobDescription.length < 150) {
      state.sessionUrl = '';
    }
  }

  if (extracted?.pendingSpaLoad) {
    scheduleAutoPageCheck(tab.id, { delayMs: 750, allowRetry: true });
  }
  await healthPromise;
}

init();
