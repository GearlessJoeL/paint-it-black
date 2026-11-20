import { clearPdfPreviewCache, renderPdfPreview } from '../sidepanel/pdf-preview.js';

const ZOOM_MIN = 0.6;
const ZOOM_MAX = 2.25;
const ZOOM_STEP = 0.15;

const state = {
  session: null,
  zoom: 1,
  renderAbort: null,
  resizeTimer: null,
  lastWindowWidth: window.innerWidth,
};

const els = {
  title: document.getElementById('preview-title'),
  filename: document.getElementById('preview-filename'),
  pageBadge: document.getElementById('preview-page-badge'),
  toolbar: document.getElementById('preview-toolbar'),
  btnZoomOut: document.getElementById('btn-zoom-out'),
  btnZoomFit: document.getElementById('btn-zoom-fit'),
  btnZoomIn: document.getElementById('btn-zoom-in'),
  btnSaveAs: document.getElementById('btn-save-as'),
  btnOpenTab: document.getElementById('btn-open-tab'),
  btnCopyPath: document.getElementById('btn-copy-path'),
  revisionBar: document.getElementById('revision-bar'),
  restoreInline: document.getElementById('restore-inline'),
  restoreText: document.getElementById('restore-text'),
  btnRestore: document.getElementById('btn-restore'),
  regenBanner: document.getElementById('regen-banner'),
  regenProgress: document.getElementById('regen-progress'),
  regenMessage: document.getElementById('regen-message'),
  sidebarHint: document.getElementById('sidebar-hint'),
  previewMain: document.getElementById('preview-main'),
  previewStage: document.getElementById('preview-stage'),
  notesDetails: document.getElementById('notes-details'),
  notesPill: document.getElementById('notes-pill'),
  matchedList: document.getElementById('matched-list'),
  missingList: document.getElementById('missing-list'),
  changesWrap: document.getElementById('changes-wrap'),
  changesList: document.getElementById('changes-list'),
  toolbarStatus: document.getElementById('toolbar-status'),
};

function announce(msg) {
  els.toolbarStatus.textContent = '';
  requestAnimationFrame(() => {
    els.toolbarStatus.textContent = msg;
  });
}

function getBaseUrl() {
  return String(state.session?.serverUrl || 'http://127.0.0.1:8787').replace(/\/+$/, '');
}

function getCurrentPdfUrl() {
  const result = state.session?.result;
  if (!result) return '';
  const baseUrl = getBaseUrl();
  const version = state.session.viewingVersion;
  const revisions = Array.isArray(result.revisions) ? result.revisions : [];

  if (version && revisions.some((r) => r.version === version)) {
    return `${baseUrl}/api/tailored/${encodeURIComponent(result.folderSlug)}/revisions/${version}/pdf`;
  }
  if (result.downloadUrl) {
    return `${baseUrl}${result.downloadUrl}`;
  }
  return `${baseUrl}/api/tailored/${encodeURIComponent(result.folderSlug)}/pdf`;
}

function updateToolbarEnabled() {
  const hasDoc = Boolean(state.session?.result);
  for (const btn of [
    els.btnZoomOut,
    els.btnZoomFit,
    els.btnZoomIn,
    els.btnSaveAs,
    els.btnOpenTab,
    els.btnCopyPath,
  ]) {
    if (hasDoc) {
      btn.removeAttribute('aria-disabled');
    } else {
      btn.setAttribute('aria-disabled', 'true');
    }
  }
}

function renderNotes(source) {
  const matched = source?.matchedKeywords || [];
  const missing = source?.missingKeywords || [];
  const changes = source?.changeSummary || [];

  els.matchedList.replaceChildren();
  els.missingList.replaceChildren();
  els.changesList.replaceChildren();

  if (matched.length === 0 && missing.length === 0 && changes.length === 0) {
    els.notesDetails.hidden = true;
    return;
  }

  els.notesDetails.hidden = false;
  els.notesPill.textContent = `${matched.length} matched · ${missing.length} gaps`;

  for (const kw of matched.slice(0, 24)) {
    const li = document.createElement('li');
    li.textContent = kw;
    els.matchedList.append(li);
  }
  if (missing.length === 0) {
    const li = document.createElement('li');
    li.textContent = 'None reported';
    els.missingList.append(li);
  } else {
    for (const kw of missing.slice(0, 18)) {
      const li = document.createElement('li');
      li.textContent = kw;
      els.missingList.append(li);
    }
  }

  if (changes.length > 0) {
    els.changesWrap.hidden = false;
    for (const note of changes) {
      const li = document.createElement('li');
      li.textContent = note;
      els.changesList.append(li);
    }
  } else {
    els.changesWrap.hidden = true;
  }
}

function renderRevisions() {
  const result = state.session?.result;
  if (!result) {
    els.revisionBar.hidden = true;
    els.restoreInline.hidden = true;
    return;
  }

  const revisions = Array.isArray(result.revisions) ? result.revisions : [];
  const activeVersion = result.activeVersion || (revisions.length ? revisions.at(-1).version : 1);
  const viewingVersion = state.session.viewingVersion || activeVersion;

  els.revisionBar.replaceChildren();
  if (revisions.length === 0) {
    els.revisionBar.hidden = true;
    els.restoreInline.hidden = true;
    return;
  }

  els.revisionBar.hidden = false;
  for (const rev of revisions) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'rev-pill';
    btn.textContent = rev.version === activeVersion ? `v${rev.version} (active)` : `v${rev.version}`;
    btn.setAttribute('aria-pressed', String(rev.version === viewingVersion));
    btn.addEventListener('click', async () => {
      if (!state.session) return;
      const nextSession = { ...state.session, viewingVersion: rev.version };
      await chrome.storage.session.set({ previewSession: nextSession });
    });
    els.revisionBar.append(btn);
  }

  const isOlder = viewingVersion !== activeVersion;
  els.restoreInline.hidden = !isOlder;
  if (isOlder) {
    els.restoreText.textContent = `Viewing v${viewingVersion} (active is v${activeVersion})`;
    els.btnRestore.textContent = `Use v${viewingVersion} as Active`;
  }
}

async function renderCanvas({ forceReload = false } = {}) {
  const result = state.session?.result;
  if (!result) return;

  state.renderAbort?.abort();
  const abortController = new AbortController();
  state.renderAbort = abortController;

  const pdfUrl = getCurrentPdfUrl();
  els.btnZoomFit.textContent = state.zoom === 1 ? 'Fit' : `${Math.round(state.zoom * 100)}%`;
  els.btnZoomFit.setAttribute('aria-pressed', String(state.zoom === 1));

  // Keep existing rendered pages visible during re-renders (atomic swap avoids flashing);
  // only show placeholder text when the stage has no rendered page yet.
  if (!els.previewStage.querySelector('canvas')) {
    els.previewStage.replaceChildren();
    const loading = document.createElement('p');
    loading.className = 'pdf-placeholder';
    loading.textContent = 'Rendering PDF…';
    els.previewStage.append(loading);
  }

  try {
    await renderPdfPreview({
      pdfUrl,
      containerEl: els.previewStage,
      zoom: state.zoom,
      forceReload,
      signal: abortController.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError' || abortController.signal.aborted) return;
    els.previewStage.replaceChildren();
    const errEl = document.createElement('p');
    errEl.className = 'pdf-placeholder';
    errEl.textContent = `Could not render PDF: ${err.message}`;
    els.previewStage.append(errEl);
  }
}

async function applySession(nextSession, { forceReload = false } = {}) {
  const prevNonce = state.session?.revisionNonce;
  const prevSlug = state.session?.result?.folderSlug;
  const prevVersion = state.session?.viewingVersion;

  state.session = nextSession || null;
  updateToolbarEnabled();

  const result = state.session?.result;
  const isRegenerating = state.session?.status === 'regenerating';

  els.regenBanner.hidden = !isRegenerating;
  if (isRegenerating) {
    if (typeof state.session.progress === 'number') {
      els.regenProgress.value = state.session.progress;
    }
    els.regenMessage.textContent = state.session.statusMessage || 'Regenerating PDF…';
  }
  els.sidebarHint.hidden = isRegenerating;

  if (!result) {
    state.renderAbort?.abort();
    document.title = 'Resume Preview — Resume Tailor';
    els.title.textContent = 'Resume Preview';
    els.filename.textContent = 'Waiting for tailored PDF…';
    els.pageBadge.hidden = true;
    els.revisionBar.hidden = true;
    els.restoreInline.hidden = true;
    els.notesDetails.hidden = true;
    els.previewStage.replaceChildren();
    const placeholder = document.createElement('p');
    placeholder.className = 'pdf-placeholder';
    placeholder.textContent = 'Session cleared for new job page. Click Generate Resume in the side panel.';
    els.previewStage.append(placeholder);
    return;
  }

  const version = state.session.viewingVersion || result.activeVersion || 1;
  document.title = `${result.pdfFilename} (v${version}) — Resume Preview`;
  els.title.textContent = `${result.companyName} — ${result.jobTitle}`;
  els.filename.textContent = result.pdfFilename;

  const warnText =
    result.overfullHboxCount > 0 ? ` · ${result.overfullHboxCount} Overfull` : ' · Clean layout';
  els.pageBadge.hidden = false;
  els.pageBadge.textContent = `${result.pageCount ?? '?'} page${warnText}`;
  els.pageBadge.className = result.pageCount === 1 ? 'pill pill-success' : 'pill pill-warn';

  renderRevisions();

  const activeRev = (result.revisions || []).find((r) => r.version === version);
  renderNotes(activeRev?.changeSummary?.length ? activeRev : result);

  const docChanged =
    forceReload ||
    prevSlug !== result.folderSlug ||
    prevVersion !== version ||
    prevNonce !== state.session.revisionNonce;

  if (docChanged) {
    if (prevNonce !== state.session.revisionNonce) {
      clearPdfPreviewCache(`${getBaseUrl()}/api/tailored/${encodeURIComponent(result.folderSlug)}`);
    }
    await renderCanvas({ forceReload: prevNonce !== state.session.revisionNonce || forceReload });
  }
}

function installToolbarRovingFallback() {
  if ('focusGroup' in HTMLElement.prototype) return;
  const items = [...els.toolbar.querySelectorAll('button')];
  if (items.length === 0) return;

  items.forEach((btn, idx) => {
    btn.tabIndex = idx === 0 ? 0 : -1;
  });

  els.toolbar.addEventListener('focusin', ({ target }) => {
    if (items.includes(target)) {
      items.forEach((b) => {
        b.tabIndex = b === target ? 0 : -1;
      });
    }
  });

  els.toolbar.addEventListener('keydown', (event) => {
    const idx = items.indexOf(document.activeElement);
    if (idx === -1) return;

    const rtl = getComputedStyle(els.toolbar).direction === 'rtl';
    let nextIdx = -1;
    if (event.key === 'ArrowRight') nextIdx = (idx + (rtl ? -1 : 1) + items.length) % items.length;
    else if (event.key === 'ArrowLeft') nextIdx = (idx + (rtl ? 1 : -1) + items.length) % items.length;
    else if (event.key === 'Home') nextIdx = 0;
    else if (event.key === 'End') nextIdx = items.length - 1;
    else return;

    event.preventDefault();
    items[nextIdx].focus();
  });
}

function wireEvents() {
  installToolbarRovingFallback();

  const guardEnabled = (btn) => btn.getAttribute('aria-disabled') !== 'true';

  els.btnZoomOut.addEventListener('click', async () => {
    if (!guardEnabled(els.btnZoomOut)) return;
    state.zoom = Math.max(ZOOM_MIN, Number((state.zoom - ZOOM_STEP).toFixed(2)));
    await renderCanvas();
  });

  els.btnZoomFit.addEventListener('click', async () => {
    if (!guardEnabled(els.btnZoomFit)) return;
    state.zoom = 1;
    await renderCanvas();
  });

  els.btnZoomIn.addEventListener('click', async () => {
    if (!guardEnabled(els.btnZoomIn)) return;
    state.zoom = Math.min(ZOOM_MAX, Number((state.zoom + ZOOM_STEP).toFixed(2)));
    await renderCanvas();
  });

  els.btnSaveAs.addEventListener('click', async () => {
    if (!guardEnabled(els.btnSaveAs) || !state.session?.result) return;
    const url = getCurrentPdfUrl();
    const res = await chrome.runtime.sendMessage({
      type: 'SAVE_PDF_AS',
      url,
      filename: state.session.result.pdfFilename,
    });
    announce(res?.ok ? 'Opened Save As dialog' : 'Failed to open Save As dialog');
  });

  els.btnOpenTab.addEventListener('click', async () => {
    if (!guardEnabled(els.btnOpenTab) || !state.session?.result) return;
    const url = getCurrentPdfUrl();
    await chrome.runtime.sendMessage({ type: 'OPEN_PDF_PREVIEW', url: `${url}?inline=1` });
  });

  els.btnCopyPath.addEventListener('click', async () => {
    if (!guardEnabled(els.btnCopyPath) || !state.session?.result?.pdfPath) return;
    try {
      await navigator.clipboard.writeText(state.session.result.pdfPath);
      announce('Copied local PDF path');
    } catch {
      announce('Copy failed');
    }
  });

  els.btnRestore.addEventListener('click', async () => {
    const result = state.session?.result;
    const version = state.session?.viewingVersion;
    if (!result?.folderSlug || !version) return;
    try {
      const res = await fetch(
        `${getBaseUrl()}/api/tailored/${encodeURIComponent(result.folderSlug)}/revisions/${version}/restore`,
        { method: 'POST' },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const restored = await res.json();
      await chrome.storage.session.set({
        previewSession: {
          ...state.session,
          result: restored,
          viewingVersion: restored.activeVersion,
          revisionNonce: Date.now(),
        },
      });
      announce(`Restored version ${restored.activeVersion} as active draft`);
    } catch (err) {
      announce(`Restore failed: ${err.message}`);
    }
  });

  // Keyboard zoom shortcuts (Ctrl/Cmd + / - / 0)
  document.addEventListener('keydown', async (event) => {
    if (!(event.ctrlKey || event.metaKey)) return;
    if (event.key === '=' || event.key === '+') {
      event.preventDefault();
      state.zoom = Math.min(ZOOM_MAX, Number((state.zoom + ZOOM_STEP).toFixed(2)));
      await renderCanvas();
    } else if (event.key === '-') {
      event.preventDefault();
      state.zoom = Math.max(ZOOM_MIN, Number((state.zoom - ZOOM_STEP).toFixed(2)));
      await renderCanvas();
    } else if (event.key === '0') {
      event.preventDefault();
      state.zoom = 1;
      await renderCanvas();
    }
  });

  // Re-fit only when the actual popup window width changes (avoids scrollbar-induced ResizeObserver loops)
  window.addEventListener('resize', () => {
    if (!state.session?.result) return;
    const widthDelta = Math.abs(window.innerWidth - state.lastWindowWidth);
    if (widthDelta < 8) return;
    state.lastWindowWidth = window.innerWidth;
    clearTimeout(state.resizeTimer);
    state.resizeTimer = setTimeout(() => {
      renderCanvas({ forceReload: false });
    }, 180);
  });

  // Live sync whenever the Side Panel generates, regenerates, or switches revisions
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'session' || !changes.previewSession) return;
    applySession(changes.previewSession.newValue);
  });
}

async function init() {
  const isMac = /mac/i.test(navigator.userAgentData?.platform || navigator.platform || navigator.userAgent || '');
  const mod = isMac ? '⌘' : 'Ctrl+';
  els.btnZoomOut.title = `Zoom out (${mod}-)`;
  els.btnZoomFit.title = `Fit width (${mod}0)`;
  els.btnZoomIn.title = `Zoom in (${mod}=)`;

  wireEvents();
  const { previewSession } = await chrome.storage.session.get('previewSession');
  const initialSession =
    previewSession?.result
      ? previewSession
      : (await chrome.storage.local.get('lastPreviewSession')).lastPreviewSession;
  await applySession(initialSession || null, { forceReload: true });
}

init();
