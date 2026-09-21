import assert from 'node:assert/strict';
import test from 'node:test';

import { createBrowserRepositories } from '../.extension-build/storage/browser-repositories.js';
import { TabSetRepository } from '../.extension-build/tab-sets/tab-set-repository.js';
import {
  BrowserTabSetStorage,
  InMemoryTabSetStorage,
} from '../.extension-build/tab-sets/tab-set-storage.js';
import {
  BrowserReferenceStorage,
  BrowserStorageMigration,
  InMemoryReferenceStorage,
  LOCAL_DOCUMENT_KEY,
  SYNC_DOCUMENT_KEY,
} from '../.extension-build/storage/storage-schema.js';
import {
  SYNC_CHUNK_PAYLOAD_BYTES,
  SYNC_INDEX_KEY,
} from '../.extension-build/storage/sync-document-storage.js';
import {
  BrowserWindowSessionStorage,
  InMemoryWindowSessionStorage,
  WindowSessionRepository,
} from '../.extension-build/storage/window-session-repository.js';

const FIRST_ID = '00000000-0000-4000-8000-000000000001';
const SECOND_ID = '00000000-0000-4000-8000-000000000002';
const THIRD_ID = '00000000-0000-4000-8000-000000000003';

function idGenerator(start = 1) {
  let next = start;
  return () => `00000000-0000-4000-8000-${String(next++).padStart(12, '0')}`;
}

function createStorageArea(initialState = {}, failSetAt = null) {
  const state = structuredClone(initialState);
  let setCalls = 0;
  let failingSetCall = failSetAt;
  return {
    state,
    async get(keys) {
      if (keys === null) return structuredClone(state);
      if (Array.isArray(keys)) {
        return Object.fromEntries(keys.filter((key) => key in state).map((key) => [key, structuredClone(state[key])]));
      }
      return keys in state ? { [keys]: structuredClone(state[keys]) } : {};
    },
    async set(values) {
      setCalls += 1;
      if (setCalls === failingSetCall) {
        throw this.failure ?? new Error('injected storage interruption');
      }
      Object.assign(state, structuredClone(values));
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete state[key];
    },
    failNextSet(error = new Error('injected storage interruption')) {
      this.failure = error;
      failingSetCall = setCalls + 1;
    },
  };
}

function activeSyncDocument(storage) {
  const index = storage.state[SYNC_INDEX_KEY];
  return JSON.parse(index.chunks.map((key) => storage.state[key]).join(''));
}

function isValidImport(document) {
  if (!document || typeof document !== 'object' || Array.isArray(document)) return false;
  if (document.version === 2) {
    return Array.isArray(document.sets)
      && document.sets.every((set) => typeof set.id === 'string'
        && typeof set.name === 'string'
        && Array.isArray(set.tabs))
      && typeof document.autoload?.scope === 'string'
      && Array.isArray(document.autoload?.setIds);
  }
  const sets = document.version === 1 ? document.sets : document;
  return sets && Object.values(sets).every((set) => (
    set && typeof set.set_name === 'string'
    && (set.autoload === 0 || set.autoload === 1)
    && Array.isArray(set.tabs)
  ));
}

function createBrowserHarness({ sync = {}, local = {}, createId = idGenerator() } = {}) {
  const syncStorage = createStorageArea(sync);
  const localStorage = createStorageArea(local);
  const migration = new BrowserStorageMigration(syncStorage, localStorage, { createId });
  const references = new BrowserReferenceStorage(localStorage, migration);
  const windowSessions = new WindowSessionRepository(new BrowserWindowSessionStorage(references));
  const tabSets = new TabSetRepository(
    new BrowserTabSetStorage(syncStorage, migration),
    {
      createId,
      validateImport: isValidImport,
      windowSessions,
    },
  );
  return { tabSets, windowSessions, syncStorage, localStorage };
}

function createMemoryHarness(createId = idGenerator()) {
  const references = new InMemoryReferenceStorage();
  const windowSessions = new WindowSessionRepository(new InMemoryWindowSessionStorage(references));
  const tabSets = new TabSetRepository(new InMemoryTabSetStorage(), {
    createId,
    validateImport: isValidImport,
    windowSessions,
  });
  return { tabSets, windowSessions };
}


test('browser storage rejects incomplete persisted tab sets', async () => {
  const storage = createStorageArea({
    [SYNC_DOCUMENT_KEY]: {
      version: 2,
      sets: { [FIRST_ID]: { id: FIRST_ID } },
      autoload: { scope: 'first-window', setIds: [] },
      deletedSetIds: [],
    },
  });

  await assert.rejects(
    new BrowserTabSetStorage(storage).list(),
    /Stored tab set document is invalid/,
  );
});

test('current schema documents recover missing optional fields', async () => {
  const savedSet = {
    id: FIRST_ID,
    name: 'Recovered',
    tabs: ['https://recovered.example/'],
  };
  const harness = createBrowserHarness({
    sync: {
      [SYNC_DOCUMENT_KEY]: {
        version: 2,
        sets: { [FIRST_ID]: savedSet },
      },
    },
    local: {
      [LOCAL_DOCUMENT_KEY]: {
        version: 2,
      },
    },
  });

  assert.deepEqual(await harness.tabSets.list(), [savedSet]);
  const migrated = activeSyncDocument(harness.syncStorage);
  assert.deepEqual(
    migrated.autoload,
    { scope: 'first-window', setIds: [] },
  );
  assert.deepEqual(migrated.deletedSetIds, []);
});

for (const [name, createHarness] of [
  ['browser', createBrowserHarness],
  ['memory', createMemoryHarness],
]) {
  test(`${name} repository uses immutable UUID identity across rename and title reuse`, async () => {
    const { tabSets } = createHarness();
    const first = await tabSets.save({ name: '同じ名前', tabs: ['https://first.example/'] });
    const collision = await tabSets.save({ name: '同じ名前', tabs: ['https://second.example/'] });

    assert.equal(first.id, FIRST_ID);
    assert.equal(collision.id, SECOND_ID);
    assert.notEqual(first.id, collision.id);

    const renamed = await tabSets.save({ ...first, name: 'Renamed 🚀' });
    assert.equal(renamed.id, first.id);
    assert.equal((await tabSets.get(first.id)).name, 'Renamed 🚀');

    await tabSets.remove(first.id);
    const reusedTitle = await tabSets.save({ name: '同じ名前', tabs: [] });
    assert.equal(reusedTitle.id, THIRD_ID);
    await assert.rejects(
      tabSets.save({ ...first, name: 'Cannot resurrect' }),
      /does not exist and cannot be reused/,
    );
  });

  test(`${name} deletion clears Autoload and session references`, async () => {
    const { tabSets, windowSessions } = createHarness();
    const first = await tabSets.save({ name: 'First', tabs: [] });
    const second = await tabSets.save({ name: 'Second', tabs: [] });
    await tabSets.setAutoload({ scope: 'every-window', setIds: [first.id] });
    await windowSessions.set(1, first.id);
    await windowSessions.set(2, second.id);

    await tabSets.remove(first.id);

    assert.deepEqual(await tabSets.getAutoload(), { scope: 'every-window', setIds: [] });
    assert.equal(await windowSessions.get(1), null);
    assert.equal(await windowSessions.get(2), second.id);
  });

  test(`${name} versioned import remaps collisions and export round-trips domain records`, async () => {
    const { tabSets } = createHarness();
    const existing = await tabSets.save({ name: 'Existing', tabs: [] });
    const imported = await tabSets.import({
      version: 2,
      sets: [
        { id: existing.id, name: 'Collision', tabs: ['https://collision.example/'] },
        { id: SECOND_ID, name: 'Unicode 日本語', tabs: [] },
      ],
      autoload: { scope: 'every-window', setIds: [existing.id] },
    });

    assert.deepEqual(imported.map((set) => set.id), [SECOND_ID, THIRD_ID]);
    assert.deepEqual(await tabSets.getAutoload(), {
      scope: 'every-window',
      setIds: [SECOND_ID],
    });
    const exported = await tabSets.export();
    assert.equal(exported.version, 2);
    assert.deepEqual(exported.sets.map((set) => set.name), ['Existing', 'Collision', 'Unicode 日本語']);
  });

  test(`${name} accepts legacy exports and rejects unsupported documents actionably`, async () => {
    const { tabSets } = createHarness();
    const imported = await tabSets.import({
      bGVnYWN5: { set_name: 'Legacy', autoload: 1, tabs: ['https://legacy.example/'] },
    });

    assert.equal(imported[0].name, 'Legacy');
    assert.deepEqual((await tabSets.getAutoload()).setIds, [imported[0].id]);
    await assert.rejects(
      tabSets.import({ version: 99, sets: [] }),
      /Unsupported tab-set document version "99"\. Supported versions are 1 and 2/,
    );
  });
}

test('legacy browser profile migrates once with valid references and no mixed schema', async () => {
  const harness = createBrowserHarness({
    sync: {
      'Rmlyc3Q=': { set_name: 'First', autoload: 1, tabs: ['https://first.example/'] },
      U2Vjb25k: { set_name: 'Second', autoload: 1, tabs: ['https://second.example/'] },
      '5pel5pys6Kqe': { set_name: '日本語', autoload: 0, tabs: ['https://unicode.example/'] },
      unrelated: { preference: true },
      unrelatedSetShape: { set_name: 'Preference', autoload: 0, tabs: [] },
    },
    local: {
      activeTabs: { 1: 'Rmlyc3Q=', 2: 'missing' },
      shortcutSets: { 'load-set-1': 'U2Vjb25k', 'load-set-2': 'missing' },
      unrelated: 'keep',
    },
  });

  const sets = await harness.tabSets.list();
  assert.deepEqual(sets.map((set) => set.name), ['First', 'Second', '日本語']);
  assert.deepEqual(await harness.tabSets.getAutoload(), {
    scope: 'first-window',
    setIds: [sets[0].id],
  });
  assert.equal(await harness.windowSessions.get(1), sets[0].id);
  assert.equal(await harness.windowSessions.get(2), null);
  assert.equal(Object.keys(activeSyncDocument(harness.syncStorage).migration.legacyIds).length, 3);
  assert.equal(SYNC_INDEX_KEY in harness.syncStorage.state, true);
  assert.deepEqual(Object.keys(harness.localStorage.state).sort(), [LOCAL_DOCUMENT_KEY, 'unrelated']);
  assert.equal(SYNC_DOCUMENT_KEY in harness.syncStorage.state, false);

  const ids = sets.map((set) => set.id);
  assert.deepEqual((await harness.tabSets.list()).map((set) => set.id), ids);
});

test('versioned import maps duplicate source ids to the last imported set', async () => {
  const { tabSets } = createMemoryHarness();
  const imported = await tabSets.import({
    version: 2,
    sets: [
      { id: FIRST_ID, name: 'First', tabs: [] },
      { id: FIRST_ID, name: 'Duplicate', tabs: [] },
    ],
    autoload: { scope: 'first-window', setIds: [FIRST_ID] },
  });

  assert.deepEqual(imported.map((set) => set.id), [FIRST_ID, SECOND_ID]);
  assert.deepEqual(
    (await tabSets.getAutoload()).setIds,
    [SECOND_ID],
  );
});

test('saveForWindow rolls back new and updated records when session activation fails', async () => {
  const generatedIds = [FIRST_ID, FIRST_ID, SECOND_ID];
  const harness = createBrowserHarness({ createId: () => generatedIds.shift() });
  await harness.tabSets.list();
  harness.localStorage.failNextSet();

  await assert.rejects(
    harness.tabSets.saveForWindow({ name: 'New', tabs: [] }, 1),
    /injected storage interruption/,
  );
  assert.deepEqual(await harness.tabSets.list(), []);

  const saved = await harness.tabSets.save({ name: 'Existing', tabs: ['before'] });
  assert.equal(saved.id, SECOND_ID);
  harness.localStorage.failNextSet();
  await assert.rejects(
    harness.tabSets.saveForWindow({ ...saved, name: 'Updated', tabs: ['after'] }, 1),
    /injected storage interruption/,
  );

  assert.deepEqual(await harness.tabSets.get(saved.id), saved);
  assert.deepEqual((await harness.tabSets.list()).map((set) => set.id), [SECOND_ID]);
});

test('memory rollback retains failed UUID identity in its ledger', async () => {
  const generatedIds = [FIRST_ID, FIRST_ID, SECOND_ID];
  const tabSets = new TabSetRepository(new InMemoryTabSetStorage(), {
    createId: () => generatedIds.shift(),
    windowSessions: {
      async set() {
        throw new Error('session unavailable');
      },
    },
  });

  await assert.rejects(
    tabSets.saveForWindow({ name: 'Failed', tabs: [] }, 1),
    /session unavailable/,
  );
  const saved = await tabSets.save({ name: 'Next', tabs: [] });

  assert.equal(saved.id, SECOND_ID);
  assert.equal(await tabSets.get(FIRST_ID), null);
});

test('interrupted migration resumes idempotently from its persisted identity map', async () => {
  const syncStorage = createStorageArea({
    TGVnYWN5: { set_name: 'Legacy', autoload: 1, tabs: [] },
  });
  const localStorage = createStorageArea({ activeTabs: { 7: 'TGVnYWN5' } }, 1);
  const migration = new BrowserStorageMigration(syncStorage, localStorage, { createId: idGenerator() });

  await assert.rejects(migration.ensureMigrated(), /injected storage interruption/);
  assert.equal('TGVnYWN5' in syncStorage.state, true);
  await migration.ensureMigrated();

  const migrated = activeSyncDocument(syncStorage);
  const stagedId = Object.keys(migrated.sets)[0];
  assert.equal(localStorage.state[LOCAL_DOCUMENT_KEY].windowSessions[7], stagedId);
  assert.equal(migrated.migration.legacyIds.TGVnYWN5, stagedId);
  assert.equal('TGVnYWN5' in syncStorage.state, false);
  assert.equal('activeTabs' in localStorage.state, false);
});

test('large UTF-8 documents use bounded chunks and remain readable', async () => {
  const harness = createBrowserHarness();
  const tabs = Array.from(
    { length: 120 },
    (_, index) => `https://例え.example/${index}/🚀/${'路'.repeat(20)}`,
  );

  const saved = await harness.tabSets.save({
    name: `日本語 ${'界'.repeat(100)}`,
    tabs,
  });

  assert.deepEqual(await harness.tabSets.get(saved.id), saved);
  const index = harness.syncStorage.state[SYNC_INDEX_KEY];
  assert.ok(index.chunks.length > 1);
  for (const key of index.chunks) {
    assert.ok(
      new TextEncoder().encode(
        JSON.stringify(harness.syncStorage.state[key]),
      ).byteLength <= SYNC_CHUNK_PAYLOAD_BYTES,
    );
  }
});

test('mixed version-two and late legacy records recover their union', async () => {
  const existing = {
    id: FIRST_ID,
    name: 'Existing',
    tabs: ['https://existing.example/'],
  };
  const harness = createBrowserHarness({
    sync: {
      [SYNC_DOCUMENT_KEY]: {
        version: 2,
        sets: { [FIRST_ID]: existing },
        autoload: { scope: 'every-window', setIds: [FIRST_ID] },
        deletedSetIds: [],
      },
      'RXhpc3Rpbmc=': {
        set_name: 'Existing',
        tabs: ['https://late.example/'],
        autoload: 0,
      },
    },
  });

  assert.deepEqual(
    (await harness.tabSets.list()).map(({ name }) => name),
    ['Existing', 'Existing (2)'],
  );
  assert.equal(SYNC_DOCUMENT_KEY in harness.syncStorage.state, false);
  assert.equal('RXhpc3Rpbmc=' in harness.syncStorage.state, false);
});

test('failed import preserves the active generation and reports total quota', async () => {
  const harness = createBrowserHarness();
  await harness.tabSets.save({ name: 'Before', tabs: ['https://before.example/'] });
  const previousIndex = structuredClone(harness.syncStorage.state[SYNC_INDEX_KEY]);
  harness.syncStorage.failNextSet(
    new Error('QUOTA_BYTES quota exceeded: total synchronized storage'),
  );

  await assert.rejects(
    harness.tabSets.import({
      version: 2,
      sets: [{ id: SECOND_ID, name: 'After', tabs: ['https://after.example/'] }],
      autoload: { scope: 'first-window', setIds: [] },
    }),
    /Synchronized storage is full/,
  );

  assert.deepEqual(harness.syncStorage.state[SYNC_INDEX_KEY], previousIndex);
  assert.deepEqual(
    (await harness.tabSets.list()).map(({ name }) => name),
    ['Before'],
  );
});
