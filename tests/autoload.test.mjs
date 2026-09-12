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
          if (key === null) return { [SYNC_DOCUMENT_KEY]: structuredClone(syncDocument) };
          return { [SYNC_DOCUMENT_KEY]: structuredClone(syncDocument) };
        },
        async set(value) {
          Object.assign(syncDocument, structuredClone(value[SYNC_DOCUMENT_KEY]));
        },
        async remove() {},
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

test('Autoload restores the selected existing set', async () => {
  const browser = createBrowser({
    sets: {
      first: { tabs: ['https://first.example/'] },
    },
  });
  const operations = [];
  const windowTabState = {
    async replace(windowId, setId) {
      operations.push(['replace', windowId, setId]);
    },
  };

  await restoreAutoloadSets(
    browser,
    7,
    { scope: 'every-window', setIds: ['first'] },
    windowTabState,
  );

  assert.deepEqual(operations, [['replace', 7, 'first']]);
});

test('creates and pins replacements before removing existing pinned tabs', async () => {
  const creation = deferred();
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
  await new Promise((resolve) => setImmediate(resolve));
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
    (error) => error.message.includes(failedUrl) && error.cause?.cause?.message === 'creation failed',
  );
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
