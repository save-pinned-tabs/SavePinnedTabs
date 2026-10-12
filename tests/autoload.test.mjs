import assert from 'node:assert/strict';
import test from 'node:test';

import {
  preloadFavicons,
  restoreAutoloadSets,
} from '../.extension-build/background/autoload.js';
import { createBrowserWindowTabState } from '../.extension-build/storage/window-tab-state.js';
import { createBrowserRepositories } from '../.extension-build/storage/browser-repositories.js';
import { LOCAL_DOCUMENT_KEY, SYNC_DOCUMENT_KEY } from '../.extension-build/storage/storage-schema.js';

async function restoreAutoloadSet(browser, windowId, windowTabState) {
  const configuration =
    await createBrowserRepositories(browser).tabSets.getAutoload();
  return restoreAutoloadSets(browser, windowId, configuration, windowTabState);
}

async function loadTabSet(browser, setId, windowId) {
  const windowTabState = createBrowserWindowTabState(browser, {
    onReplace(urls) {
      void preloadFavicons(browser, urls);
    },
  });
  await windowTabState.replace(windowId, setId);
}

function deferred() {
  let resolve;
  const promise = new Promise((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function createBrowser({
  currentTabs = [],
  sets = {},
  sessions = {},
  removeTabs,
  createTab,
  updateTab,
} = {}) {
  const syncDocument = {
    version: 2,
    sets: Object.fromEntries(Object.entries(sets).map(([id, set]) => [id, {
      id,
      name: set.name ?? set.set_name ?? id,
      tabs: [...set.tabs],
    }])),
    autoload: {
      scope: 'first-window',
      setIds: Object.entries(sets)
        .filter(([, set]) => set.autoload === 1)
        .map(([id]) => id),
    },
    deletedSetIds: [],
  };
  const syncState = { [SYNC_DOCUMENT_KEY]: syncDocument };
  const localDocument = {
    version: 2,
    windowSessions: { ...sessions },
  };
  let nextTabId = 100;

  const browser = {
    get sessionState() {
      return localDocument.windowSessions;
    },
    storage: {
      local: {
        async get(key) {
          if (key === null) return { [LOCAL_DOCUMENT_KEY]: structuredClone(localDocument) };
          return { [LOCAL_DOCUMENT_KEY]: structuredClone(localDocument) };
        },
        async set(value) {
          Object.assign(localDocument, structuredClone(value[LOCAL_DOCUMENT_KEY]));
        },
        async remove() {},
      },
      sync: {
        async get(key) {
          if (key === null) return structuredClone(syncState);
          const keys = Array.isArray(key) ? key : [key];
          return Object.fromEntries(keys
            .filter((storageKey) => storageKey in syncState)
            .map((storageKey) => [storageKey, structuredClone(syncState[storageKey])]));
        },
        async set(value) {
          Object.assign(syncState, structuredClone(value));
        },
        async remove(keys) {
          for (const key of Array.isArray(keys) ? keys : [keys]) delete syncState[key];
        },
      },
    },
    tabs: {
      async query() {
        return currentTabs;
      },
      remove: removeTabs ?? (async () => {}),
      async create(properties) {
        const created = await createTab?.(properties);
        return created ?? { id: nextTabId++, ...properties };
      },
      update: updateTab ?? (async () => {}),
    },
  };
  browser.testSyncDocument = syncDocument;
  return browser;
}

test('Autoload restores the first configured set that still exists', async () => {
  const browser = createBrowser({
    sets: {
      first: { tabs: ['https://first.example/'] },
      second: { tabs: ['https://second.example/'] },
    },
  });

  const result = await restoreAutoloadSets(
    browser,
    7,
    { scope: 'every-window', setIds: ['missing', 'first', 'second'] },
  );

  assert.deepEqual(result.restoredUrls, ['https://first.example/']);
  assert.equal(result.total, 1);
  assert.deepEqual(result.failures, []);
  assert.equal(browser.sessionState[7], 'first');
});

test('Autoload clears the active session when no configured set exists', async () => {
  for (const setIds of [[], ['missing']]) {
    const browser = createBrowser({
      sets: { first: { tabs: ['https://first.example/'] } },
      sessions: { 7: 'first' },
    });

    const result = await restoreAutoloadSets(
      browser,
      7,
      { scope: 'first-window', setIds },
    );

    assert.equal(result, undefined);
    assert.equal(browser.sessionState[7], undefined);
  }
});

test('Autoload returns partial restoration and logs every failure', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const failedUrl = 'file:///missing.html';
  const restoredUrl = 'https://saved.example/';
  const cleanupUrl = 'https://pin-failed.example/';
  const browser = createBrowser({
    sets: { saved: { autoload: 1, tabs: [failedUrl, restoredUrl, cleanupUrl] } },
    createTab: async ({ url }) => {
      if (url === failedUrl) throw new Error('File not found');
      return { id: url === cleanupUrl ? 102 : 101 };
    },
    updateTab: async (tabId) => {
      if (tabId === 102) throw new Error('Pin denied');
    },
    removeTabs: async (tabIds) => {
      if ((Array.isArray(tabIds) ? tabIds : [tabIds]).includes(102)) {
        throw new Error('Removal denied');
      }
    },
  });

  const result = await restoreAutoloadSet(browser, 1);

  assert.deepEqual(result.restoredUrls, [restoredUrl]);
  assert.equal(result.total, 3);
  assert.deepEqual(result.failures.map(({ url }) => url), [failedUrl, cleanupUrl]);
  assert.match(result.failures[0].reason, /File not found/);
  assert.match(result.failures[1].reason, /Pin denied/);
  assert.match(result.failures[1].cleanupError, /Removal denied/);
  assert.equal(browser.sessionState[1], 'saved');
  assert.equal(warn.mock.calls.length, 1);
  assert.match(warn.mock.calls[0].arguments[0], /Restored 1 of 3 tabs/);
  assert.deepEqual(warn.mock.calls[0].arguments[1], result.failures);
});

test('Autoload propagates operation-wide restoration errors', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const browser = createBrowser({
    sets: { saved: { tabs: ['https://saved.example/'] } },
  });
  browser.tabs.query = async () => { throw new Error('Tab query denied'); };

  await assert.rejects(
    restoreAutoloadSets(browser, 7, { scope: 'first-window', setIds: ['saved'] }),
    /Tab query denied/,
  );
  assert.equal(warn.mock.calls.length, 0);
});

test('creates and pins replacements before removing existing pinned tabs', async () => {
  const creation = deferred();
  const creationStarted = deferred();
  const operations = [];
  const browser = createBrowser({
    currentTabs: [{ id: 10, url: 'https://old.example/' }],
    sets: {
      saved: {
        autoload: 1,
        tabs: ['https://new.example/'],
      },
    },
    createTab: async () => {
      operations.push('create');
      creationStarted.resolve();
      await creation.promise;
      return { id: 100 };
    },
    updateTab: async () => {
      operations.push('pin');
    },
    removeTabs: async () => {
      operations.push('remove');
    },
  });

  const restoration = restoreAutoloadSet(browser, 1);
  await creationStarted.promise;
  assert.deepEqual(operations, ['create']);

  creation.resolve();
  await restoration;
  assert.deepEqual(operations, ['create', 'pin', 'remove']);
});

test('does not recreate a dangling session when its set is deleted during load', async () => {
  const creationStarted = deferred();
  const finishCreation = deferred();
  const sets = {
    saved: {
      set_name: 'Saved',
      autoload: 0,
      tabs: ['https://saved.example/'],
    },
  };
  const browser = createBrowser({
    sets,
    createTab: async () => {
      creationStarted.resolve();
      await finishCreation.promise;
    },
  });
  browser.storage.sync.remove = async (setId) => {
    delete sets[setId];
  };

  const loading = loadTabSet(browser, 'saved', 1);
  await creationStarted.promise;

  const repositories = createBrowserRepositories(browser);
  await repositories.tabSets.remove('saved');
  finishCreation.resolve();

  await assert.rejects(
    loading,
    /changed or was deleted during the transition/,
  );
  assert.equal(await repositories.windowSessions.get(1), null);
});

test('preloads each saved favicon through the browser favicon cache', async () => {
  const requestedUrls = [];
  const browser = {
    runtime: {
      getURL(path) {
        return `chrome-extension://extension-id${path}`;
      },
    },
    permissions: {
      async contains() {
        return true;
      },
    },
  };

  await preloadFavicons(
    browser,
    ['https://first.example/', 'https://second.example/'],
    async (url) => {
      requestedUrls.push(url.href);
      return {
        ok: true,
        async arrayBuffer() {},
      };
    },
  );

  assert.deepEqual(requestedUrls, [
    'chrome-extension://extension-id/_favicon/?pageUrl=https%3A%2F%2Ffirst.example%2F&size=32',
    'chrome-extension://extension-id/_favicon/?pageUrl=https%3A%2F%2Fsecond.example%2F&size=32',
  ]);
});

test('skips favicon requests when the browser lacks favicon permission', async () => {
  for (const contains of [
    async () => false,
    async () => { throw new Error('unknown permission'); },
  ]) {
    let requested = false;
    const browser = {
      permissions: { contains },
      runtime: {
        getURL() {
          requested = true;
          throw new Error('should not construct favicon URL');
        },
      },
    };

    await preloadFavicons(browser, ['https://saved.example/'], async () => {
      requested = true;
    });

    assert.equal(requested, false);
  }
});

test('does not delay restoration while favicon loading is pending', async () => {
  const faviconResponse = deferred();
  let created = false;
  const browser = createBrowser({
    sets: {
      saved: {
        autoload: 1,
        tabs: ['https://saved.example/'],
      },
    },
    createTab: async () => {
      created = true;
    },
  });
  browser.runtime = {
    getURL(path) {
      return `chrome-extension://extension-id${path}`;
    },
  };
  browser.permissions = {
    async contains() {
      return true;
    },
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => faviconResponse.promise;

  try {
    await restoreAutoloadSet(browser, 1);
    assert.equal(created, true);
  } finally {
    globalThis.fetch = originalFetch;
    faviconResponse.resolve({ ok: false });
  }
});

test('resolves only after every tab and active-set state are restored', async () => {
  const creation = deferred();
  let hasResolved = false;
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

  const restoration = restoreAutoloadSet(browser, 1).then(() => {
    hasResolved = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(hasResolved, false);
  assert.equal(browser.sessionState[1], undefined);

  creation.resolve();
  await restoration;
  assert.equal(browser.sessionState[1], 'saved');
});

test('Autoload reports all failed URLs without rejecting', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
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

  const result = await restoreAutoloadSet(browser, 1);

  assert.deepEqual(result.restoredUrls, []);
  assert.equal(result.total, 1);
  assert.equal(result.failures[0].url, failedUrl);
  assert.match(result.failures[0].reason, /creation failed/);
  assert.equal(warn.mock.calls.length, 1);
  assert.match(warn.mock.calls[0].arguments[0], /Restored 0 of 1 tabs/);
  assert.deepEqual(warn.mock.calls[0].arguments[1], result.failures);
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
    let nextTabId = 1000;
    const browser = createBrowser({
      currentTabs: tabs,
      sets: { saved: { autoload: 1, tabs: savedUrls } },
      async removeTabs(tabIds) {
        const removedIds = new Set(Array.isArray(tabIds) ? tabIds : [tabIds]);
        const remaining = tabs.filter((tab) => !removedIds.has(tab.id));
        tabs.splice(0, tabs.length, ...remaining);
      },
      async createTab({ url }) {
        const tab = { id: nextTabId, url, pinned: false };
        tabs.push(tab);
        nextTabId += 1;
        return tab;
      },
      async updateTab(tabId, changes) {
        Object.assign(tabs.find((tab) => tab.id === tabId), changes);
      },
    });

    await restoreAutoloadSet(browser, 1);

    assert.deepEqual(tabs.map((tab) => tab.pendingUrl || tab.url), savedUrls);
    assert.equal(browser.sessionState[1], 'saved');
    if (startsMatching) assert.deepEqual(tabs.map((tab) => tab.id), originalIds);
  }
});
