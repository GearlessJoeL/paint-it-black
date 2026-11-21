const EFFORT_LABELS = {
  minimal: 'Minimal', low: 'Low (fastest)', medium: 'Medium', high: 'High',
  xhigh: 'Extra High', max: 'Maximum', none: 'None',
};

export function getSavedApiModel(settings) {
  return String(settings.customModel || '').trim() ||
    (settings.agentId === 'api' ? String(settings.model || '').trim() : '');
}

export function getCliEffortOptions(agent, modelId, preferredEffort = '') {
  const models = agent?.models || [];
  const model = modelId && modelId !== 'cli-default'
    ? models.find((entry) => entry.id === modelId)
    : models.find((entry) => entry.isDefault) || models.find((entry) => entry.id === 'default');
  const efforts = [...new Set(Array.isArray(model?.efforts) ? model.efforts : [])]
    .filter((effort) => typeof effort === 'string' && effort);
  return {
    options: [
      { value: '', label: 'Auto (CLI default)' },
      ...efforts.map((value) => ({ value, label: EFFORT_LABELS[value] || value })),
    ],
    value: efforts.includes(preferredEffort) ? preferredEffort : '',
    disabled: efforts.length === 0,
  };
}

export function getCliModelHint(agent) {
  const name = agent?.id === 'claude' ? 'Claude Code' : 'Codex';
  if (agent?.modelsSource === 'live') {
    return `Models loaded from ${name}. Reconnect to refresh.`;
  }
  const detail = String(agent?.modelDiscoveryError || '').slice(0, 240);
  if (agent?.modelsSource === 'cached') {
    return `Showing the last loaded ${name} models. ${detail || 'Reconnect to refresh.'}`;
  }
  return `${name} model list unavailable. CLI default is still available. ${detail || 'Reconnect to retry.'}`;
}
