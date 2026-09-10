import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BrowserTabSetStorage,
  InMemoryTabSetStorage,
  TabSetRepository,
} from '../src/tab-set-repository.mjs';
import {
  BrowserWindowSessionStorage,
  InMemoryWindowSessionStorage,
  WindowSessionRepository,
} from '../src/window-session-repository.mjs';


function createStorageArea(initialState = {}) {
  const state = structuredClone(initialState);
  return {
    state,
    async get(keys) {
      await new Promise((resolve) => setImmediate(resolve));
      if (keys === null) return structuredClone(state);
      if (!(keys in state)) return {};
      return { [keys]: structuredClone(state[keys]) };
    },
    async set(values) {
      await new Promise((resolve) => setImmediate(resolve));
      Object.assign(state, structuredClone(values));
    },
    async remove(key) {
      delete state[key];
    },
  };
}

function isValidImport(sets) {
  return sets !== null
    && typeof sets === 'object'
    && !Array.isArray(sets)
    && Object.values(sets).every((set) => (
      set !== null
      && typeof set === 'object'
      && typeof set.set_name === 'string'
      && (set.autoload === 0 || set.autoload === 1)
      && Array.isArray(set.tabs)
      && set.tabs.every((url) => typeof url === 'string')
    ));
}

const firstSet = {
  set_name: 'First',
  autoload: 0,
  tabs: ['https://first.example/'],
};
const secondSet = {
  set_name: 'Second',
  autoload: 1,
  tabs: ['https://second.example/'],
};

const adapterFactories = [
  {
    name: 'browser storage',
    create() {
      const syncStorage = createStorageArea();
      const localStorage = createStorageArea();
      const windowSessions = new WindowSessionRepository(
        new BrowserWindowSessionStorage(localStorage),
      );
      const tabSets = new TabSetRepository(
        new BrowserTabSetStorage(syncStorage),
        { validateImport: isValidImport, windowSessions },
      );
      return { tabSets, windowSessions, syncStorage, localStorage };
    },
  },
  {
    name: 'memory',
    create() {
      const windowSessions = new WindowSessionRepository(
        new InMemoryWindowSessionStorage(),
      );
      const tabSets = new TabSetRepository(
        new InMemoryTabSetStorage(),
        { validateImport: isValidImport, windowSessions },
      );
      return { tabSets, windowSessions };
    },
  },
];

for (const adapter of adapterFactories) {
  test(`${adapter.name} tab-set repository satisfies the persistence contract`, async () => {
    const { tabSets } = adapter.create();

    assert.equal(await tabSets.get('missing'), null);
    await Promise.all([
      tabSets.save('first', firstSet),
      tabSets.save('second', secondSet),
    ]);
    assert.deepEqual(await tabSets.get('first'), firstSet);
    assert.deepEqual(await tabSets.list(), { first: firstSet, second: secondSet });

    const updatedFirst = { ...firstSet, tabs: ['https://updated.example/'] };
    await tabSets.save('first', updatedFirst);
    await tabSets.setAutoload('first');
    assert.deepEqual(await tabSets.export(), {
      first: { ...updatedFirst, autoload: 1 },
      second: { ...secondSet, autoload: 0 },
    });
  });

  test(`${adapter.name} window-session repository preserves concurrent window updates`, async () => {
    const { windowSessions } = adapter.create();

    assert.equal(await windowSessions.get(999), null);
    await Promise.all([
      windowSessions.set(1, 'first'),
      windowSessions.set(2, 'second'),
    ]);
    assert.equal(await windowSessions.get(1), 'first');
    assert.equal(await windowSessions.get(2), 'second');

    await windowSessions.clearClosedWindow(1);
    assert.equal(await windowSessions.get(1), null);
    assert.equal(await windowSessions.get(2), 'second');
    await windowSessions.clearAll();
    assert.equal(await windowSessions.get(2), null);
  });

  test(`${adapter.name} tab-set deletion cleans every dangling window session`, async () => {
    const { tabSets, windowSessions } = adapter.create();
    await tabSets.save('first', firstSet);
    await Promise.all([
      windowSessions.set(1, 'first'),
      windowSessions.set(2, 'second'),
      windowSessions.set(3, 'first'),
    ]);

    await tabSets.remove('first');

    assert.equal(await tabSets.get('first'), null);
    assert.equal(await windowSessions.get(1), null);
    assert.equal(await windowSessions.get(2), 'second');
    assert.equal(await windowSessions.get(3), null);
  });

  test(`${adapter.name} tab-set import rejects invalid records without changing state`, async () => {
    const { tabSets } = adapter.create();
    await tabSets.save('first', firstSet);

    await assert.rejects(
      tabSets.import({ invalid: { set_name: 'Invalid', autoload: 3, tabs: [] } }),
      /Failed to import tab set "import payload"/,
    );
    assert.deepEqual(await tabSets.list(), { first: firstSet });

    await tabSets.import({ second: secondSet });
    assert.deepEqual(await tabSets.list(), { first: firstSet, second: secondSet });
  });
}

test('browser window-session repositories coordinate concurrent extension contexts', async () => {
  const localStorage = createStorageArea();
  const popupSessions = new WindowSessionRepository(
    new BrowserWindowSessionStorage(localStorage),
  );
  const workerSessions = new WindowSessionRepository(
    new BrowserWindowSessionStorage(localStorage),
  );

  await Promise.all([
    popupSessions.set(1, 'first'),
    workerSessions.set(2, 'second'),
  ]);

  assert.deepEqual(localStorage.state, {
    activeTabs: { 1: 'first', 2: 'second' },
  });
});

for (const Storage of [BrowserTabSetStorage, InMemoryTabSetStorage]) {
  test(`${Storage.name} contextualizes validator failures`, async () => {
    const validationFailure = new Error('validator unavailable');
    const validateImport = () => {
      throw validationFailure;
    };
    const storage = Storage === BrowserTabSetStorage
      ? new Storage(createStorageArea())
      : new Storage();
    const repository = new TabSetRepository(storage, { validateImport });

    await assert.rejects(
      repository.import({ first: firstSet }),
      /Failed to import tab set "import payload": validator unavailable/,
    );
  });
}

test('browser adapters preserve the existing storage format', async () => {
  const { tabSets, windowSessions, syncStorage, localStorage } = adapterFactories[0].create();

  await tabSets.save('first', firstSet);
  await windowSessions.set(42, 'first');

  assert.deepEqual(syncStorage.state, { first: firstSet });
  assert.deepEqual(localStorage.state, { activeTabs: { 42: 'first' } });
});

test('browser adapter errors identify the operation and record', async () => {
  const failure = new Error('storage unavailable');
  const failingStorage = {
    async get() { throw failure; },
    async set() { throw failure; },
    async remove() { throw failure; },
  };
  const tabSets = new TabSetRepository(new BrowserTabSetStorage(failingStorage));
  const windowSessions = new WindowSessionRepository(
    new BrowserWindowSessionStorage(failingStorage),
  );

  await assert.rejects(tabSets.get('saved'), /Failed to get tab set "saved"/);
  await assert.rejects(tabSets.save('saved', firstSet), /Failed to save tab set "saved"/);
  await assert.rejects(windowSessions.get(42), /Failed to get window session for window "42"/);
  await assert.rejects(windowSessions.set(42, 'saved'), /Failed to set window session for window "42"/);
});
