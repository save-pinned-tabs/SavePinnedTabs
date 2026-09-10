import assert from 'node:assert/strict';
import test from 'node:test';

import { createStartupAutoload, restoreAutoloadSet } from '../src/autoload.mjs';

function deferred() {
  let resolve;
  const promise = new Promise((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function createBrowser({ currentTabs = [], sets = {}, removeTabs, createTab } = {}) {
  const activeTabs = {};

  return {
    storage: {
      local: {
        async get() {
          return { activeTabs: { ...activeTabs } };
        },
        async set(value) {
          Object.assign(activeTabs, value.activeTabs);
        },
      },
      sync: {
        async get() {
          return sets;
        },
      },
    },
    tabs: {
      async query() {
        return currentTabs;
      },
      remove: removeTabs ?? (async () => {}),
      create: createTab ?? (async () => {}),
    },
  };
}

test('removes existing pinned tabs before creating replacements', async () => {
  const removal = deferred();
  const operations = [];
  const browser = createBrowser({
    currentTabs: [{ id: 10, url: 'https://old.example/' }],
    sets: {
      saved: {
        autoload: 1,
        tabs: ['https://new.example/'],
      },
    },
    removeTabs: async () => {
      operations.push('remove');
      await removal.promise;
    },
    createTab: async () => {
      operations.push('create');
    },
  });

  const restoration = restoreAutoloadSet(browser, 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(operations, ['remove']);

  removal.resolve();
  await restoration;
  assert.deepEqual(operations, ['remove', 'create']);
});

test('resolves only after every tab and active-set state are restored', async () => {
  const creation = deferred();
  let hasResolved = false;
  let activeStateWasWritten = false;
  const browser = createBrowser({
    sets: {
      saved: {
        autoload: 1,
        tabs: ['https://new.example/'],
      },
    },
    createTab: async () => {
      await creation.promise;
    },
  });
  browser.storage.local.set = async () => {
    activeStateWasWritten = true;
  };

  const restoration = restoreAutoloadSet(browser, 1).then(() => {
    hasResolved = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(hasResolved, false);
  assert.equal(activeStateWasWritten, false);

  creation.resolve();
  await restoration;
  assert.equal(activeStateWasWritten, true);
});

test('rejects with the URL when a tab cannot be restored', async () => {
  const failedUrl = 'https://failed.example/';
  const browser = createBrowser({
    sets: {
      saved: {
        autoload: 1,
        tabs: [failedUrl],
      },
    },
    createTab: async () => {
      throw new Error('creation failed');
    },
  });

  await assert.rejects(
    restoreAutoloadSet(browser, 1),
    (error) => error.message.includes(failedUrl) && error.cause?.message === 'creation failed',
  );
});

test('runs startup restoration once when both startup triggers fire', async () => {
  const fallbackDelay = deferred();
  let setReads = 0;
  const browser = createBrowser();
  browser.storage.sync.get = async () => {
    setReads += 1;
    return {};
  };
  browser.windows = {
    async getAll() {
      return [{ id: 1, type: 'normal' }];
    },
    async getCurrent() {
      return { id: 99, type: 'popup' };
    },
  };
  const autoload = createStartupAutoload(browser, () => fallbackDelay.promise);

  const fallback = autoload.manual();
  const windowEvent = autoload.windowCreated({ id: 1, type: 'normal' });
  fallbackDelay.resolve();
  await Promise.all([fallback, windowEvent]);

  assert.equal(setReads, 1);
});

test('ignores popup windows without restoring pinned tabs', async () => {
  let setReads = 0;
  const browser = createBrowser();
  browser.storage.sync.get = async () => {
    setReads += 1;
    return {};
  };
  browser.windows = {
    async getAll() {
      return [{ id: 1, type: 'normal' }];
    },
  };
  const autoload = createStartupAutoload(browser, async () => {});

  await autoload.windowCreated({ id: 99, type: 'popup' });

  assert.equal(setReads, 0);
});

test('retries startup restoration when the first window is not ready', async () => {
  let windows = [];
  let setReads = 0;
  const browser = createBrowser();
  browser.storage.sync.get = async () => {
    setReads += 1;
    return {};
  };
  browser.windows = {
    async getAll() {
      return windows;
    },
  };
  const autoload = createStartupAutoload(browser, async () => {});

  await autoload.manual();
  windows = [{ id: 1, type: 'normal' }];
  await autoload.windowCreated(windows[0]);

  assert.equal(setReads, 1);
});

test('waits for the first normal window when no creation event fires', async () => {
  let windowReads = 0;
  let restoredWindowId;
  const browser = createBrowser();
  browser.tabs.query = async ({ windowId }) => {
    restoredWindowId = windowId;
    return [];
  };
  browser.windows = {
    async getAll() {
      windowReads += 1;
      return windowReads < 3 ? [] : [{ id: 5, type: 'normal' }];
    },
  };
  const autoload = createStartupAutoload(browser, async () => {});

  await autoload.manual();

  assert.equal(restoredWindowId, 5);
});

test('uses a normal window created while startup restoration is waiting', async () => {
  const fallbackDelay = deferred();
  let restoredWindowId;
  const browser = createBrowser();
  browser.tabs.query = async ({ windowId }) => {
    restoredWindowId = windowId;
    return [];
  };
  browser.windows = {
    async getAll() {
      return [];
    },
  };
  const autoload = createStartupAutoload(browser, () => fallbackDelay.promise);

  const fallback = autoload.manual();
  const windowEvent = autoload.windowCreated({ id: 7, type: 'normal' });
  fallbackDelay.resolve();
  await Promise.all([fallback, windowEvent]);

  assert.equal(restoredWindowId, 7);
});

test('allows startup restoration to retry with a replacement window', async () => {
  let attempts = 0;
  const queriedWindowIds = [];
  const browser = createBrowser();
  browser.storage.sync.get = async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('storage unavailable');
    return {};
  };
  browser.tabs.query = async ({ windowId }) => {
    queriedWindowIds.push(windowId);
    return [];
  };
  browser.windows = {
    async getAll() {
      return [{ id: 2, type: 'normal' }];
    },
  };
  const autoload = createStartupAutoload(browser, async () => {});

  await assert.rejects(
    autoload.windowCreated({ id: 1, type: 'normal' }),
    /storage unavailable/,
  );
  await autoload.windowCreated({ id: 2, type: 'normal' });

  assert.equal(attempts, 2);
  assert.deepEqual(queriedWindowIds, [1, 2]);
});

test('creates restored tabs sequentially', async () => {
  let activeCreations = 0;
  let peakCreations = 0;
  const browser = createBrowser({
    sets: {
      saved: {
        autoload: 1,
        tabs: Array.from({ length: 100 }, (_, index) => `https://example.com/${index}`),
      },
    },
    createTab: async () => {
      activeCreations += 1;
      peakCreations = Math.max(peakCreations, activeCreations);
      await new Promise((resolve) => setImmediate(resolve));
      activeCreations -= 1;
    },
  });

  await restoreAutoloadSet(browser, 1);

  assert.equal(peakCreations, 1);
});

test('keeps a matching tab whose navigation has not committed', async () => {
  let mutationCount = 0;
  const pendingUrl = 'https://pending.example/';
  const browser = createBrowser({
    currentTabs: [{ id: 10, url: '', pendingUrl }],
    sets: {
      saved: {
        autoload: 1,
        tabs: [pendingUrl],
      },
    },
    removeTabs: async () => {
      mutationCount += 1;
    },
    createTab: async () => {
      mutationCount += 1;
    },
  });

  await restoreAutoloadSet(browser, 1);

  assert.equal(mutationCount, 0);
});

test('preserves restoration invariants across randomized tab states', async () => {
  let randomState = 0x23c0ffee;
  const random = () => {
    randomState = (1664525 * randomState + 1013904223) >>> 0;
    return randomState / 0x100000000;
  };

  for (let scenario = 0; scenario < 1000; scenario += 1) {
    const savedUrls = Array.from(
      { length: Math.floor(random() * 20) },
      (_, index) => `https://example.com/${scenario}/${index}`,
    );
    const startsMatching = random() < 0.5;
    const currentUrls = startsMatching
      ? savedUrls
      : Array.from(
          { length: Math.floor(random() * 20) },
          (_, index) => `https://old.example/${scenario}/${index}`,
        );
    const tabs = currentUrls.map((url, index) => (
      random() < 0.5
        ? { id: index + 1, url }
        : { id: index + 1, url: '', pendingUrl: url }
    ));
    const originalIds = tabs.map((tab) => tab.id);
    const localState = { unrelated: scenario };
    let nextTabId = 1000;
    const browser = {
      storage: {
        local: {
          async get() {
            return { activeTabs: { ...localState.activeTabs } };
          },
          async set(value) {
            Object.assign(localState, value);
          },
        },
        sync: {
          async get() {
            return { saved: { autoload: 1, tabs: savedUrls } };
          },
        },
      },
      tabs: {
        async query() {
          return tabs.map((tab) => ({ ...tab }));
        },
        async remove() {
          tabs.length = 0;
        },
        async create({ url }) {
          tabs.push({ id: nextTabId, url });
          nextTabId += 1;
        },
      },
    };

    await restoreAutoloadSet(browser, 1);

    assert.deepEqual(tabs.map((tab) => tab.pendingUrl || tab.url), savedUrls);
    assert.equal(localState.activeTabs[1], 'saved');
    assert.equal(localState.unrelated, scenario);
    if (startsMatching) assert.deepEqual(tabs.map((tab) => tab.id), originalIds);
  }
});
