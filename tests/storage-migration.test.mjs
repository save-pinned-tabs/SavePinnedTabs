import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { BrowserStorageMigration } from '../.extension-build/storage/browser-storage-migration.js';
import {
  LOCAL_DOCUMENT_KEY,
  parseLocalDocument,
} from '../.extension-build/storage/storage-schema.js';
import { SyncDocumentStorage } from '../.extension-build/storage/sync-document-storage.js';

const FIXTURE_DIRECTORY = fileURLToPath(
  new URL('./fixtures/storage-migrations/', import.meta.url),
);

function createStorageArea(initialState = {}) {
  const state = structuredClone(initialState);
  return {
    state,
    async get(keys) {
      if (keys === null) return structuredClone(state);
      if (Array.isArray(keys)) {
        return Object.fromEntries(
          keys
            .filter((key) => key in state)
            .map((key) => [key, structuredClone(state[key])]),
        );
      }
      return keys in state ? { [keys]: structuredClone(state[keys]) } : {};
    },
    async set(values) {
      Object.assign(state, structuredClone(values));
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete state[key];
    },
  };
}

function idGenerator() {
  let next = 1;
  return () => `00000000-0000-4000-8000-${String(next++).padStart(12, '0')}`;
}

const fixtureFiles = (await readdir(FIXTURE_DIRECTORY)).sort();
for (const fixtureFile of fixtureFiles) {
  const fixture = JSON.parse(
    await readFile(path.join(FIXTURE_DIRECTORY, fixtureFile), 'utf8'),
  );

  test(`migrates ${fixture.name} without data loss`, async () => {
    const syncStorage = createStorageArea(fixture.sync);
    const localStorage = createStorageArea(fixture.local);
    const migration = new BrowserStorageMigration(syncStorage, localStorage, {
      createId: idGenerator(),
    });

    await migration.ensureMigrated();

    const syncDocument = await new SyncDocumentStorage(syncStorage).read();
    assert.ok(syncDocument);
    const localDocument = parseLocalDocument(
      localStorage.state[LOCAL_DOCUMENT_KEY],
      new Set(Object.keys(syncDocument.sets)),
    );
    const actualSets = Object.values(syncDocument.sets).map((set) => ({
      name: set.name,
      tabs: set.tabs,
      autoload: syncDocument.autoload.setIds.includes(set.id),
      windowIds: Object.entries(localDocument.windowSessions)
        .filter(([, setId]) => setId === set.id)
        .map(([windowId]) => windowId),
    }));

    assert.deepEqual(actualSets, fixture.expected.sets);
    assert.deepEqual(
      syncDocument.deletedSetIds,
      fixture.expected.deletedSetIds ?? [],
    );
    assert.equal(
      syncDocument.autoload.scope,
      fixture.expected.autoloadScope ?? 'first-window',
    );
  });
}
