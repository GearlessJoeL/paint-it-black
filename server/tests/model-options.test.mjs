import assert from 'node:assert/strict';
import test from 'node:test';
import { getCliEffortOptions, getCliModelHint, getSavedApiModel } from '../../extension/sidepanel/model-options.js';

test('saved API model migration honors the custom override and preserves legacy selections', () => {
  assert.equal(getSavedApiModel({ agentId: 'api', customModel: ' org/custom-model ', model: 'org/preset' }), 'org/custom-model');
  assert.equal(getSavedApiModel({ agentId: 'api', customModel: '', model: 'org/previous-model' }), 'org/previous-model');
  assert.equal(getSavedApiModel({ agentId: 'codex', model: 'cli-model' }), '');
  assert.equal(getSavedApiModel({ agentId: 'codex', customModel: 'org/custom-model', model: 'cli-model' }), 'org/custom-model');
});

test('CLI effort choices follow discovered metadata and preserve supported selections', () => {
  const agent = { id: 'codex', models: [
    { id: 'new-live-model', isDefault: true, efforts: ['medium', 'xhigh'] },
    { id: 'other-model', efforts: ['low', 'max'] },
  ] };
  const choices = getCliEffortOptions(agent, 'new-live-model', 'xhigh');
  assert.deepEqual(choices.options.map((option) => option.value), ['', 'medium', 'xhigh']);
  assert.equal(choices.value, 'xhigh');
  assert.equal(choices.disabled, false);
  assert.deepEqual(getCliEffortOptions(agent, '', 'low').options, choices.options);
  assert.equal(getCliEffortOptions(agent, 'other-model', 'xhigh').value, '');
  assert.deepEqual(getCliEffortOptions(agent, 'other-model', 'max').options.map((option) => option.value), ['', 'low', 'max']);
});

test('models without effort metadata leave reasoning to the CLI', () => {
  for (const model of [{ id: 'unknown' }, { id: 'unknown', efforts: [] }]) {
    const choices = getCliEffortOptions({ id: 'claude', models: [model] }, 'unknown', 'xhigh');
    assert.deepEqual(choices, { options: [{ value: '', label: 'Auto (CLI default)' }], value: '', disabled: true });
  }
});

test('model discovery hints distinguish live catalogs, cached results, and failures', () => {
  assert.match(getCliModelHint({ id: 'codex', modelsSource: 'live' }), /Models loaded from Codex/);
  assert.match(getCliModelHint({ id: 'claude', modelsSource: 'cached' }), /last loaded Claude Code models/);
  const unavailable = getCliModelHint({ id: 'codex', modelDiscoveryError: 'Please sign in.' });
  assert.match(unavailable, /CLI default is still available/);
  assert.match(unavailable, /Please sign in/);
});
