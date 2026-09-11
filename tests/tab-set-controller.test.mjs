import assert from 'node:assert/strict';
import test from 'node:test';

import { TabSetController } from '../.extension-build/tab-sets/tab-set-controller.js';

function createHarness({ failAt } = {}) {
  const calls = [];
  const sets = [{ id: 'set-1', name: 'Work', tabs: ['https://example.com/'] }];
  let autoload = { scope: 'first-window', setIds: [] };
  let assignments = { 'load-set-1': 'set-1' };

  async function operation(label, value) {
    calls.push(label);
    if (label === failAt) throw new Error(`injected failure at ${label}`);
    return structuredClone(value);
  }

  const controller = new TabSetController({
    tabSets: {
      list: () => operation('tabSets.list', sets),
      getAutoload: () => operation('tabSets.getAutoload', autoload),
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
    shortcutAssignments: {
      list: () => operation('shortcutAssignments.list', assignments),
      assign(command, setId) {
        assignments = { ...assignments, [command]: setId };
        return operation(`shortcutAssignments.assign:${command}:${setId}`);
      },
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
    getLastFocusedWindowId: () => operation('windows.getLastFocused', 9),
    listBrowserCommands: () => operation('commands.getAll', [
      { name: 'load-set-1', description: 'Load set 1', shortcut: 'Ctrl+Shift+1' },
    ]),
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
    'tabSets.list',
    'windowSessions.get:7',
    'tabSets.getAutoload',
  ]);
});

test('controller commands return contextual errors instead of rejecting', async () => {
  const { controller } = createHarness({ failAt: 'windowTabState.replace:7:set-1' });

  const result = await controller.loadSet('set-1');

  assert.equal(result.status, 'error');
  assert.match(result.error.message, /Failed to load tab set/);
  assert.match(result.error.message, /injected failure/);
});

test('keyboard shortcuts route through the same load command behavior', async () => {
  const { calls, controller } = createHarness();

  const result = await controller.runShortcut('load-set-1');

  assert.deepEqual(result, { status: 'success', value: { executed: true } });
  assert.deepEqual(calls, [
    'shortcutAssignments.list',
    'windows.getLastFocused',
    'windowTabState.replace:9:set-1',
  ]);
});

test('unassigned keyboard shortcuts are explicit successful no-ops', async () => {
  const harness = createHarness();
  await harness.controller.assignShortcut('load-set-1', '');
  harness.calls.length = 0;

  const result = await harness.controller.runShortcut('load-set-1');

  assert.deepEqual(result, { status: 'success', value: { executed: false } });
  assert.deepEqual(harness.calls, ['shortcutAssignments.list']);
});

test('options commands return deterministic state and import counts', async () => {
  const { controller } = createHarness();

  const initial = await controller.getOptionsState();
  const assigned = await controller.assignShortcut('load-set-1', 'set-1');
  const imported = await controller.importSets({ sets: [{ id: 'imported' }] });

  assert.equal(initial.status, 'success');
  assert.equal(initial.value.state.commands[0].shortcut, 'Ctrl+Shift+1');
  assert.equal(assigned.status, 'success');
  assert.equal(assigned.value.state.assignments['load-set-1'], 'set-1');
  assert.equal(imported.status, 'success');
  assert.equal(imported.value.importedCount, 1);
});
