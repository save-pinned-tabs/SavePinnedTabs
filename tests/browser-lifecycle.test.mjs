import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AUTOLOAD_EVERY_WINDOW,
  AUTOLOAD_FIRST_WINDOW,
  BrowserLifecycle,
} from '../src/browser-lifecycle.mjs';

class EphemeralWorkerStateStorage {
  #state;
  #pending = Promise.resolve();

  runExclusive(operation) {
    const result = this.#pending.then(operation);
    this.#pending = result.catch(() => {});
    return result;
  }

  async read() {
    return structuredClone(this.#state);
  }

  async write(state) {
    this.#state = structuredClone(state);
  }
}

function createHarness({
  policy = AUTOLOAD_FIRST_WINDOW,
  windows = [],
  delay = async () => {},
  onDeactivate = async () => {},
  startupWindowAttempts = 1,
} = {}) {
  const stateStorage = new EphemeralWorkerStateStorage();
  const operations = [];
  const browserWindows = [...windows];

  function createWorker() {
    return new BrowserLifecycle({
      autoloadPolicy: policy,
      stateStorage,
      windows: {
        async getAll() {
          return browserWindows.map((window) => ({ ...window }));
        },
      },
      windowTabState: {
        async resetSessions() {
          operations.push(['reset']);
        },
        async deactivate(windowId) {
          operations.push(['deactivate', windowId]);
          await onDeactivate(windowId);
        },
      },
      async restoreAutoload(windowId) {
        operations.push(['restore', windowId]);
      },
      delay,
      startupWindowAttempts,
    });
  }

  return { browserWindows, createWorker, operations };
}

test('first-window policy is deterministic when window creation precedes startup', async () => {
  const harness = createHarness({ windows: [{ id: 1, type: 'normal' }] });
  const worker = harness.createWorker();

  await worker.onWindowCreated({ id: 1, type: 'normal' });
  await Promise.all([
    worker.onBrowserStartup(),
    worker.onBrowserStartup(),
    worker.onWindowCreated({ id: 1, type: 'normal' }),
  ]);

  assert.deepEqual(harness.operations, [['reset'], ['restore', 1]]);
});

test('first-window policy follows recorded creation order instead of browser query order', async () => {
  const harness = createHarness({
    windows: [
      { id: 1, type: 'normal' },
      { id: 2, type: 'normal' },
    ],
  });
  const worker = harness.createWorker();

  await worker.onWindowCreated({ id: 2, type: 'normal' });
  await worker.onWindowCreated({ id: 1, type: 'normal' });
  await worker.onBrowserStartup();

  assert.deepEqual(harness.operations, [['reset'], ['restore', 2]]);
});

test('window creation during startup polling produces one transition', async () => {
  let releaseDelay;
  const harness = createHarness({
    delay: () => new Promise((resolve) => {
      releaseDelay = resolve;
    }),
    startupWindowAttempts: 2,
  });
  const worker = harness.createWorker();

  const startup = worker.onBrowserStartup();
  await new Promise((resolve) => setImmediate(resolve));
  await worker.onWindowCreated({ id: 1, type: 'normal' });
  releaseDelay();
  await startup;

  assert.deepEqual(harness.operations, [['reset'], ['restore', 1]]);
});

test('worker resurrection does not repeat first-window Autoload', async () => {
  const harness = createHarness({ windows: [{ id: 1, type: 'normal' }] });
  await harness.createWorker().onBrowserStartup();

  harness.browserWindows.push({ id: 2, type: 'normal' });
  const resurrectedWorker = harness.createWorker();
  await resurrectedWorker.onWindowCreated({ id: 2, type: 'normal' });
  await resurrectedWorker.onBrowserStartup();

  assert.deepEqual(harness.operations, [['reset'], ['restore', 1]]);
});

test('every-window policy survives suspension and deduplicates repeated events', async () => {
  const harness = createHarness({ policy: AUTOLOAD_EVERY_WINDOW });
  const firstWorker = harness.createWorker();
  await firstWorker.onBrowserStartup();

  await Promise.all([
    firstWorker.onWindowCreated({ id: 1, type: 'normal' }),
    firstWorker.onWindowCreated({ id: 1, type: 'normal' }),
  ]);

  const resurrectedWorker = harness.createWorker();
  await resurrectedWorker.onWindowCreated({ id: 1, type: 'normal' });
  await resurrectedWorker.onWindowCreated({ id: 2, type: 'normal' });

  assert.deepEqual(harness.operations, [['reset'], ['restore', 1], ['restore', 2]]);
});

test('every-window startup restores each existing normal window once', async () => {
  const harness = createHarness({
    policy: AUTOLOAD_EVERY_WINDOW,
    windows: [
      { id: 1, type: 'normal' },
      { id: 2, type: 'popup' },
      { id: 3, type: 'normal' },
    ],
  });
  const worker = harness.createWorker();

  await Promise.all([worker.onBrowserStartup(), worker.onBrowserStartup()]);

  assert.deepEqual(harness.operations, [
    ['reset'],
    ['restore', 1],
    ['restore', 3],
  ]);
});

test('popup windows never trigger restoration', async () => {
  const harness = createHarness({ policy: AUTOLOAD_EVERY_WINDOW });

  await harness.createWorker().onWindowCreated({ id: 9, type: 'popup' });

  assert.deepEqual(harness.operations, []);
});

test('closed windows clean their session and a reused id is a new every-window target', async () => {
  const harness = createHarness({ policy: AUTOLOAD_EVERY_WINDOW });
  const firstWorker = harness.createWorker();
  await firstWorker.onBrowserStartup();
  await firstWorker.onWindowCreated({ id: 4, type: 'normal' });
  await firstWorker.onWindowRemoved(4);

  await harness.createWorker().onWindowCreated({ id: 4, type: 'normal' });

  assert.deepEqual(harness.operations, [
    ['reset'],
    ['restore', 4],
    ['deactivate', 4],
    ['restore', 4],
  ]);
});

test('closed-window cleanup serializes against immediate window-id reuse', async () => {
  let startCleanup;
  let finishCleanup;
  const cleanupStarted = new Promise((resolve) => {
    startCleanup = resolve;
  });
  const cleanupFinished = new Promise((resolve) => {
    finishCleanup = resolve;
  });
  const harness = createHarness({
    policy: AUTOLOAD_EVERY_WINDOW,
    onDeactivate: async () => {
      startCleanup();
      await cleanupFinished;
    },
  });
  const firstWorker = harness.createWorker();
  await firstWorker.onBrowserStartup();
  await firstWorker.onWindowCreated({ id: 4, type: 'normal' });

  const removal = firstWorker.onWindowRemoved(4);
  await cleanupStarted;
  const recreation = harness.createWorker().onWindowCreated({ id: 4, type: 'normal' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(harness.operations, [
    ['reset'],
    ['restore', 4],
    ['deactivate', 4],
  ]);

  finishCleanup();
  await Promise.all([removal, recreation]);
  assert.deepEqual(harness.operations, [
    ['reset'],
    ['restore', 4],
    ['deactivate', 4],
    ['restore', 4],
  ]);
});

test('a normal window closed before startup is not selected as the first window', async () => {
  const harness = createHarness({ windows: [{ id: 2, type: 'normal' }] });
  const worker = harness.createWorker();

  await worker.onWindowCreated({ id: 1, type: 'normal' });
  await worker.onWindowRemoved(1);
  await worker.onBrowserStartup();

  assert.deepEqual(harness.operations, [
    ['deactivate', 1],
    ['reset'],
    ['restore', 2],
  ]);
});

test('listener registration occurs during service-worker module evaluation', async () => {
  const registered = [];
  const event = (name) => ({
    addListener(listener) {
      registered.push([name, listener]);
    },
  });
  const storageArea = {
    async get() { return {}; },
    async set() {},
    async remove() {},
  };
  globalThis.chrome = {
    commands: { onCommand: event('command') },
    runtime: {
      onMessage: event('message'),
      onStartup: event('startup'),
    },
    storage: {
      local: storageArea,
      session: storageArea,
      sync: storageArea,
    },
    tabs: {},
    windows: {
      getAll: async () => [],
      onCreated: event('created'),
      onRemoved: event('removed'),
    },
  };

  try {
    await import(`../src/service_worker.js?listener-test=${Date.now()}`);
  } finally {
    delete globalThis.chrome;
  }

  assert.deepEqual(
    registered.map(([name]) => name),
    ['message', 'command', 'startup', 'created', 'removed'],
  );
  assert.ok(registered.every(([, listener]) => typeof listener === 'function'));
});
