import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createCommandHandler,
  createShortcutAssignments,
  registerCommands,
} from '../src/commands.mjs';

function createCommandHarness({ failAt } = {}) {
  const calls = [];
  const shortcutSets = { 'load-set-1': 'saved' };

  async function awaitPoint(label, result) {
    calls.push(label);
    if (calls.length === failAt) throw new Error(`injected failure at ${label}`);
    return result;
  }

  const browser = {
    commands: {
      onCommand: {
        addListener(listener) {
          browser.commandListener = listener;
        },
      },
    },
    storage: {
      local: {
        get() {
          return awaitPoint('storage.local.get', { shortcutSets: { ...shortcutSets } });
        },
        async set({ shortcutSets: savedAssignments }) {
          await awaitPoint('storage.local.set');
          for (const command of Object.keys(shortcutSets)) delete shortcutSets[command];
          Object.assign(shortcutSets, savedAssignments);
        },
      },
    },
    windows: {
      getLastFocused() {
        return awaitPoint('windows.getLastFocused', { id: 7, type: 'normal' });
      },
    },
  };
  const windowTabState = {
    replace(windowId, setId) {
      return awaitPoint('windowTabState.replace', { windowId, setId });
    },
  };
  return { browser, calls, shortcutSets, windowTabState };
}

test('an assigned command awaits replacement through WindowTabState', async () => {
  const { browser, calls, windowTabState } = createCommandHarness();

  await createCommandHandler(browser, windowTabState)('load-set-1');

  assert.deepEqual(calls, [
    'storage.local.get',
    'windows.getLastFocused',
    'windowTabState.replace',
  ]);
});

test('an unassigned command does not inspect a window or mutate tabs', async () => {
  const { browser, calls, windowTabState } = createCommandHarness();
  browser.storage.local.get = async () => ({ shortcutSets: {} });

  await createCommandHandler(browser, windowTabState)('load-set-1');

  assert.deepEqual(calls, []);
});

test('each command await rejects with actionable command context', async () => {
  for (let failAt = 1; failAt <= 3; failAt += 1) {
    const { browser, windowTabState } = createCommandHarness({ failAt });

    await assert.rejects(
      createCommandHandler(browser, windowTabState)('load-set-1'),
      (error) => error.message.includes('command "load-set-1"')
        && error.message.includes('injected failure'),
      `fault ${failAt}`,
    );
  }
});

test('shortcut assignments persist and clear through serialized storage', async () => {
  const { browser, shortcutSets } = createCommandHarness();
  const assignments = createShortcutAssignments(browser);

  await assignments.assign('load-set-2', 'second');
  assert.deepEqual(await assignments.list(), {
    'load-set-1': 'saved',
    'load-set-2': 'second',
  });

  await assignments.assign('load-set-2', null);
  assert.deepEqual(shortcutSets, { 'load-set-1': 'saved' });
});

test('each shortcut assignment storage await has actionable fault context', async () => {
  for (let failAt = 1; failAt <= 2; failAt += 1) {
    const { browser } = createCommandHarness({ failAt });

    await assert.rejects(
      createShortcutAssignments(browser).assign('load-set-2', 'second'),
      (error) => error.message.includes('assign command \"load-set-2\"')
        && error.message.includes('injected failure'),
      `fault ${failAt}`,
    );
  }
});

test('command registration installs the routed handler', () => {
  const { browser, windowTabState } = createCommandHarness();

  registerCommands(browser, windowTabState);

  assert.equal(typeof browser.commandListener, 'function');
});
