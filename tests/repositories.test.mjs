import assert from 'node:assert/strict';
import test from 'node:test';

import { createBrowserRepositories } from '../.extension-build/storage/browser-repositories.js';
import { TabSetRepository } from '../.extension-build/tab-sets/tab-set-repository.js';
import {
  BrowserTabSetStorage,
  InMemoryTabSetStorage,
} from '../.extension-build/tab-sets/tab-set-storage.js';
import { BrowserStorageMigration } from '../.extension-build/storage/browser-storage-migration.js';
import {
  BrowserReferenceStorage,
  InMemoryReferenceStorage,
  LOCAL_DOCUMENT_KEY,
  SYNC_DOCUMENT_KEY,
} from '../.extension-build/storage/storage-schema.js';
import {
  SyncDocumentStorage,
  SYNC_CHUNK_PAYLOAD_BYTES,
  SYNC_CHUNK_PREFIX,
  SYNC_COMMITTED_CACHE_KEY,
  SYNC_INDEX_KEY,
  SYNC_RECOVERY_KEY,
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

function storageBytes(values) {
  return Object.entries(values).reduce(
    (total, [key, value]) =>
      total + new TextEncoder().encode(key + JSON.stringify(value)).byteLength,
    0,
  );
}

function createStorageArea(initialState = {}, failSetAt = null, maxBytes = Infinity) {
  const state = structuredClone(initialState);
  const calls = { get: 0, set: 0, remove: 0 };
  let failingSetKey = null;
  let failingSetCall = failSetAt;
  let failingRemoveCall = null;
  function storageBytes(values) {
    return Object.entries(values).reduce(
      (total, [key, value]) =>
        total + new TextEncoder().encode(key + JSON.stringify(value)).byteLength,
      0,
    );
  }
  return {
    calls,
    state,
    async get(keys) {
      calls.get += 1;
      if (keys === null) return structuredClone(state);
      if (Array.isArray(keys)) {
        return Object.fromEntries(keys.filter((key) => key in state).map((key) => [key, structuredClone(state[key])]));
      }
      return keys in state ? { [keys]: structuredClone(state[keys]) } : {};
    },
    async set(values) {
      calls.set += 1;
      if (calls.set === failingSetCall
        || (failingSetKey && failingSetKey in values)) {
        failingSetKey = null;
        throw this.failure ?? new Error('injected storage interruption');
      }
      const nextState = { ...state, ...structuredClone(values) };
      if (storageBytes(nextState) > maxBytes) {
        throw new Error('Resource::kQuotaBytes quota exceeded');
      }
      Object.assign(state, structuredClone(values));
    },
    async remove(keys) {
      calls.remove += 1;
      if (calls.remove === failingRemoveCall) {
        throw this.failure ?? new Error('injected storage interruption');
      }
      for (const key of Array.isArray(keys) ? keys : [keys]) delete state[key];
    },
    failSetIn(offset, error = new Error('injected storage interruption')) {
      this.failure = error;
      failingSetCall = calls.set + offset;
    },
    failNextSet(error = new Error('injected storage interruption')) {
      this.failSetIn(1, error);
    },
    failNextSetForKey(key, error = new Error('injected storage interruption')) {
      this.failure = error;
      failingSetKey = key;
    },
    failNextRemove(error = new Error('injected storage interruption')) {
      this.failure = error;
      failingRemoveCall = calls.remove + 1;
    },
  };
}

function activeSyncDocument(storage) {
  const index = storage.state[SYNC_INDEX_KEY];
  return JSON.parse(index.chunks.map((key) => storage.state[key]).join(''));
}

function synchronizedStorageBytes(values) {
  return Object.entries(values).reduce(
    (total, [key, value]) =>
      total + new TextEncoder().encode(key + JSON.stringify(value)).byteLength,
    0,
  );
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
    new BrowserTabSetStorage(syncStorage, migration, localStorage),
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

test('version-two documents upgrade while recovering optional fields', async () => {
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
  assert.equal(migrated.version, 3);
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
  const ids = sets.map((set) => set.id);
  assert.deepEqual(sets.map((set) => set.name), ['First', 'Second', '日本語']);
  assert.deepEqual(await harness.tabSets.getAutoload(), {
    scope: 'first-window',
    setIds: [sets[0].id],
  });
  assert.equal(await harness.windowSessions.get(1), sets[0].id);
  assert.equal(await harness.windowSessions.get(2), null);
  assert.equal(Object.keys(activeSyncDocument(harness.syncStorage).migration.legacyIds).length, 3);
  assert.equal(SYNC_INDEX_KEY in harness.syncStorage.state, true);
  assert.deepEqual(
    Object.keys(harness.localStorage.state).sort(),
    [LOCAL_DOCUMENT_KEY, SYNC_COMMITTED_CACHE_KEY, 'unrelated'].sort(),
  );
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
  harness.localStorage.failNextSetForKey(LOCAL_DOCUMENT_KEY);

  await assert.rejects(
    harness.tabSets.saveForWindow({ name: 'New', tabs: [] }, 1),
    /injected storage interruption/,
  );
  assert.deepEqual(await harness.tabSets.list(), []);

  const saved = await harness.tabSets.save({ name: 'Existing', tabs: ['before'] });
  assert.equal(saved.id, SECOND_ID);
  harness.localStorage.failNextSetForKey(LOCAL_DOCUMENT_KEY);
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
  assert.equal(migrated.migration, undefined);
  assert.equal('TGVnYWN5' in syncStorage.state, false);
  assert.equal('activeTabs' in localStorage.state, false);
});

test('deterministic migration retires metadata without duplicating a late legacy record', async () => {
  const legacyKey = 'TGVnYWN5';
  const legacySet = {
    set_name: 'Legacy',
    autoload: 0,
    tabs: ['https://legacy.example/'],
  };
  const syncStorage = createStorageArea({ [legacyKey]: legacySet });
  const localStorage = createStorageArea();

  await new BrowserStorageMigration(syncStorage, localStorage).ensureMigrated();
  const firstDocument = activeSyncDocument(syncStorage);
  assert.equal(firstDocument.version, 3);
  const firstId = Object.keys(firstDocument.sets)[0];
  assert.equal(firstId, '7dcf521f-5d09-556b-ba7b-b190087e0182');
  assert.equal(firstDocument.migration, undefined);

  await syncStorage.set({ [legacyKey]: legacySet });
  await new BrowserStorageMigration(syncStorage, localStorage).ensureMigrated();

  const recovered = activeSyncDocument(syncStorage);
  assert.deepEqual(Object.keys(recovered.sets), [firstId]);
  assert.equal(recovered.migration, undefined);
});


test('legacy metadata prefers its mapped exact set over another exact match', async () => {
  const legacyKey = 'TGVnYWN5';
  const localStorage = createStorageArea({
    activeTabs: { 7: legacyKey },
  });
  const duplicatedValue = {
    name: 'Legacy',
    tabs: ['https://legacy.example/'],
  };
  const syncStorage = createStorageArea({
    [SYNC_DOCUMENT_KEY]: {
      version: 2,
      sets: {
        [FIRST_ID]: { id: FIRST_ID, ...duplicatedValue },
        [SECOND_ID]: { id: SECOND_ID, ...duplicatedValue },
      },
      autoload: { scope: 'first-window', setIds: [] },
      deletedSetIds: [],
      migration: { legacyIds: { [legacyKey]: SECOND_ID } },
    },
    [legacyKey]: {
      set_name: duplicatedValue.name,
      tabs: duplicatedValue.tabs,
      autoload: 0,
    },
  });

  await new BrowserStorageMigration(
    syncStorage,
    localStorage,
    { createId: idGenerator(3) },
  ).ensureMigrated();

  assert.deepEqual(
    Object.keys(activeSyncDocument(syncStorage).sets),
    [FIRST_ID, SECOND_ID],
  );
  assert.equal(
    localStorage.state[LOCAL_DOCUMENT_KEY].windowSessions[7],
    SECOND_ID,
  );
  assert.equal(
    activeSyncDocument(syncStorage).migration.legacyIds[legacyKey],
    SECOND_ID,
  );
});

test('version-two exact match preserves legacy local references without ID inference', async () => {
  const legacyKey = 'TGVnYWN5';
  const legacyValue = {
    set_name: 'Legacy',
    tabs: ['https://legacy.example/'],
    autoload: 0,
  };
  const syncStorage = createStorageArea({
    [SYNC_DOCUMENT_KEY]: {
      version: 2,
      sets: {
        [FIRST_ID]: {
          id: FIRST_ID,
          name: legacyValue.set_name,
          tabs: legacyValue.tabs,
        },
      },
      autoload: { scope: 'first-window', setIds: [] },
      deletedSetIds: [],
    },
    [legacyKey]: legacyValue,
  });
  const localStorage = createStorageArea({
    activeTabs: { 7: legacyKey },
  });

  await new BrowserStorageMigration(
    syncStorage,
    localStorage,
  ).ensureMigrated();

  assert.equal(
    localStorage.state[LOCAL_DOCUMENT_KEY].windowSessions[7],
    FIRST_ID,
  );
  assert.equal(
    activeSyncDocument(syncStorage).migration.legacyIds[legacyKey],
    FIRST_ID,
  );
});
test('version-three exact match preserves local references without metadata', async () => {
  const legacyKey = 'TGVnYWN5';
  const legacyValue = {
    set_name: 'Legacy',
    tabs: ['https://legacy.example/'],
    autoload: 0,
  };
  const syncStorage = createStorageArea({
    [SYNC_DOCUMENT_KEY]: {
      version: 3,
      sets: {
        [FIRST_ID]: {
          id: FIRST_ID,
          name: legacyValue.set_name,
          tabs: legacyValue.tabs,
        },
      },
      autoload: { scope: 'first-window', setIds: [] },
      deletedSetIds: [],
    },
    [legacyKey]: legacyValue,
  });
  const localStorage = createStorageArea({
    activeTabs: { 7: legacyKey },
  });

  await new BrowserStorageMigration(
    syncStorage,
    localStorage,
  ).ensureMigrated();

  assert.equal(
    localStorage.state[LOCAL_DOCUMENT_KEY].windowSessions[7],
    FIRST_ID,
  );
  assert.equal(activeSyncDocument(syncStorage).migration, undefined);
});


test('version-three generation reads an explicit version-two document', async () => {
  const document = {
    version: 2,
    sets: {
      [FIRST_ID]: {
        id: FIRST_ID,
        name: 'Version three',
        tabs: ['https://version-three.example/'],
      },
    },
    autoload: { scope: 'first-window', setIds: [] },
    deletedSetIds: [],
  };
  const chunkKey = 'savePinnedTabs:generation:legacy:chunk:0';
  const storage = createStorageArea({
    'savePinnedTabs:index': {
      version: 3,
      generation: 'legacy',
      chunks: [chunkKey],
    },
    [chunkKey]: JSON.stringify(document),
  });

  assert.deepEqual(
    await new SyncDocumentStorage(storage).read(),
    { ...document, version: 3 },
  );
});

test('migrated quota fixture materially reduces aggregate synchronized bytes', async () => {
  const legacyEntries = Object.fromEntries(
    Array.from({ length: 142 }, (_, index) => {
      const name = `Legacy set ${index}`;
      return [
        btoa(name),
        {
          set_name: name,
          autoload: 0,
          tabs: [`https://example.com/${index}/${'segment'.repeat(40)}`],
        },
      ];
    }),
  );
  const quotaBytes = 70_000;
  const syncStorage = createStorageArea(legacyEntries, null, quotaBytes);

  await new BrowserStorageMigration(
    syncStorage,
    createStorageArea(),
  ).ensureMigrated();

  const migratedDocument = activeSyncDocument(syncStorage);
  const legacyIds = Object.fromEntries(
    Object.keys(legacyEntries).map((legacyKey, index) => [
      legacyKey,
      Object.keys(migratedDocument.sets)[index],
    ]),
  );
  const previousDocument = {
    ...migratedDocument,
    migration: { legacyIds },
  };
  const serializedPrevious = JSON.stringify(previousDocument);
  const previousGeneration = `migrate-${'0'.repeat(36)}`;
  const previousChunks = serializedPrevious.match(/.{1,6142}/gu) ?? [''];
  const previousChunkKeys = previousChunks.map(
    (_, index) =>
      `${SYNC_CHUNK_PREFIX}${previousGeneration}:chunk:${index}`,
  );
  const previousStorage = {
    [SYNC_INDEX_KEY]: {
      version: 3,
      generation: previousGeneration,
      chunks: previousChunkKeys,
    },
    ...Object.fromEntries(
      previousChunkKeys.map((key, index) => [key, previousChunks[index]]),
    ),
  };
  const previousBytes = synchronizedStorageBytes(previousStorage);
  const migratedBytes = synchronizedStorageBytes(syncStorage.state);
  assert.ok(
    previousBytes > quotaBytes,
    `expected previous format ${previousBytes} to exceed quota ${quotaBytes}`,
  );
  assert.ok(
    migratedBytes <= quotaBytes,
    `expected migrated format ${migratedBytes} to fit quota ${quotaBytes}`,
  );

  assert.ok(
    migratedBytes < previousBytes * 0.9,
    `expected migrated bytes ${migratedBytes} to improve at least 10% on ${previousBytes}`,
  );
  assert.equal(migratedDocument.migration, undefined);
});

test('interrupted quota migration resumes from local staging after reclaiming sync space', async () => {
  const legacyKey = 'TGVnYWN5';
  const syncStorage = createStorageArea({
    [legacyKey]: { set_name: 'Legacy', autoload: 0, tabs: ['https://example.com/'] },
  });
  const localStorage = createStorageArea({
    activeTabs: { 7: legacyKey },
  });
  const migration = new BrowserStorageMigration(
    syncStorage,
    localStorage,
    { createId: idGenerator() },
  );
  syncStorage.failNextSet();

  await assert.rejects(migration.ensureMigrated(), /injected storage interruption/);
  assert.equal(legacyKey in syncStorage.state, false);
  assert.equal(
    'savePinnedTabs:migration-local-staging' in localStorage.state,
    true,
  );

  await migration.ensureMigrated();

  assert.deepEqual(
    Object.values(activeSyncDocument(syncStorage).sets).map(({ name }) => name),
    ['Legacy'],
  );
  const migratedId = Object.keys(activeSyncDocument(syncStorage).sets)[0];
  assert.equal(
    localStorage.state[LOCAL_DOCUMENT_KEY].windowSessions[7],
    migratedId,
  );
});

test('staged migration removes chunks left before an interrupted index commit', async () => {
  const stagedDocument = {
    version: 2,
    sets: {
      [FIRST_ID]: {
        id: FIRST_ID,
        name: 'Recovered',
        tabs: ['https://example.com/'],
      },
    },
    autoload: { scope: 'first-window', setIds: [] },
    deletedSetIds: [],
  };
  const orphanedChunkKey = `${SYNC_CHUNK_PREFIX}interrupted:chunk:0`;
  const syncStorage = createStorageArea({
    [orphanedChunkKey]: JSON.stringify(stagedDocument),
  });
  const localStorage = createStorageArea({
    'savePinnedTabs:migration-staging': stagedDocument,
  });
  const migration = new BrowserStorageMigration(syncStorage, localStorage);

  await migration.ensureMigrated();

  assert.equal(orphanedChunkKey in syncStorage.state, false);
  assert.equal(activeSyncDocument(syncStorage).sets[FIRST_ID].name, 'Recovered');
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
  const previousIndex = structuredClone(
    harness.syncStorage.state[SYNC_INDEX_KEY],
  );
  harness.syncStorage.failNextSet(
    new Error('QUOTA_BYTES quota exceeded: total synchronized storage'),
  );

  await assert.rejects(
    harness.tabSets.import({
      version: 2,
      sets: [{ id: SECOND_ID, name: 'After', tabs: ['https://after.example/'] }],
      autoload: { scope: 'first-window', setIds: [] },
    }),
    /Synchronized storage for this extension is full/,
  );

  assert.deepEqual(
    harness.syncStorage.state[SYNC_INDEX_KEY],
    previousIndex,
  );
  assert.deepEqual(
    (await harness.tabSets.list()).map(({ name }) => name),
    ['Before'],
  );
});

test('popup data migration succeeds when legacy records nearly fill sync quota', async () => {
  const name = 'Quota';
  const legacyKey = btoa(name);
  const legacySet = {
    set_name: name,
    tabs: [`https://example.com/${'x'.repeat(2_000)}`],
    autoload: 0,
  };
  const syncStorage = createStorageArea(
    { [legacyKey]: legacySet },
    null,
    3_000,
  );
  const localStorage = createStorageArea();
  const migration = new BrowserStorageMigration(
    syncStorage,
    localStorage,
    { createId: idGenerator() },
  );
  const tabSets = new TabSetRepository(
    new BrowserTabSetStorage(syncStorage, migration),
  );

  const popupData = await tabSets.getPopupData();

  assert.deepEqual(
    popupData.sets.map(({ name: setName, tabs }) => ({ name: setName, tabs })),
    [{ name, tabs: legacySet.tabs }],
  );
});

test('quota-bound migration stays usable locally and promotes after reduction', async () => {
  const legacySets = Object.fromEntries(
    Array.from({ length: 260 }, (_, index) => {
      const name = `Recovered ${String(index).padStart(3, '0')}`;
      return [
        btoa(name),
        {
          set_name: name,
          tabs: [`https://example.com/${index}/${'x'.repeat(290)}`],
          autoload: 0,
        },
      ];
    }),
  );
  assert.ok(storageBytes(legacySets) < 102_400);

  const syncStorage = createStorageArea(legacySets, null, 102_400);
  const localStorage = createStorageArea();
  const firstMigration = new BrowserStorageMigration(
    syncStorage,
    localStorage,
    { createId: idGenerator() },
  );
  const firstRepository = new TabSetRepository(
    new BrowserTabSetStorage(syncStorage, firstMigration),
  );

  const firstPopupData = await firstRepository.getPopupData();

  assert.equal(firstPopupData.sets.length, 260);
  assert.equal(firstPopupData.synchronization, 'local-only');
  assert.equal(SYNC_INDEX_KEY in syncStorage.state, false);
  assert.equal('savePinnedTabs:migration-staging' in localStorage.state, true);

  const restartedMigration = new BrowserStorageMigration(syncStorage, localStorage);
  const restartedRepository = new TabSetRepository(
    new BrowserTabSetStorage(syncStorage, restartedMigration),
  );
  const restartedPopupData = await restartedRepository.getPopupData();

  assert.equal(restartedPopupData.sets.length, 260);
  assert.deepEqual(
    restartedPopupData.sets.map(({ id }) => id),
    firstPopupData.sets.map(({ id }) => id),
  );

  let promotedPopupData = restartedPopupData;
  for (const set of restartedPopupData.sets) {
    await restartedRepository.remove(set.id);
    promotedPopupData = await restartedRepository.getPopupData();
    if (promotedPopupData.synchronization === 'synchronized') break;
  }

  assert.ok(promotedPopupData.sets.length < 260);
  assert.equal(promotedPopupData.synchronization, 'synchronized');
  assert.equal(SYNC_INDEX_KEY in syncStorage.state, true);
  assert.equal('savePinnedTabs:migration-staging' in localStorage.state, false);
});

for (const quotaMessage of [
  'Resource::kQuotaBytes quota exceeded',
  'QuotaExceededError: storage.sync API call exceeded its quota limitations.',
]) {
  test(`aggregate quota spelling identifies this extension storage area: ${quotaMessage}`, async () => {
    const harness = createBrowserHarness();
    harness.syncStorage.failNextSet(new Error(quotaMessage));

    await assert.rejects(
      harness.tabSets.save({ name: 'Too large', tabs: [] }),
      /Synchronized storage for this extension is full; reduce saved tab data/,
    );
  });
}

test('version-two document migrates when it nearly fills the sync quota', async () => {
  const savedSet = {
    id: FIRST_ID,
    name: 'Version two quota',
    tabs: [`https://example.com/${'x'.repeat(2_000)}`],
  };
  const syncStorage = createStorageArea({
    [SYNC_DOCUMENT_KEY]: {
      version: 2,
      sets: { [FIRST_ID]: savedSet },
      autoload: { scope: 'first-window', setIds: [] },
      deletedSetIds: [],
    },
  }, null, 3_000);
  const localStorage = createStorageArea();
  const migration = new BrowserStorageMigration(syncStorage, localStorage);
  const tabSets = new TabSetRepository(
    new BrowserTabSetStorage(syncStorage, migration),
  );

  const popupData = await tabSets.getPopupData();

  assert.deepEqual(popupData.sets, [savedSet]);
  assert.equal(SYNC_DOCUMENT_KEY in syncStorage.state, false);
});

test('active generation and late legacy record migrate near the sync quota', async () => {
  const activeSet = {
    id: FIRST_ID,
    name: 'Current',
    tabs: ['https://current.example/'],
  };
  const activeDocument = {
    version: 2,
    sets: { [FIRST_ID]: activeSet },
    autoload: { scope: 'first-window', setIds: [] },
    deletedSetIds: [],
  };
  const activeChunkKey = `${SYNC_CHUNK_PREFIX}active:chunk:0`;
  const legacyName = 'Late legacy';
  const legacyKey = btoa(legacyName);
  const syncStorage = createStorageArea({
    [SYNC_INDEX_KEY]: {
      version: 3,
      generation: 'active',
      chunks: [activeChunkKey],
    },
    [activeChunkKey]: JSON.stringify(activeDocument),
    [legacyKey]: {
      set_name: legacyName,
      tabs: [`https://legacy.example/${'x'.repeat(2_000)}`],
      autoload: 0,
    },
  }, null, 3_000);
  const localStorage = createStorageArea({
    [LOCAL_DOCUMENT_KEY]: { version: 2, windowSessions: {} },
  });
  const migration = new BrowserStorageMigration(
    syncStorage,
    localStorage,
    { createId: idGenerator(2) },
  );
  const tabSets = new TabSetRepository(
    new BrowserTabSetStorage(syncStorage, migration),
  );

  const popupData = await tabSets.getPopupData();

  assert.deepEqual(
    popupData.sets.map(({ name }) => name),
    ['Current', 'Late legacy'],
  );
  assert.equal(legacyKey in syncStorage.state, false);
});

test('failed local staging preserves every synchronized migration source', async () => {
  const activeDocument = {
    version: 2,
    sets: {
      [FIRST_ID]: {
        id: FIRST_ID,
        name: 'Current',
        tabs: ['https://current.example/'],
      },
    },
    autoload: { scope: 'first-window', setIds: [] },
    deletedSetIds: [],
  };
  const activeChunkKey = `${SYNC_CHUNK_PREFIX}active:chunk:0`;
  const legacyKey = 'TGVnYWN5';
  const syncStorage = createStorageArea({
    [SYNC_INDEX_KEY]: {
      version: 3,
      generation: 'active',
      chunks: [activeChunkKey],
    },
    [activeChunkKey]: JSON.stringify(activeDocument),
    [legacyKey]: {
      set_name: 'Legacy',
      tabs: ['https://legacy.example/'],
      autoload: 0,
    },
  });
  const initialSyncState = structuredClone(syncStorage.state);
  const localStorage = createStorageArea({
    [LOCAL_DOCUMENT_KEY]: { version: 2, windowSessions: {} },
  }, 1);
  const migration = new BrowserStorageMigration(
    syncStorage,
    localStorage,
    { createId: idGenerator(2) },
  );

  await assert.rejects(
    migration.ensureMigrated(),
    /injected storage interruption/,
  );

  assert.deepEqual(syncStorage.state, initialSyncState);
});

test('current popup data loads without redundant synchronized storage reads', async () => {
  const document = {
    version: 2,
    sets: {},
    autoload: { scope: 'first-window', setIds: [] },
    deletedSetIds: [],
  };
  const chunkKey = `${SYNC_CHUNK_PREFIX}current:chunk:0`;
  const syncStorage = createStorageArea({
    [SYNC_INDEX_KEY]: {
      version: 3,
      generation: 'current',
      chunks: [chunkKey],
    },
    [chunkKey]: JSON.stringify(document),
  });
  const localStorage = createStorageArea({
    [LOCAL_DOCUMENT_KEY]: { version: 2, windowSessions: {} },
  });
  const migration = new BrowserStorageMigration(syncStorage, localStorage);
  const tabSets = new TabSetRepository(
    new BrowserTabSetStorage(syncStorage, migration),
  );

  await tabSets.getPopupData();

  assert.equal(syncStorage.calls.get, 3);
});

test('large synchronized documents batch quota-safe chunks into one write', async () => {
  const storage = createStorageArea();
  const documents = new SyncDocumentStorage(storage);
  const document = {
    version: 3,
    sets: {
      [FIRST_ID]: {
        id: FIRST_ID,
        name: 'Large',
        tabs: [`https://example.com/${'x'.repeat(SYNC_CHUNK_PAYLOAD_BYTES * 2)}`],
      },
    },
    autoload: { scope: 'first-window', setIds: [] },
    deletedSetIds: [],
  };

  await documents.save(document);

  assert.equal(storage.calls.set, 2);
  assert.deepEqual(await documents.read(), document);
});

test('large committed generation can be replaced without double sync quota', async () => {
  const syncStorage = createStorageArea({}, null, 16_000);
  const localStorage = createStorageArea();
  const documents = new SyncDocumentStorage(syncStorage, localStorage);
  const document = (name, character) => ({
    version: 2,
    sets: {
      [FIRST_ID]: {
        id: FIRST_ID,
        name,
        tabs: [`https://example.com/${character.repeat(12_000)}`],
      },
    },
    autoload: { scope: 'first-window', setIds: [] },
    deletedSetIds: [],
  });
  const previous = document('Before', 'a');
  const replacement = document('After', 'b');
  await documents.save(previous);

  await documents.save(replacement);

  assert.deepEqual(await documents.read(), replacement);
  assert.equal(SYNC_RECOVERY_KEY in localStorage.state, false);
  assert.equal(SYNC_COMMITTED_CACHE_KEY in localStorage.state, true);
});


test('interrupted replacements recover the last committed document after restart', async () => {
  const previous = {
    version: 2,
    sets: {
      [FIRST_ID]: {
        id: FIRST_ID,
        name: 'Before interruption',
        tabs: ['https://before.example/'],
      },
    },
    autoload: { scope: 'first-window', setIds: [] },
    deletedSetIds: [],
  };
  const replacement = {
    ...previous,
    sets: {
      [SECOND_ID]: {
        id: SECOND_ID,
        name: 'After interruption',
        tabs: ['https://after.example/'],
      },
    },
  };
  const interruptions = [
    ['local recovery staging', ({ localStorage }) => localStorage.failNextSet()],
    ['old chunk removal', ({ syncStorage }) => syncStorage.failNextRemove()],
    ['new chunk write', ({ syncStorage }) => syncStorage.failNextSet()],
    ['index switch', ({ syncStorage }) => syncStorage.failSetIn(2)],
  ];

  for (const [mutation, interrupt] of interruptions) {
    const syncStorage = createStorageArea();
    const localStorage = createStorageArea();
    const documents = new SyncDocumentStorage(syncStorage, localStorage);
    await documents.save(previous);
    interrupt({ syncStorage, localStorage });

    await assert.rejects(
      documents.save(replacement),
      /injected storage interruption/,
      mutation,
    );

    const restarted = new SyncDocumentStorage(syncStorage, localStorage);
    assert.deepEqual(await restarted.read(), previous, mutation);
    assert.equal(SYNC_RECOVERY_KEY in localStorage.state, false, mutation);
  }
});

test('committed replacement survives interrupted recovery cleanup', async () => {
  const syncStorage = createStorageArea();
  const localStorage = createStorageArea();
  const documents = new SyncDocumentStorage(syncStorage, localStorage);
  const previous = {
    version: 2,
    sets: {},
    autoload: { scope: 'first-window', setIds: [] },
    deletedSetIds: [],
  };
  const replacement = {
    ...previous,
    autoload: { scope: 'every-window', setIds: [] },
  };
  await documents.save(previous);
  localStorage.failNextRemove();

  await documents.save(replacement);

  const restarted = new SyncDocumentStorage(syncStorage, localStorage);
  assert.deepEqual(await restarted.read(), replacement);
  assert.equal(SYNC_RECOVERY_KEY in localStorage.state, false);
});

test('committed replacement recovers when local cache update is interrupted', async () => {
  const syncStorage = createStorageArea();
  const localStorage = createStorageArea();
  const documents = new SyncDocumentStorage(syncStorage, localStorage);
  const previous = {
    version: 2,
    sets: {},
    autoload: { scope: 'first-window', setIds: [] },
    deletedSetIds: [],
  };
  const replacement = {
    ...previous,
    autoload: { scope: 'every-window', setIds: [] },
  };
  await documents.save(previous);
  localStorage.failNextSetForKey(SYNC_COMMITTED_CACHE_KEY);

  await assert.rejects(
    documents.save(replacement),
    /injected storage interruption/,
  );

  const restarted = new SyncDocumentStorage(syncStorage, localStorage);
  assert.deepEqual(await restarted.read(), replacement);
  assert.equal(SYNC_RECOVERY_KEY in localStorage.state, false);
});

test('reads wait for an active replacement instead of rolling it back', async () => {
  const syncStorage = createStorageArea();
  const localStorage = createStorageArea();
  const documents = new SyncDocumentStorage(syncStorage, localStorage);
  const previous = {
    version: 2,
    sets: {},
    autoload: { scope: 'first-window', setIds: [] },
    deletedSetIds: [],
  };
  const replacement = {
    ...previous,
    autoload: { scope: 'every-window', setIds: [] },
  };
  await documents.save(previous);
  const originalSet = syncStorage.set.bind(syncStorage);
  let resumeChunkWrite;
  let markChunkWriteReached;
  const chunkWriteReached = new Promise((resolve) => {
    markChunkWriteReached = resolve;
  });
  const resumeChunkWritePromise = new Promise((resolve) => {
    resumeChunkWrite = resolve;
  });
  let shouldPause = true;
  syncStorage.set = async (values) => {
    const writesGenerationChunk = Object.keys(values).some(
      (key) => key.startsWith(SYNC_CHUNK_PREFIX),
    );
    if (shouldPause && writesGenerationChunk) {
      shouldPause = false;
      markChunkWriteReached();
      await resumeChunkWritePromise;
    }
    await originalSet(values);
  };

  const save = documents.save(replacement);
  await chunkWriteReached;
  let readSettled = false;
  const read = documents.read().finally(() => {
    readSettled = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(readSettled, false);

  resumeChunkWrite();

  await save;
  assert.deepEqual(await read, replacement);
  assert.equal(SYNC_RECOVERY_KEY in localStorage.state, false);
});

test('local committed cache covers non-atomic cross-device propagation', async () => {
  const syncStorage = createStorageArea();
  const localStorage = createStorageArea();
  const documents = new SyncDocumentStorage(syncStorage, localStorage);
  const previous = {
    version: 2,
    sets: {
      [FIRST_ID]: {
        id: FIRST_ID,
        name: 'Last complete',
        tabs: ['https://complete.example/'],
      },
    },
    autoload: { scope: 'first-window', setIds: [] },
    deletedSetIds: [],
  };
  await documents.save(previous);
  const previousIndex = syncStorage.state[SYNC_INDEX_KEY];
  await syncStorage.remove(previousIndex.chunks);

  assert.deepEqual(await documents.read(), previous);
});

test('startup migration recovers an interrupted normal replacement first', async () => {
  const previous = {
    version: 2,
    sets: {
      [FIRST_ID]: {
        id: FIRST_ID,
        name: 'Recovered on startup',
        tabs: ['https://recovered.example/'],
      },
    },
    autoload: { scope: 'first-window', setIds: [] },
    deletedSetIds: [],
  };
  const chunkKey = `${SYNC_CHUNK_PREFIX}previous:chunk:0`;
  const nextChunkKey = `${SYNC_CHUNK_PREFIX}next:chunk:0`;
  const previousIndex = {
    version: 3,
    generation: 'previous',
    chunks: [chunkKey],
  };
  const syncStorage = createStorageArea({
    [SYNC_INDEX_KEY]: previousIndex,
    [nextChunkKey]: '{"version":2',
  });
  const localStorage = createStorageArea({
    [SYNC_RECOVERY_KEY]: {
      version: 1,
      previousIndex,
      previousChunks: { [chunkKey]: JSON.stringify(previous) },
      nextIndex: {
        version: 3,
        generation: 'next',
        chunks: [nextChunkKey],
      },
    },
  });
  const migration = new BrowserStorageMigration(syncStorage, localStorage);
  const tabSets = new TabSetRepository(
    new BrowserTabSetStorage(syncStorage, migration, localStorage),
  );

  assert.deepEqual(await tabSets.list(), Object.values(previous.sets));
  assert.equal(nextChunkKey in syncStorage.state, false);
  assert.equal(SYNC_RECOVERY_KEY in localStorage.state, false);
});

test('recovery waits for a remotely committed generation to finish propagating', async () => {
  const previous = {
    version: 2,
    sets: {},
    autoload: { scope: 'first-window', setIds: [] },
    deletedSetIds: [],
  };
  const remote = {
    ...previous,
    autoload: { scope: 'every-window', setIds: [] },
  };
  const previousChunk = `${SYNC_CHUNK_PREFIX}previous:chunk:0`;
  const nextChunk = `${SYNC_CHUNK_PREFIX}next:chunk:0`;
  const remoteChunk = `${SYNC_CHUNK_PREFIX}remote:chunk:0`;
  const syncStorage = createStorageArea({
    [SYNC_INDEX_KEY]: {
      version: 3,
      generation: 'remote',
      chunks: [remoteChunk],
    },
    [nextChunk]: '{"version":2',
  });
  const localStorage = createStorageArea({
    [SYNC_RECOVERY_KEY]: {
      version: 1,
      previousIndex: {
        version: 3,
        generation: 'previous',
        chunks: [previousChunk],
      },
      previousChunks: { [previousChunk]: JSON.stringify(previous) },
      nextIndex: {
        version: 3,
        generation: 'next',
        chunks: [nextChunk],
      },
    },
  });

  const documents = new SyncDocumentStorage(syncStorage, localStorage);

  assert.deepEqual(await documents.read(), previous);
  assert.equal(syncStorage.state[SYNC_INDEX_KEY].generation, 'remote');
  assert.equal(SYNC_RECOVERY_KEY in localStorage.state, true);

  await syncStorage.set({ [remoteChunk]: JSON.stringify(remote) });

  assert.deepEqual(await documents.read(), remote);
  assert.equal(syncStorage.state[SYNC_INDEX_KEY].generation, 'remote');
  assert.equal(SYNC_RECOVERY_KEY in localStorage.state, false);
});
