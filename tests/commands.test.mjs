import assert from 'node:assert/strict';
import test from 'node:test';

import { registerCommands } from '../.extension-build/background/commands.js';

function createHarness(result = { status: 'success', value: { executed: true } }) {
  const calls = [];
  const controller = {
    async runShortcut(command) {
      calls.push(command);
      return result;
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
  };
  return { browser, calls, controller };
}

test('a keyboard event invokes exactly one controller command', async () => {
  const harness = createHarness();
  registerCommands(harness.browser, harness.controller);

  await harness.browser.commandListener('load-set-1');

  assert.deepEqual(harness.calls, ['load-set-1']);
});

test('registered commands report explicit controller errors', async (context) => {
  const error = new Error('Could not load assigned tab set');
  const harness = createHarness({ status: 'error', error });
  const reported = [];
  context.mock.method(console, 'error', (nextError) => reported.push(nextError));
  registerCommands(harness.browser, harness.controller);

  await harness.browser.commandListener('load-set-1');

  assert.deepEqual(reported, [error]);
});
