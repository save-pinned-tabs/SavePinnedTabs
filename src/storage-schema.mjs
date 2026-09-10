import { createSerializedStorageOperation } from './serialized-operation.mjs';

export const STORAGE_SCHEMA_VERSION = 2;
export const SYNC_DOCUMENT_KEY = 'savePinnedTabs:sync';
export const LOCAL_DOCUMENT_KEY = 'savePinnedTabs:local';
export const AUTOLOAD_FIRST_WINDOW = 'first-window';
export const AUTOLOAD_EVERY_WINDOW = 'every-window';
const DEFAULT_AUTOLOAD_SCOPE = AUTOLOAD_FIRST_WINDOW;
export const AUTOLOAD_SCOPES = new Set([
  AUTOLOAD_FIRST_WINDOW,
  AUTOLOAD_EVERY_WINDOW,
]);

const LEGACY_SESSIONS_KEY = 'activeTabs';
const LEGACY_SHORTCUTS_KEY = 'shortcutSets';
const MIGRATION_LOCK = 'save-pinned-tabs:schema-migration';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

export function newSetId() {
  return globalThis.crypto.randomUUID();
}

export function emptySyncDocument() {
  return {
    version: STORAGE_SCHEMA_VERSION,
    sets: {},
    autoload: { scope: DEFAULT_AUTOLOAD_SCOPE, setIds: [] },
    deletedSetIds: [],
  };
}

export function emptyLocalDocument() {
  return {
    version: STORAGE_SCHEMA_VERSION,
    windowSessions: {},
    shortcutAssignments: {},
  };
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertVersion(document, location) {
  if (!isObject(document) || document.version !== STORAGE_SCHEMA_VERSION) {
    const version = isObject(document) ? document.version : undefined;
    throw new Error(
      `Unsupported ${location} storage schema version "${String(version)}"; this extension supports version ${STORAGE_SCHEMA_VERSION}`,
    );
  }
}
function matchesLegacyIdentity(key, name) {
  try {
    const decoded = atob(key);
    if (btoa(decoded) !== key) return false;
    if (decoded === name) return true;
    const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes) === name;
  } catch {
    return false;
  }
}


function legacySetEntries(stored) {
  return Object.entries(stored).filter(([key, value]) => (
    key !== SYNC_DOCUMENT_KEY
    && isObject(value)
    && typeof value.set_name === 'string'
    && matchesLegacyIdentity(key, value.set_name)
    && Array.isArray(value.tabs)
    && value.tabs.every((url) => typeof url === 'string')
    && (value.autoload === 0 || value.autoload === 1)
  ));
}

function uniqueId(usedIds, createId) {
  let id;
  do id = createId(); while (!isUuid(id) || usedIds.has(id));
  usedIds.add(id);
  return id;
}

function createMigratedSyncDocument(stored, createId) {
  const document = emptySyncDocument();
  const legacyIds = {};
  const usedIds = new Set();

  for (const [legacyId, legacySet] of legacySetEntries(stored)) {
    const id = uniqueId(usedIds, createId);
    legacyIds[legacyId] = id;
    document.sets[id] = {
      id,
      name: legacySet.set_name,
      tabs: [...legacySet.tabs],
    };
    if (legacySet.autoload === 1) document.autoload.setIds.push(id);
  }

  if (Object.keys(legacyIds).length > 0) document.migration = { legacyIds };
  return document;
}

function normalizeAutoload(document) {
  const knownIds = new Set(Object.keys(document.sets));
  const scope = AUTOLOAD_SCOPES.has(document.autoload?.scope)
    ? document.autoload.scope
    : DEFAULT_AUTOLOAD_SCOPE;
  const setIds = Array.isArray(document.autoload?.setIds)
    ? [...new Set(document.autoload.setIds.filter((id) => knownIds.has(id)))]
    : [];
  document.autoload = { scope, setIds };
  document.deletedSetIds = Array.isArray(document.deletedSetIds)
    ? [...new Set(document.deletedSetIds.filter(isUuid))]
    : [];
}

function migrateReference(reference, legacyIds, knownIds) {
  const setId = legacyIds[reference] ?? reference;
  return knownIds.has(setId) ? setId : null;
}

function createMigratedLocalDocument(stored, syncDocument) {
  const document = emptyLocalDocument();
  const legacyIds = syncDocument.migration?.legacyIds ?? {};
  const knownIds = new Set(Object.keys(syncDocument.sets));
  const legacySessions = isObject(stored[LEGACY_SESSIONS_KEY])
    ? stored[LEGACY_SESSIONS_KEY]
    : {};
  const legacyShortcuts = isObject(stored[LEGACY_SHORTCUTS_KEY])
    ? stored[LEGACY_SHORTCUTS_KEY]
    : {};

  for (const [windowId, reference] of Object.entries(legacySessions)) {
    const setId = migrateReference(reference, legacyIds, knownIds);
    if (setId) document.windowSessions[windowId] = setId;
  }
  for (const [command, reference] of Object.entries(legacyShortcuts)) {
    const setId = migrateReference(reference, legacyIds, knownIds);
    if (setId) document.shortcutAssignments[command] = setId;
  }
  return document;
}

function cleanLocalReferences(document, knownIds) {
  for (const [windowId, setId] of Object.entries(document.windowSessions ?? {})) {
    if (!knownIds.has(setId)) delete document.windowSessions[windowId];
  }
  for (const [command, setId] of Object.entries(document.shortcutAssignments ?? {})) {
    if (!knownIds.has(setId)) delete document.shortcutAssignments[command];
  }
}

async function removeKeys(storage, keys) {
  if (keys.length > 0) await storage.remove(keys);
}

export class BrowserStorageMigration {
  #syncStorage;
  #localStorage;
  #createId;
  #runExclusive;
  #migration;

  constructor(syncStorage, localStorage, { createId = newSetId } = {}) {
    this.#syncStorage = syncStorage;
    this.#localStorage = localStorage;
    this.#createId = createId;
    this.#runExclusive = createSerializedStorageOperation(localStorage, MIGRATION_LOCK);
  }

  ensureMigrated() {
    if (!this.#migration) {
      this.#migration = this.#runExclusive(() => this.#migrate())
        .catch((error) => {
          this.#migration = undefined;
          throw error;
        });
    }
    return this.#migration;
  }

  async #migrate() {
    const [storedSync, storedLocal] = await Promise.all([
      this.#syncStorage.get(null),
      this.#localStorage.get(null),
    ]);

    let syncDocument = storedSync[SYNC_DOCUMENT_KEY];
    let syncChanged = false;
    if (syncDocument === undefined) {
      syncDocument = createMigratedSyncDocument(storedSync, this.#createId);
      await this.#syncStorage.set({ [SYNC_DOCUMENT_KEY]: syncDocument });
      syncChanged = true;
    } else {
      assertVersion(syncDocument, 'synchronized');
      const storedDocument = syncDocument;
      syncDocument = structuredClone(syncDocument);
      normalizeAutoload(syncDocument);
      syncChanged = JSON.stringify(syncDocument) !== JSON.stringify(storedDocument);
    }

    let localDocument = storedLocal[LOCAL_DOCUMENT_KEY];
    let localChanged = false;
    if (localDocument === undefined) {
      localDocument = createMigratedLocalDocument(storedLocal, syncDocument);
      localChanged = true;
    } else {
      assertVersion(localDocument, 'local');
      const storedDocument = localDocument;
      localDocument = structuredClone(localDocument);
      localDocument.windowSessions ??= {};
      localDocument.shortcutAssignments ??= {};
      cleanLocalReferences(localDocument, new Set(Object.keys(syncDocument.sets)));
      localChanged = JSON.stringify(localDocument) !== JSON.stringify(storedDocument);
    }
    if (localChanged) {
      await this.#localStorage.set({ [LOCAL_DOCUMENT_KEY]: localDocument });
    }

    const legacySetKeys = legacySetEntries(storedSync).map(([key]) => key);
    if (syncDocument.migration) {
      delete syncDocument.migration;
      syncChanged = true;
    }
    if (syncChanged) await this.#syncStorage.set({ [SYNC_DOCUMENT_KEY]: syncDocument });
    await Promise.all([
      removeKeys(this.#syncStorage, legacySetKeys),
      removeKeys(this.#localStorage, [LEGACY_SESSIONS_KEY, LEGACY_SHORTCUTS_KEY]
        .filter((key) => key in storedLocal)),
    ]);
  }
}

export class BrowserReferenceStorage {
  #storage;
  #migration;
  #runExclusive;

  constructor(localStorage, migration) {
    this.#storage = localStorage;
    this.#migration = migration;
    this.#runExclusive = createSerializedStorageOperation(
      localStorage,
      'save-pinned-tabs:references',
    );
  }

  runExclusive(operation) {
    return this.#runExclusive(async () => {
      await this.#migration.ensureMigrated();
      return operation();
    });
  }

  async read() {
    await this.#migration.ensureMigrated();
    const stored = await this.#storage.get(LOCAL_DOCUMENT_KEY);
    return structuredClone(stored[LOCAL_DOCUMENT_KEY]);
  }

  async write(document) {
    await this.#storage.set({ [LOCAL_DOCUMENT_KEY]: structuredClone(document) });
  }
}

export class InMemoryReferenceStorage {
  #document = emptyLocalDocument();
  #runExclusive = createSerializedStorageOperation(this, 'save-pinned-tabs:memory-references');

  runExclusive(operation) {
    return this.#runExclusive(operation);
  }

  async read() {
    return structuredClone(this.#document);
  }

  async write(document) {
    this.#document = structuredClone(document);
  }
}
