import assert from 'node:assert/strict';
import test from 'node:test';

import { TabSetController } from '../.extension-build/tab-sets/tab-set-controller.js';

function createHarness({ failAt } = {}) {
  const calls = [];
  const sets = [{ id: 'set-1', name: 'Work', tabs: ['https://example.com/'] }];
  let autoload = { scope: 'first-window', setIds: [] };

  async function operation(label, value) {
    calls.push(label);
    if (label === failAt) throw new Error(`injected failure at ${label}`);
    return structuredClone(value);
  }

  const controller = new TabSetController({
    tabSets: {
      list: () => operation('tabSets.list', sets),
      getAutoload: () => operation('tabSets.getAutoload', autoload),
      getPopupData: () => operation('tabSets.getPopupData', { sets, autoload }),
      setAutoload(configuration) {
        autoload = structuredClone(configuration);
        return operation('tabSets.setAutoload');
      },
      remove: (setId) => operation(`tabSets.remove:${setId}`),
      export: () => operation('tabSets.export', { version: 2, sets, autoload }),
      import: (document) => operation('tabSets.import', document.sets),
    },
    windowSessions: {
      get: (windowId) => operation(`windowSessions.get:${windowId}`, 'set-1'),
    },
    windowTabState: {
      captureAndSave: (windowId, set) => operation(`windowTabState.captureAndSave:${windowId}`, {
        id: set.id ?? 'new-set',
        name: set.name,
        tabs: ['https://example.com/'],
      }),
      replace: (windowId, setId) => operation(`windowTabState.replace:${windowId}:${setId}`),
    },
    getCurrentWindowId: () => operation('windows.getCurrent', 7),
  });

  return { calls, controller };
}

test('popup commands return refreshed state without navigation', async () => {
  const { calls, controller } = createHarness();

  const result = await controller.saveSet('Work');

  assert.equal(result.status, 'success');
  assert.equal(result.value.state.activeSetId, 'set-1');
  assert.deepEqual(result.value.state.autoloadSetIds, []);
  assert.deepEqual(calls, [
    'windows.getCurrent',
    'windowTabState.captureAndSave:7',
    'tabSets.getPopupData',
    'windowSessions.get:7',
  ]);
});

test('selecting Autoload replaces the previous selection', async () => {
  const { controller } = createHarness();

  await controller.setAutoload('set-1', true);
  const result = await controller.setAutoload('set-2', true);

  assert.equal(result.status, 'success');
  assert.deepEqual(result.value.state.autoloadSetIds, ['set-2']);
});

test('controller commands return contextual errors instead of rejecting', async () => {
  const { controller } = createHarness({ failAt: 'windowTabState.replace:7:set-1' });

  const result = await controller.loadSet('set-1');

  assert.equal(result.status, 'error');
  assert.match(result.error.message, /Failed to load tab set/);
  assert.match(result.error.message, /injected failure/);
});


test('options commands return deterministic state and import counts', async () => {
  const { controller } = createHarness();

  const initial = await controller.getOptionsState();
  const imported = await controller.importSets({ sets: [{ id: 'imported' }] });

  assert.equal(initial.status, 'success');
  assert.equal(imported.status, 'success');
  assert.equal(imported.value.importedCount, 1);
});
