import { getCliEffortOptions, getCliModelHint } from '../sidepanel/model-options.js';

const $ = (id) => document.getElementById(id);
const ids = ['server-url', 'retry', 'connection-status', 'connection-detail', 'install-help', 'agent', 'model', 'backend-detail', 'api-options', 'api-provider', 'custom-model', 'api-key', 'api-base-url', 'effort', 'resume-file', 'sharing-notice', 'import', 'progress', 'error', 'success', 'success-detail', 'review-pdf', 'resume-folder', 'done', 'setup-form'];
const els = Object.fromEntries(ids.map((id) => [id, $(id)]));
const state = { settings: {}, health: null, ready: false, importing: false, generation: 0 };

function serverUrl() {
  const url = new URL(els['server-url'].value.trim());
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) {
    throw new Error('Use the HTTP address of the companion on this computer, such as http://127.0.0.1:8787.');
  }
  return url.origin;
}

function errorMessage(message = '') {
  els.error.textContent = message;
  els.error.hidden = !message;
}

async function request(endpoint, options = {}) {
  const response = await fetch(serverUrl() + endpoint, { cache: 'no-store', ...options });
  const result = await response.json().catch(() => ({}));
  if (response.status === 404 && endpoint === '/api/setup/status') {
    throw new Error('The companion needs an update. Run Setup.command or bash scripts/setup.sh in the project folder, then reconnect.');
  }
  if (!response.ok) throw new Error(result.error || `The companion returned HTTP ${response.status}.`);
  return result;
}

function agentStatus() {
  return state.health?.agents?.find((entry) => entry.id === els.agent.value);
}

function renderEfforts() {
  const metadata = getCliEffortOptions(agentStatus(), els.model.value, els.effort.value || state.settings.effort || '');
  els.effort.replaceChildren(...metadata.options.map((entry) => new Option(entry.label, entry.value)));
  els.effort.value = metadata.value;
  els.effort.disabled = metadata.disabled || state.importing;
}

function updateNotice() {
  const file = els['resume-file'].files[0];
  const agent = agentStatus();
  const isApi = els.agent.value === 'api';
  const provider = agent?.providers?.[els['api-provider'].value];
  const label = isApi ? (provider?.label || els['api-provider'].selectedOptions[0]?.textContent || 'the selected provider') : (agent?.label || els.agent.selectedOptions[0]?.textContent || 'the selected backend');
  const destination = isApi && els['api-base-url'].value.trim() ? `${label} at ${els['api-base-url'].value.trim()}` : label;
  els['sharing-notice'].textContent = file?.name.toLowerCase().endsWith('.tex')
    ? 'Your LaTeX file will be compiled locally. This import does not send it to an AI backend.'
    : `Importing a PDF sends its extracted resume text to ${destination} for conversion. Review the editable result before using it. AI conversion may use tokens or incur provider charges.`;
  els.import.disabled = !state.ready || !file || state.importing;
}

function renderBackend({ preferredModel = els.model.value || state.settings.model || '' } = {}) {
  const agent = agentStatus();
  const isApi = els.agent.value === 'api';
  els['api-options'].hidden = !isApi;
  const models = isApi ? agent?.providers?.[els['api-provider'].value]?.models || [] : agent?.models || [];
  els.model.replaceChildren(new Option('Backend default', ''), ...models.filter((entry) => entry.id && entry.id !== 'default' && entry.id !== 'cli-default').map((entry) => new Option(entry.label || entry.id, entry.id)));
  if ([...els.model.options].some((option) => option.value === preferredModel)) els.model.value = preferredModel;
  if (!state.health) els['backend-detail'].textContent = 'Connect the companion to discover installed agents and their models.';
  else if (isApi) els['backend-detail'].textContent = 'Use your API key or an existing local model endpoint. You can enter a custom model ID.';
  else if (!agent?.installed) els['backend-detail'].textContent = `${agent?.label || els.agent.selectedOptions[0]?.textContent || 'The selected CLI'} is not installed. Install and sign in to it, then reconnect, or choose API key / local endpoint.`;
  else if (!agent.authenticated) els['backend-detail'].textContent = agent.message || 'Sign in to the selected CLI in your terminal, then reconnect.';
  else els['backend-detail'].textContent = ['codex', 'claude'].includes(agent.id) ? getCliModelHint(agent) : `${agent.label || 'Selected backend'} is ready.`;
  renderEfforts();
  updateNotice();
}

async function connect() {
  if (state.importing) return;
  const generation = ++state.generation;
  state.ready = false;
  state.health = null;
  els.retry.disabled = true;
  els['connection-status'].textContent = 'Checking…';
  els['connection-status'].dataset.ready = 'false';
  errorMessage();
  renderBackend();
  try {
    serverUrl();
    try {
      await request('/api/health', { signal: AbortSignal.timeout(1500) });
    } catch {
      await chrome.runtime.sendMessage({ type: 'ENSURE_SERVER' }).catch(() => {});
    }
    const [health, status] = await Promise.all([
      request('/api/health', { signal: AbortSignal.timeout(45_000) }),
      request('/api/setup/status', { signal: AbortSignal.timeout(15_000) }),
    ]);
    if (generation !== state.generation) return;
    state.health = health;
    state.ready = Boolean(health.latex?.installed);
    els['install-help'].hidden = state.ready;
    els['connection-status'].textContent = state.ready ? 'Connected' : 'Setup needed';
    els['connection-status'].dataset.ready = String(state.ready);
    els['connection-detail'].textContent = state.ready
      ? status.resumeConfigured ? 'Your resume is configured. You can import a replacement below; existing files stay unchanged.' : 'The companion and LaTeX are ready. Choose your own resume below to finish setup.'
      : 'Run the companion setup to automatically prepare LaTeX, then reconnect.';
    const chosen = health.agents?.find((entry) => entry.id === els.agent.value);
    if (!chosen?.installed || !chosen?.authenticated) {
      const ready = health.agents?.find((entry) => entry.id !== 'api' && entry.installed && entry.authenticated);
      if (ready && !state.settings.setupComplete && !state.settings.apiKey) els.agent.value = ready.id;
      else if (!ready && !state.settings.setupComplete) els.agent.value = 'api';
    }
    renderBackend();
  } catch (error) {
    if (generation !== state.generation) return;
    state.health = null;
    state.ready = false;
    els['install-help'].hidden = false;
    els['connection-status'].textContent = 'Not connected';
    els['connection-detail'].textContent = 'Run the one-time companion setup, then reconnect. Keep this page open while setup finishes.';
    errorMessage(error.message);
    renderBackend();
  } finally {
    els.retry.disabled = false;
    updateNotice();
  }
}

function encodeFile(bytes) {
  let binary = '';
  for (let start = 0; start < bytes.length; start += 16_384) binary += String.fromCharCode(...bytes.subarray(start, start + 16_384));
  return btoa(binary);
}

async function importResume(event) {
  event.preventDefault();
  if (state.importing || !state.ready) return;
  const file = els['resume-file'].files[0];
  if (!file) return;
  errorMessage();
  const format = file.name.split('.').pop().toLowerCase();
  if (!['pdf', 'tex'].includes(format) || !file.size || file.size > 8 * 1024 * 1024) {
    errorMessage('Choose a PDF or LaTeX (.tex) resume up to 8 MB.');
    return;
  }
  state.importing = true;
  for (const control of els['setup-form'].elements) control.disabled = true;
  els['server-url'].disabled = true;
  els.retry.disabled = true;
  els['success'].hidden = true;
  els.progress.textContent = format === 'pdf' ? 'Reading your PDF, converting it with the selected backend, and checking the one-page result… This can take a few minutes.' : 'Preparing any required LaTeX packages and checking your one-page resume…';
  try {
    const choices = {
      serverUrl: serverUrl(), agentId: els.agent.value,
      model: els.agent.value === 'api' ? els['custom-model'].value.trim() || els.model.value : els.model.value,
      customModel: els['custom-model'].value.trim(), effort: els.effort.value,
      apiProvider: els['api-provider'].value, apiKey: els['api-key'].value.trim(), apiBaseUrl: els['api-base-url'].value.trim(),
    };
    const result = await request('/api/setup/resume', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: file.name, format, contentBase64: encodeFile(new Uint8Array(await file.arrayBuffer())), ...choices }),
      signal: AbortSignal.timeout(12 * 60_000),
    });
    const current = await chrome.storage.local.get('settings');
    state.settings = { ...current.settings, ...choices, masterResume: 'auto', setupComplete: true };
    await chrome.storage.local.set({ settings: state.settings });
    els.progress.textContent = '';
    els['success-detail'].textContent = `${result.filename || file.name} is now your editable one-page resume. Its original and compiled PDF are saved locally.`;
    els['review-pdf'].href = choices.serverUrl + '/api/setup/resume/pdf';
    els['resume-folder'].textContent = result.resumeRepoDir || '';
    els.success.hidden = false;
    els.success.scrollIntoView({ behavior: 'smooth', block: 'center' });
  } catch (error) {
    els.progress.textContent = '';
    errorMessage(error.name === 'TimeoutError' ? 'Import is still taking too long. Reconnect to check the companion before trying again.' : error.message);
  } finally {
    state.importing = false;
    for (const control of els['setup-form'].elements) control.disabled = false;
    els['server-url'].disabled = false;
    els.retry.disabled = false;
    renderEfforts();
    updateNotice();
  }
}

els.retry.addEventListener('click', connect);
els['server-url'].addEventListener('input', () => {
  state.ready = false;
  state.health = null;
  state.generation += 1;
  els['connection-status'].textContent = 'Reconnect needed';
  els['connection-status'].dataset.ready = 'false';
  els['connection-detail'].textContent = 'Reconnect to check this companion address.';
  renderBackend();
});
els.agent.addEventListener('change', () => renderBackend({ preferredModel: '' }));
els['api-provider'].addEventListener('change', () => renderBackend({ preferredModel: '' }));
els.model.addEventListener('change', renderEfforts);
els['api-base-url'].addEventListener('input', updateNotice);
els['resume-file'].addEventListener('change', updateNotice);
els['setup-form'].addEventListener('submit', importResume);
els.done.addEventListener('click', () => window.close());

const stored = await chrome.storage.local.get('settings');
state.settings = stored.settings || {};
els['server-url'].value = state.settings.serverUrl || 'http://127.0.0.1:8787';
els.agent.value = state.settings.agentId || 'codex';
if (!els.agent.value) els.agent.value = 'codex';
els['api-provider'].value = state.settings.apiProvider || 'openai';
if (!els['api-provider'].value) els['api-provider'].value = 'openai';
els['custom-model'].value = state.settings.customModel || '';
els['api-key'].value = state.settings.apiKey || '';
els['api-base-url'].value = state.settings.apiBaseUrl || '';
renderBackend();
connect();
