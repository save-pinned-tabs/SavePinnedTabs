import assert from 'node:assert/strict';
import test from 'node:test';

import { createCommandHandler, registerCommands } from '../src/commands.mjs';

function createCommandHarness({ assignedSetId = 'saved', failAt } = {}) {
  const calls = [];

  async function awaitPoint(label, result) {
    calls.push(label);
    if (calls.length === failAt) throw new Error(`injected failure at ${label}`);
    return result;
  }

  const shortcutAssignments = {
    list() {
      return awaitPoint('shortcutAssignments.list', assignedSetId
        ? { 'load-set-1': assignedSetId }
        : {});
    },
  };
  const browser = {
    commands: {
      onCommand: {
        addListener(listener) {
          browser.commandListener = listener;
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
  return { browser, calls, shortcutAssignments, windowTabState };
}

test('an assigned command awaits replacement through WindowTabState', async () => {
  const harness = createCommandHarness();

  await createCommandHandler(
    harness.browser,
    harness.windowTabState,
    harness.shortcutAssignments,
  )('load-set-1');

  assert.deepEqual(harness.calls, [
    'shortcutAssignments.list',
    'windows.getLastFocused',
    'windowTabState.replace',
  ]);
});

test('an unassigned command does not inspect a window or mutate tabs', async () => {
  const harness = createCommandHarness({ assignedSetId: null });

  await createCommandHandler(
    harness.browser,
    harness.windowTabState,
    harness.shortcutAssignments,
  )('load-set-1');

  assert.deepEqual(harness.calls, ['shortcutAssignments.list']);
});

test('each command await rejects with actionable command context', async () => {
  for (let failAt = 1; failAt <= 3; failAt += 1) {
    const harness = createCommandHarness({ failAt });
    await assert.rejects(
      createCommandHandler(
        harness.browser,
        harness.windowTabState,
        harness.shortcutAssignments,
      )('load-set-1'),
      (error) => error.message.includes('command "load-set-1"')
        && error.message.includes('injected failure'),
      `fault ${failAt}`,
    );
  }
});

test('command registration installs the routed handler', () => {
  const harness = createCommandHarness();

  registerCommands(harness.browser, harness.windowTabState, harness.shortcutAssignments);

  assert.equal(typeof harness.browser.commandListener, 'function');
});
