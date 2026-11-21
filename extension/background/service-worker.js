const CONTEXT_MENU_ID = 'tailor-resume-for-job';
const CLEAR_BADGE_ALARM = 'clear-action-badge';
const NATIVE_LAUNCHER_HOST = 'com.local.resume_tailor.launcher';
const PREVIEW_WINDOW_KEY = 'previewWindowId';

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

async function configureSidePanelBehavior() {
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch (err) {
    console.error('Failed to configure sidePanel behavior:', err);
  }
}

async function flashBadge(text, color = '#2563eb') {
  try {
    await chrome.action.setBadgeText({ text });
    await chrome.action.setBadgeBackgroundColor({ color });
    await chrome.alarms.create(CLEAR_BADGE_ALARM, { delayInMinutes: 0.5 });
  } catch (err) {
    console.warn('Badge update failed:', err);
  }
}

// Configure side panel click behavior at startup and on install
configureSidePanelBehavior();

chrome.runtime.onInstalled.addListener(async (details) => {
  await configureSidePanelBehavior();

  if (details.reason === 'install') {
    const existing = await chrome.storage.local.get('settings');
    if (!existing.settings) {
      await chrome.storage.local.set({ settings: DEFAULT_SETTINGS });
    }
    await chrome.tabs.create({ url: chrome.runtime.getURL('setup/setup.html') });
  }

  try {
    await chrome.contextMenus.removeAll();
    chrome.contextMenus.create({
      id: CONTEXT_MENU_ID,
      title: 'Tailor Resume for This Job',
      contexts: ['page', 'selection'],
    });
  } catch (err) {
    console.error('Context menu registration failed:', err);
  }
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== CONTEXT_MENU_ID || !tab) return;

  try {
    if (info.selectionText && info.selectionText.trim().length > 0) {
      await chrome.storage.session.set({
        pendingSelection: {
          text: info.selectionText.trim(),
          url: tab.url || '',
          pageTitle: tab.title || '',
          capturedAt: Date.now(),
        },
      });
    }

    await chrome.sidePanel.open({ windowId: tab.windowId });
    await flashBadge('JD', '#1d4ed8');

    try {
      await chrome.runtime.sendMessage({
        type: 'CONTEXT_MENU_CAPTURED',
        hasSelection: Boolean(info.selectionText?.trim()),
      });
    } catch {
      // Side panel may still be initializing and will read pendingSelection from storage.session
    }
  } catch (err) {
    console.error('Failed to open side panel from context menu:', err);
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'open-resume-tailor') return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.windowId !== undefined) {
      await chrome.sidePanel.open({ windowId: tab.windowId });
    }
  } catch (err) {
    console.error('Failed to open side panel from command:', err);
  }
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === CLEAR_BADGE_ALARM) {
    await chrome.action.setBadgeText({ text: '' });
  }
});

chrome.windows.onRemoved.addListener(async (closedWindowId) => {
  try {
    const { [PREVIEW_WINDOW_KEY]: savedId } = await chrome.storage.session.get(PREVIEW_WINDOW_KEY);
    if (savedId === closedWindowId) {
      await chrome.storage.session.remove(PREVIEW_WINDOW_KEY);
    }
  } catch {
    // ignore
  }
});

async function openOrFocusPreviewWindow({ focus = true } = {}) {
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
        await chrome.storage.session.set({ [PREVIEW_WINDOW_KEY]: win.id });
        return { ok: true, windowId: win.id, reused: true };
      }
    }
  } catch {
    // fall through to create
  }

  try {
    const created = await chrome.windows.create({
      url: previewUrl,
      type: 'popup',
      width: 820,
      height: 860,
      focused: Boolean(focus),
    });
    if (created?.id) {
      await chrome.storage.session.set({ [PREVIEW_WINDOW_KEY]: created.id });
    }
    return { ok: true, windowId: created?.id ?? null, reused: false };
  } catch (err) {
    return { ok: false, error: err?.message || 'Could not create preview window' };
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== 'object') return;

  if (message.type === 'SAVE_PDF_AS') {
    (async () => {
      try {
        const downloadId = await chrome.downloads.download({
          url: message.url,
          filename: message.filename,
          saveAs: true,
          conflictAction: 'uniquify',
        });
        await flashBadge('PDF', '#15803d');
        sendResponse({ ok: true, downloadId });
      } catch (err) {
        sendResponse({ ok: false, error: err?.message || 'Save As download failed' });
      }
    })();
    return true;
  }

  if (message.type === 'OPEN_PDF_PREVIEW') {
    (async () => {
      try {
        await chrome.tabs.create({ url: message.url });
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: err?.message || 'Could not open preview tab' });
      }
    })();
    return true;
  }

  if (message.type === 'OPEN_PREVIEW_WINDOW') {
    (async () => {
      try {
        const res = await openOrFocusPreviewWindow({ focus: message.focus !== false });
        sendResponse(res);
      } catch (err) {
        sendResponse({ ok: false, error: err?.message || 'Could not open preview window' });
      }
    })();
    return true;
  }

  if (message.type === 'ENSURE_SERVER') {
    (async () => {
      try {
        const result = await chrome.runtime.sendNativeMessage(NATIVE_LAUNCHER_HOST, {
          action: 'ensure_server',
        });
        sendResponse({ ok: Boolean(result?.ok), ...result });
      } catch (err) {
        sendResponse({
          ok: false,
          unavailable: true,
          error: err?.message || 'Native launcher host not installed',
        });
      }
    })();
    return true;
  }
});
