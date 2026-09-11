import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createBrowserWindowTabState,
  createWindowTabStateClient,
  registerWindowTabStateMessages,
} from '../.extension-build/storage/window-tab-state.js';
import { LOCAL_DOCUMENT_KEY, SYNC_DOCUMENT_KEY } from '../.extension-build/storage/storage-schema.js';

function createHarness({ tabs = [], sets = {}, sessions = {}, failAt = [] } = {}) {
  const state = {
    tabs: tabs.map((tab, index) => ({
      index,
      pinned: true,
      windowId: 1,
      ...structuredClone(tab),
    })),
    sets: Object.fromEntries(Object.entries(sets).map(([id, set]) => [id, {
      id,
      name: set.name ?? set.set_name ?? id,
      tabs: [...set.tabs],
    }])),
    autoload: { scope: 'first-window', setIds: [] },
    sessions: structuredClone(sessions),
    calls: [],
    nextTabId: 100,
  };
  const failures = new Set(Array.isArray(failAt) ? failAt : [failAt]);

  async function browserAwait(label, operation) {
    state.calls.push(label);
    if (failures.has(state.calls.length)) throw new Error(`injected failure at ${label}`);
    return operation();
  }

  function reindex() {
    state.tabs.forEach((tab, index) => {
      tab.index = index;
    });
  }

  const browser = {
    storage: {
      local: {
        get(key) {
          if (key === null) {
            return Promise.resolve({
              [LOCAL_DOCUMENT_KEY]: {
                version: 2,
                windowSessions: structuredClone(state.sessions),
                shortcutAssignments: {},
              },
            });
          }
          return browserAwait('storage.local.get', () => ({
            [LOCAL_DOCUMENT_KEY]: {
              version: 2,
              windowSessions: structuredClone(state.sessions),
              shortcutAssignments: {},
            },
          }));
        },
        set(value) {
          return browserAwait('storage.local.set', () => {
            if (value[LOCAL_DOCUMENT_KEY]) {
              state.sessions = structuredClone(value[LOCAL_DOCUMENT_KEY].windowSessions);
            }
          });
        },
        remove() {
          return browserAwait('storage.local.remove', () => {});
        },
      },
      sync: {
        get(key) {
          const document = {
            version: 2,
            sets: structuredClone(state.sets),
            autoload: structuredClone(state.autoload),
            deletedSetIds: [],
          };
          if (key === null) return Promise.resolve({ [SYNC_DOCUMENT_KEY]: document });
          return browserAwait('storage.sync.get', () => ({ [SYNC_DOCUMENT_KEY]: document }));
        },
        set(values) {
          return browserAwait('storage.sync.set', () => {
            const document = values[SYNC_DOCUMENT_KEY];
            if (!document) return;
            state.sets = structuredClone(document.sets);
            state.autoload = structuredClone(document.autoload);
          });
        },
        remove() {
          return browserAwait('storage.sync.remove', () => {});
        },
      },
    },
    tabs: {
      query({ pinned, windowId }) {
        return browserAwait('tabs.query', () => state.tabs
          .filter((tab) => tab.windowId === windowId && (!pinned || tab.pinned))
          .map((tab) => structuredClone(tab)));
      },
      create(properties) {
        return browserAwait('tabs.create', () => {
          const tab = {
            id: state.nextTabId,
            index: state.tabs.length,
            pinned: Boolean(properties.pinned),
            windowId: properties.windowId,
            url: properties.url,
          };
          state.nextTabId += 1;
          state.tabs.push(tab);
          return structuredClone(tab);
        });
      },
      update(tabId, properties) {
        return browserAwait('tabs.update', () => {
          const tab = state.tabs.find((candidate) => candidate.id === tabId);
          if (!tab) throw new Error(`unknown tab ${tabId}`);
          Object.assign(tab, properties);
          return structuredClone(tab);
        });
      },
      remove(tabIds) {
        return browserAwait('tabs.remove', () => {
          const removedIds = new Set(Array.isArray(tabIds) ? tabIds : [tabIds]);
          state.tabs = state.tabs.filter((tab) => !removedIds.has(tab.id));
          reindex();
        });
      },
    },
  };

  return { browser, state };
}

function pinnedUrls(state) {
  return state.tabs.filter((tab) => tab.pinned).map((tab) => tab.pendingUrl || tab.url);
}

const originalSet = {
  set_name: 'Original',
  autoload: 0,
  tabs: ['https://old.example/'],
};
const replacementSet = {
  set_name: 'Replacement',
  autoload: 0,
  tabs: ['https://first.example', 'https://second.example/'],
};

function replacementHarness(failAt = []) {
  return createHarness({
    tabs: [{ id: 10, url: 'https://old.example/' }],
    sets: { original: originalSet, replacement: replacementSet },
    sessions: { 1: 'original' },
    failAt,
  });
}

test('snapshot normalizes pending URLs and browser tab ordering', async () => {
  const { browser } = createHarness({
    tabs: [
      { id: 10, index: 4, url: 'https://later.example/' },
      { id: 11, index: 2, url: '', pendingUrl: 'https://pending.example' },
    ],
  });

  const snapshot = await createBrowserWindowTabState(browser).snapshot(1);

  assert.deepEqual(snapshot, ['https://pending.example/', 'https://later.example/']);
});

test('snapshot adds window context to a browser query failure', async () => {
  const { browser } = createHarness({ failAt: 1 });

  await assert.rejects(
    createBrowserWindowTabState(browser).snapshot(42),
    (error) => error.message.includes('window "42"') && error.message.includes('tabs.query'),
  );
});

test('replacement creates and pins the complete ordered set before removing originals', async () => {
  const { browser, state } = replacementHarness();

  await createBrowserWindowTabState(browser).replace(1, 'replacement');

  assert.deepEqual(pinnedUrls(state), ['https://first.example/', 'https://second.example/']);
  assert.equal(state.sessions[1], 'replacement');
  assert.deepEqual(state.calls.slice(-6), [
    'tabs.create',
    'tabs.update',
    'storage.sync.get',
    'storage.local.get',
    'storage.local.set',
    'tabs.remove',
  ]);
  const firstCreate = state.calls.indexOf('tabs.create');
  const originalRemoval = state.calls.lastIndexOf('tabs.remove');
  assert.ok(firstCreate >= 0 && firstCreate < originalRemoval);
});

test('each replacement browser or storage failure preserves originals and cleans new tabs', async () => {
  const successful = replacementHarness();
  await createBrowserWindowTabState(successful.browser).replace(1, 'replacement');
  const awaitCount = successful.state.calls.length;

  for (let failAt = 1; failAt <= awaitCount; failAt += 1) {
    const { browser, state } = replacementHarness(failAt);

    await assert.rejects(
      createBrowserWindowTabState(browser).replace(1, 'replacement'),
      (error) => error.message.includes('window "1"') && error.message.includes('injected failure'),
      `fault ${failAt}`,
    );

    assert.deepEqual(pinnedUrls(state), ['https://old.example/'], `fault ${failAt}`);
    assert.equal(state.tabs.some((tab) => tab.id >= 100), false, `fault ${failAt}`);
    if (failAt > 4) assert.equal(state.sessions[1] ?? null, null, `fault ${failAt}`);
  }
});

test('replacement reports deterministic rollback failures with the primary failure', async () => {
  const { browser } = replacementHarness([7, 9]);

  await assert.rejects(
    createBrowserWindowTabState(browser).replace(1, 'replacement'),
    (error) => error.message.includes('injected failure at tabs.create')
      && error.message.includes('rollback also failed')
      && error.message.includes('injected failure at tabs.remove'),
  );
});

test('replacement injects failures at each session and tab cleanup await', async () => {
  for (const cleanupFailure of [13, 14, 15]) {
    const { browser } = replacementHarness([12, cleanupFailure]);

    await assert.rejects(
      createBrowserWindowTabState(browser).replace(1, 'replacement'),
      (error) => error.message.includes('rollback also failed')
        && error.message.includes('injected failure'),
      `cleanup fault ${cleanupFailure}`,
    );
  }
});


test('capture and save persists normalized ordered URLs and activates the saved set', async () => {
  const { browser, state } = createHarness({
    tabs: [
      { id: 10, index: 2, url: 'https://second.example/' },
      { id: 11, index: 1, url: '', pendingUrl: 'https://first.example' },
    ],
    sessions: { 1: 'stale' },
  });

  const saved = await createBrowserWindowTabState(browser).captureAndSave(1, {
    name: 'Captured',
  });

  assert.deepEqual(saved.tabs, ['https://first.example/', 'https://second.example/']);
  assert.deepEqual(state.sets[saved.id], saved);
  assert.equal(state.sessions[1], saved.id);
});

test('capture with no pinned tabs clears a stale session without saving an empty set', async () => {
  const { browser, state } = createHarness({ sessions: { 1: 'stale' } });

  const saved = await createBrowserWindowTabState(browser).captureAndSave(1, {
    name: 'Captured',
  });

  assert.equal(saved, null);
  assert.equal(state.sessions[1] ?? null, null);
  assert.equal(state.sets.captured, undefined);
});

test('each capture/save storage failure leaves no false active session', async () => {
  const successful = createHarness({ tabs: [{ id: 10, url: 'https://saved.example/' }], sessions: { 1: 'stale' } });
  await createBrowserWindowTabState(successful.browser).captureAndSave(1, { name: 'Captured' });

  for (let failAt = 1; failAt <= successful.state.calls.length; failAt += 1) {
    const { browser, state } = createHarness({
      tabs: [{ id: 10, url: 'https://saved.example/' }],
      sessions: { 1: 'stale' },
      failAt,
    });

    await assert.rejects(
      createBrowserWindowTabState(browser).captureAndSave(1, { name: 'Captured' }),
    );
    assert.ok(['stale', null].includes(state.sessions[1] ?? null), `fault ${failAt}`);
  }
});

test('capture/save reports a failure while clearing the session after storage failure', async () => {
  for (const failAt of [[4, 5], [6, 7]]) {
    const { browser } = createHarness({
      tabs: [{ id: 10, url: 'https://saved.example/' }],
      sessions: { 1: 'stale' },
      failAt,
    });

    await assert.rejects(
      createBrowserWindowTabState(browser).captureAndSave(1, { name: 'Captured' }),
      (error) => error.message.includes('rollback also failed')
        && error.message.includes('storage.local.get'),
    );
  }
});

test('startup reset awaits and contextualizes session storage failure', async () => {
  const { browser } = createHarness({ failAt: 1 });

  await assert.rejects(
    createBrowserWindowTabState(browser).resetSessions(),
    (error) => error.message.includes('reset all window sessions')
      && error.message.includes('storage.local.get'),
  );
});

class SharedLockManager {
  pendingByName = new Map();
  activeByName = new Map();
  peakByName = new Map();
  requests = [];

  request(name, options, operation) {
    if (typeof options === 'function') {
      operation = options;
      options = { mode: 'exclusive' };
    }
    this.requests.push({ name, mode: options.mode });
    const previous = this.pendingByName.get(name) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(async () => {
      const active = (this.activeByName.get(name) ?? 0) + 1;
      this.activeByName.set(name, active);
      this.peakByName.set(name, Math.max(this.peakByName.get(name) ?? 0, active));
      try {
        return await operation();
      } finally {
        this.activeByName.set(name, active - 1);
      }
    });
    this.pendingByName.set(name, current);
    return current;
  }
}

test('window transitions and startup reset serialize across extension contexts', async () => {
  const { browser, state } = createHarness({
    tabs: [{ id: 10, url: 'https://old.example/' }],
    sets: { replacement: replacementSet },
    sessions: { 1: 'old' },
  });
  const lockManager = new SharedLockManager();
  const originalNavigator = globalThis.navigator;
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { locks: lockManager },
  });

  try {
    const contexts = Array.from({ length: 3 }, () => createBrowserWindowTabState({
      ...browser,
      storage: {
        local: { ...browser.storage.local },
        sync: { ...browser.storage.sync },
      },
    }));
    await Promise.all([
      contexts[0].replace(1, 'replacement'),
      contexts[1].captureAndSave(1, { name: 'Captured' }),
      contexts[2].resetSessions(),
    ]);
  } finally {
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: originalNavigator,
    });
  }

  assert.equal(Math.max(...lockManager.peakByName.values()), 1);
  assert.deepEqual(
    lockManager.requests
      .filter(({ name }) => name === 'save-pinned-tabs:all-window-tabs')
      .map(({ mode }) => mode),
    ['shared', 'shared', 'exclusive'],
  );
  assert.deepEqual(pinnedUrls(state), ['https://first.example/', 'https://second.example/']);
  assert.deepEqual(
    Object.values(state.sets).find((set) => set.name === 'Captured').tabs,
    ['https://first.example/', 'https://second.example/'],
  );
  assert.equal(state.sessions[1] ?? null, null);
});

test('background routing serializes isolated clients without Web Locks and releases after failure', async () => {
  const { browser, state } = createHarness({
    tabs: [{ id: 10, url: 'https://old.example/' }],
    sets: { replacement: replacementSet },
  });
  let onMessage;
  browser.runtime = {
    onMessage: {
      addListener(listener) {
        onMessage = listener;
      },
    },
  };
  const backgroundState = createBrowserWindowTabState(browser);
  registerWindowTabStateMessages(browser, backgroundState);

  function isolatedClient() {
    return createWindowTabStateClient({
      runtime: {
        sendMessage(message) {
          return Promise.resolve(onMessage(message));
        },
      },
    });
  }

  const originalQuery = browser.tabs.query;
  let activeQueries = 0;
  let peakQueries = 0;
  browser.tabs.query = async (query) => {
    activeQueries += 1;
    peakQueries = Math.max(peakQueries, activeQueries);
    await new Promise((resolve) => setImmediate(resolve));
    try {
      return await originalQuery(query);
    } finally {
      activeQueries -= 1;
    }
  };

  const originalNavigator = globalThis.navigator;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: undefined });
  try {
    const firstContext = isolatedClient();
    const secondContext = isolatedClient();
    await Promise.all([
      firstContext.replace(1, 'replacement'),
      secondContext.replace(1, 'replacement'),
    ]);
    await assert.rejects(firstContext.replace(1, 'missing'), /does not exist/);
    await secondContext.snapshot(1);
  } finally {
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: originalNavigator,
    });
  }

  assert.equal(peakQueries, 1);
  assert.deepEqual(pinnedUrls(state), ['https://first.example/', 'https://second.example/']);
});

test('message routing distinguishes invalid arguments from unknown operations', async () => {
  let listener;
  const browser = {
    runtime: {
      onMessage: {
        addListener(nextListener) {
          listener = nextListener;
        },
      },
    },
  };
  const windowTabState = {
    snapshot() {},
    replace() {},
    captureAndSave() {},
  };
  registerWindowTabStateMessages(browser, windowTabState);

  await assert.rejects(
    listener({
      type: 'save-pinned-tabs:window-tab-state',
      operation: 'replace',
      args: ['invalid-window-id', 'set'],
    }),
    /Invalid arguments.*replace/,
  );
  await assert.rejects(
    listener({
      type: 'save-pinned-tabs:window-tab-state',
      operation: 'erase',
      args: [],
    }),
    /Unknown WindowTabState operation "erase"/,
  );
  await assert.rejects(
    listener({
      type: 'save-pinned-tabs:window-tab-state',
      operation: 'toString',
      args: [],
    }),
    /Unknown WindowTabState operation "toString"/,
  );
});
