/**
 * Defines storage documents, validation, migration, and reference storage adapters.
 */

import type { BrowserStorageArea } from '../browser-api.js';
import type {
  AutoloadConfiguration,
  AutoloadScope,
  TabSet,
} from '../domain.js';
import { isRecord, isStringArray } from '../validation.js';
import { createSerializedStorageOperation } from './serialized-operation.js';
import {
  SYNC_INDEX_KEY,
  SyncDocumentStorage,
} from './sync-document-storage.js';

/** Identifies the current persisted document format. */
export const STORAGE_SCHEMA_VERSION = 2;

/** Stores the synchronized document under a stable browser storage key. */
export const SYNC_DOCUMENT_KEY = 'savePinnedTabs:sync';

/** Stores the device-local document under a stable browser storage key. */
export const LOCAL_DOCUMENT_KEY = 'savePinnedTabs:local';

/** Limits automatic loading to the first opened window. */
export const AUTOLOAD_FIRST_WINDOW = 'first-window';

/** Enables automatic loading in every opened window. */
export const AUTOLOAD_EVERY_WINDOW = 'every-window';


/** Applies first-window loading when no valid scope is stored. */
const DEFAULT_AUTOLOAD_SCOPE: AutoloadScope = AUTOLOAD_FIRST_WINDOW;


/** Identifies the legacy window-session record. */
const LEGACY_SESSIONS_KEY = 'activeTabs';

/** Identifies obsolete local reference data removed during migration. */
const OBSOLETE_LOCAL_REFERENCES_KEY = 'shortcutSets';

/** Serializes schema migrations across extension contexts. */
const MIGRATION_LOCK = 'save-pinned-tabs:schema-migration';
/** Keeps recovered sync data durable while quota-bound legacy records are replaced. */
const MIGRATION_STAGING_KEY = 'savePinnedTabs:migration-staging';

/** Matches supported canonical UUID strings. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;



/** Maps legacy storage identifiers to generated set identifiers. */
interface MigrationMetadata {
  legacyIds: Record<string, string>;
}

/** Represents unvalidated autoload data read from storage. */
interface LooseAutoloadConfiguration {
  scope?: unknown;
  setIds?: unknown;
}

/** Represents a structurally valid synchronized document before normalization. */
interface StoredSyncDocument {
  version: typeof STORAGE_SCHEMA_VERSION;
  sets: Record<string, TabSet>;
  autoload?: LooseAutoloadConfiguration | null;
  deletedSetIds?: unknown;
  migration?: MigrationMetadata;
}

/** Represents a normalized synchronized document with complete configuration. */
export interface SyncDocument extends StoredSyncDocument {
  autoload: AutoloadConfiguration;
  deletedSetIds: string[];
}

/** Represents a structurally valid local document before reference cleanup. */
interface StoredLocalDocument {
  version: typeof STORAGE_SCHEMA_VERSION;
  windowSessions?: Record<string, unknown> | null;
}

/** Represents a normalized local document containing valid set references. */
interface LocalDocument extends StoredLocalDocument {
  windowSessions: Record<string, string>;
}

/** Represents a tab set stored by the legacy schema. */
interface LegacySet {
  set_name: string;
  tabs: string[];
  autoload: 0 | 1;
}

/** Represents arbitrary entries returned by a browser storage area. */
type StorageRecord = Record<string, unknown>;

/** Represents work executed while holding a storage serialization lock. */
type StorageOperation<T> = () => T | Promise<T>;


/** Configures identifier generation during legacy migration. */
interface MigrationOptions {
  /** Supplies candidate UUIDs, primarily for deterministic migration. */
  createId?: () => string;
}

/** Ensures persisted documents use the current storage schema. */
export interface StorageMigration {
  /** Completes migration before resolving and rejects if migration fails. */
  ensureMigrated(): Promise<void>;
}

/** Provides a migration strategy that performs no work. */
const NO_STORAGE_MIGRATION: StorageMigration = {
  /** Resolves immediately without changing storage. */
  ensureMigrated(): Promise<void> {
    return Promise.resolve();
  },
};

/** Checks whether a value has a supported UUID representation. */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

/** Generates a set identifier using the Web Crypto API. */
export function newSetId(): string {
  return globalThis.crypto.randomUUID();
}

/** Creates a synchronized document with no sets or deleted identifiers. */
export function emptySyncDocument(): SyncDocument {
  return {
    version: STORAGE_SCHEMA_VERSION,
    sets: {},
    autoload: { scope: DEFAULT_AUTOLOAD_SCOPE, setIds: [] },
    deletedSetIds: [],
  };
}

/** Creates a local document with no window-session references. */
export function emptyLocalDocument(): LocalDocument {
  return {
    version: STORAGE_SCHEMA_VERSION,
    windowSessions: {},
  };
}

/** Checks whether every property value in a record is a string. */
function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value)
    && Object.values(value).every(
      (item: unknown) => typeof item === 'string',
    );
}

/** Checks whether a value is a supported autoload scope. */
export function isAutoloadScope(value: unknown): value is AutoloadScope {
  return value === AUTOLOAD_FIRST_WINDOW
    || value === AUTOLOAD_EVERY_WINDOW;
}

/** Checks the persisted shape required for a tab set. */
function isStoredSet(value: unknown): value is TabSet {
  return isRecord(value)
    && typeof value['id'] === 'string'
    && typeof value['name'] === 'string'
    && isStringArray(value['tabs']);
}

/** Checks the legacy identifier mapping stored during migration. */
function isMigrationMetadata(value: unknown): value is MigrationMetadata {
  return isRecord(value) && isStringRecord(value['legacyIds']);
}

/** Checks synchronized document structure without normalizing optional data. */
function isStoredSyncDocument(
  document: unknown,
): document is StoredSyncDocument {
  if (
    !isRecord(document)
    || document['version'] !== STORAGE_SCHEMA_VERSION
    || !isRecord(document['sets'])
    || !Object.values(document['sets']).every(isStoredSet)
  ) {
    return false;
  }

  if (
    'autoload' in document
    && document['autoload'] !== null
    && !isRecord(document['autoload'])
  ) {
    return false;
  }

  return !('migration' in document)
    || isMigrationMetadata(document['migration']);
}

/** Checks local document structure without validating stored references. */
function isStoredLocalDocument(
  document: unknown,
): document is StoredLocalDocument {
  if (
    !isRecord(document)
    || document['version'] !== STORAGE_SCHEMA_VERSION
  ) {
    return false;
  }

  return !(
    'windowSessions' in document
    && document['windowSessions'] !== null
    && !isRecord(document['windowSessions'])
  );
}

/** Validates and narrows a synchronized storage document. */
function assertVersion(
  document: unknown,
  location: 'synchronized',
): asserts document is StoredSyncDocument;

/** Validates and narrows a local storage document. */
function assertVersion(
  document: unknown,
  location: 'local',
): asserts document is StoredLocalDocument;

/** Rejects unsupported schema versions and malformed storage documents. */
function assertVersion(
  document: unknown,
  location: 'synchronized' | 'local',
): void {
  if (
    !isRecord(document)
    || document['version'] !== STORAGE_SCHEMA_VERSION
  ) {
    const version = isRecord(document)
      ? document['version']
      : undefined;
    throw new Error(
      `Unsupported ${location} storage schema version "${String(version)}"; this extension supports version ${STORAGE_SCHEMA_VERSION}`,
    );
  }

  const valid = location === 'synchronized'
    ? isStoredSyncDocument(document)
    : isStoredLocalDocument(document);

  if (!valid) {
    throw new Error(`Invalid ${location} storage document`);
  }
}

/** Validates a complete local document and rejects non-string references. */
function assertLocalDocument(
  document: unknown,
): asserts document is LocalDocument {
  assertVersion(document, 'local');

  if (!isStringRecord(document.windowSessions)) {
    throw new Error('Invalid local storage document');
  }
}

/** Checks whether a legacy key encodes the associated set name. */
function matchesLegacyIdentity(key: string, name: string): boolean {
  try {
    const decoded = atob(key);
    if (btoa(decoded) !== key) return false;
    if (decoded === name) return true;
    const bytes = Uint8Array.from(
      decoded,
      (character) => character.charCodeAt(0),
    );
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes) === name;
  } catch {
    return false;
  }
}

/** Extracts well-formed legacy tab sets while excluding current storage records. */
function legacySetEntries(stored: StorageRecord): Array<[string, LegacySet]> {
  return Object.entries(stored).filter(
    (entry): entry is [string, LegacySet] => {
      const [key, value] = entry;
      return key !== SYNC_DOCUMENT_KEY
        && key !== SYNC_INDEX_KEY
        && isRecord(value)
        && typeof value['set_name'] === 'string'
        && matchesLegacyIdentity(key, value['set_name'])
        && isStringArray(value['tabs'])
        && (value['autoload'] === 0 || value['autoload'] === 1);
    },
  );
}

/** Generates an unused valid UUID and reserves it in the supplied set. */
function uniqueId(usedIds: Set<string>, createId: () => string): string {
  let id: string;
  do {
    id = createId();
  } while (!isUuid(id) || usedIds.has(id));
  usedIds.add(id);
  return id;
}

/** Chooses a deterministic display name without treating names as identity. */
function recoveredName(
  requested: string,
  sets: Record<string, TabSet>,
): string {
  const names = new Set(Object.values(sets).map(({ name }) => name));
  if (!names.has(requested)) return requested;
  let suffix = 2;
  while (names.has(`${requested} (${suffix})`)) suffix += 1;
  return `${requested} (${suffix})`;
}

/** Recovers the deterministic union of valid current and legacy sources. */
function recoverSyncDocument(
  active: SyncDocument | null,
  versionTwo: SyncDocument | null,
  stored: StorageRecord,
  createId: () => string,
): SyncDocument {
  const document = active
    ? structuredClone(active)
    : versionTwo
      ? structuredClone(versionTwo)
      : emptySyncDocument();
  const usedIds = new Set([
    ...Object.keys(document.sets),
    ...document.deletedSetIds,
  ]);
  const legacyIds = {
    ...(versionTwo?.migration?.legacyIds ?? {}),
    ...(active?.migration?.legacyIds ?? {}),
  };

  if (active && versionTwo) {
    for (const [id, set] of Object.entries(versionTwo.sets)) {
      if (!(id in document.sets) && !usedIds.has(id)) {
        document.sets[id] = structuredClone(set);
        usedIds.add(id);
      }
    }
  }

  for (const [legacyId, legacySet] of legacySetEntries(stored)) {
    const mappedId = legacyIds[legacyId];
    const mappedSet = mappedId ? document.sets[mappedId] : undefined;
    const isExactMigratedCopy = mappedSet
      && mappedSet.name === legacySet.set_name
      && JSON.stringify(mappedSet.tabs) === JSON.stringify(legacySet.tabs);
    if (isExactMigratedCopy) continue;

    const id = mappedId && !usedIds.has(mappedId)
      ? mappedId
      : uniqueId(usedIds, createId);
    usedIds.add(id);
    legacyIds[legacyId] = id;
    document.sets[id] = {
      id,
      name: recoveredName(legacySet.set_name, document.sets),
      tabs: [...legacySet.tabs],
    };
    if (
      legacySet.autoload === 1
      && document.autoload.setIds.length === 0
    ) {
      document.autoload.setIds = [id];
    }
  }

  if (Object.keys(legacyIds).length > 0) {
    document.migration = { legacyIds };
  }
  normalizeAutoload(document);
  return document;
}

/** Normalizes autoload and deletion data in place, discarding invalid entries. */
function normalizeAutoload(
  document: StoredSyncDocument,
): asserts document is SyncDocument {
  const knownIds = new Set(Object.keys(document.sets));
  const scope = isAutoloadScope(document.autoload?.scope)
    ? document.autoload.scope
    : DEFAULT_AUTOLOAD_SCOPE;
  const setIds = Array.isArray(document.autoload?.setIds)
    ? [
        ...new Set(
          document.autoload.setIds.filter(
            (id: unknown): id is string =>
              typeof id === 'string' && knownIds.has(id),
          ),
        ),
      ].slice(0, 1)
    : [];
  document.autoload = { scope, setIds };
  document.deletedSetIds = Array.isArray(document.deletedSetIds)
    ? [
        ...new Set(
          document.deletedSetIds.filter(
            (id: unknown): id is string => isUuid(id),
          ),
        ),
      ]
    : [];
}

/** Validates, clones, and normalizes a synchronized document. */
export function parseSyncDocument(value: unknown): SyncDocument {
  assertVersion(value, 'synchronized');
  const document = structuredClone(value);
  normalizeAutoload(document);
  return document;
}

/** Resolves a current or legacy reference and drops unknown set identifiers. */
function migrateReference(
  reference: unknown,
  legacyIds: Record<string, string>,
  knownIds: ReadonlySet<string>,
): string | null {
  if (typeof reference !== 'string') return null;
  const setId = legacyIds[reference] ?? reference;
  return knownIds.has(setId) ? setId : null;
}

/** Converts valid legacy local references into a current local document. */
function createMigratedLocalDocument(
  stored: StorageRecord,
  syncDocument: SyncDocument,
): LocalDocument {
  const document = emptyLocalDocument();
  const legacyIds = syncDocument.migration?.legacyIds ?? {};
  const knownIds = new Set(Object.keys(syncDocument.sets));
  const legacySessions = isRecord(stored[LEGACY_SESSIONS_KEY])
    ? stored[LEGACY_SESSIONS_KEY]
    : {};

  for (const [windowId, reference] of Object.entries(legacySessions)) {
    const setId = migrateReference(reference, legacyIds, knownIds);
    if (setId) document.windowSessions[windowId] = setId;
  }
  return document;
}

/** Replaces local reference maps in place with valid known set references. */
function cleanLocalReferences(
  document: StoredLocalDocument,
  knownIds: ReadonlySet<string>,
): asserts document is LocalDocument {
  const windowSessions: Record<string, string> = {};
  if (isRecord(document.windowSessions)) {
    for (const [windowId, setId] of Object.entries(
      document.windowSessions,
    )) {
      if (typeof setId === 'string' && knownIds.has(setId)) {
        windowSessions[windowId] = setId;
      }
    }
  }


  document.windowSessions = windowSessions;
}

/** Removes storage entries when at least one key is present. */
async function removeKeys(
  storage: BrowserStorageArea,
  keys: string[],
): Promise<void> {
  if (keys.length > 0) await storage.remove(keys);
}

/** Migrates synchronized and local browser storage to the current schema. */
export class BrowserStorageMigration implements StorageMigration {
  /** Provides access to synchronized browser storage. */
  #syncStorage: BrowserStorageArea;

  /** Provides access to device-local browser storage. */
  #localStorage: BrowserStorageArea;

  /** Generates identifiers for migrated legacy sets. */
  #createId: () => string;

  /** Serializes migration work across extension contexts. */
  #runExclusive: ReturnType<typeof createSerializedStorageOperation>;

  /** Caches the active or completed migration attempt. */
  #migration: Promise<void> | undefined;

  /** Creates a migration coordinator for the supplied storage areas. */
  constructor(
    syncStorage: BrowserStorageArea,
    localStorage: BrowserStorageArea,
    { createId = newSetId }: MigrationOptions = {},
  ) {
    this.#syncStorage = syncStorage;
    this.#localStorage = localStorage;
    this.#createId = createId;
    this.#runExclusive = createSerializedStorageOperation(
      localStorage,
      MIGRATION_LOCK,
    );
  }

  /** Runs migration once, shares concurrent work, and permits retry after failure. */
  ensureMigrated(): Promise<void> {
    const currentMigration = this.#migration;
    if (currentMigration) return currentMigration;

    const migration = this.#runExclusive(() => this.#migrate())
      .catch((error: unknown) => {
        this.#migration = undefined;
        throw error;
      });

    this.#migration = migration;
    return migration;
  }

  /** Recovers every valid source, commits a verified generation, then cleans up. */
  async #migrate(): Promise<void> {
    const [storedSync, storedLocal] = await Promise.all([
      this.#syncStorage.get(null),
      this.#localStorage.get(null),
    ]);
    const documents = new SyncDocumentStorage(this.#syncStorage);
    let active: SyncDocument | null = null;
    try {
      active = documents.readSnapshot(storedSync);
    } catch {
      // An invalid or incomplete generation is not allowed to hide old sources.
    }

    let staged: SyncDocument | null = null;
    if (storedLocal[MIGRATION_STAGING_KEY] !== undefined) {
      try {
        staged = parseSyncDocument(storedLocal[MIGRATION_STAGING_KEY]);
      } catch {
        // Invalid staging data cannot supersede recoverable synchronized data.
      }
    }
    let versionTwo: SyncDocument | null = null;
    if (storedSync[SYNC_DOCUMENT_KEY] !== undefined) {
      try {
        versionTwo = parseSyncDocument(storedSync[SYNC_DOCUMENT_KEY]);
      } catch {
        // Invalid version-two data is independent from other recovery sources.
      }
    }
    const legacyEntries = legacySetEntries(storedSync);
    const hasRecoverySources = staged !== null
      || versionTwo !== null
      || legacyEntries.length > 0;

    if (!active && !hasRecoverySources) {
      const hasInvalidSource = SYNC_INDEX_KEY in storedSync
        || SYNC_DOCUMENT_KEY in storedSync;
      if (hasInvalidSource) {
        throw new Error('No valid synchronized storage source is available');
      }
    }
    const syncDocument = recoverSyncDocument(
      active,
      staged ?? versionTwo,
      storedSync,
      this.#createId,
    );

    const storedLocalDocument = storedLocal[LOCAL_DOCUMENT_KEY];
    let localDocument: StoredLocalDocument;
    let localChanged = false;
    if (storedLocalDocument === undefined) {
      localDocument = createMigratedLocalDocument(storedLocal, syncDocument);
      localChanged = true;
    } else {
      assertVersion(storedLocalDocument, 'local');
      localDocument = structuredClone(storedLocalDocument);
      localDocument.windowSessions ??= {};
      cleanLocalReferences(
        localDocument,
        new Set(Object.keys(syncDocument.sets)),
      );
      localChanged =
        JSON.stringify(localDocument) !== JSON.stringify(storedLocalDocument);
    }

    const obsoleteSyncKeys = legacyEntries.map(([key]) => key).concat(
      versionTwo ? [SYNC_DOCUMENT_KEY] : [],
    );
    if (hasRecoverySources) {
      await this.#localStorage.set({
        [MIGRATION_STAGING_KEY]: syncDocument,
      });
      await documents.removeGenerations();
      await removeKeys(this.#syncStorage, obsoleteSyncKeys);
      await documents.save(syncDocument);
    } else if (!active) {
      await documents.save(syncDocument);
    }

    if (localChanged) {
      await this.#localStorage.set({
        [LOCAL_DOCUMENT_KEY]: localDocument,
      });
    }

    await removeKeys(this.#localStorage, [
      MIGRATION_STAGING_KEY,
      ...[LEGACY_SESSIONS_KEY, OBSOLETE_LOCAL_REFERENCES_KEY]
        .filter((key) => key in storedLocal),
    ]);
  }
}

/** Persists local set references after ensuring schema migration completes. */
export class BrowserReferenceStorage {
  /** Provides access to device-local browser storage. */
  #storage: BrowserStorageArea;

  /** Guards reads and serialized operations behind schema migration. */
  #migration: StorageMigration;

  /** Serializes reference updates across extension contexts. */
  #runExclusive: ReturnType<typeof createSerializedStorageOperation>;

  /** Creates a local reference store backed by browser storage. */
  constructor(
    localStorage: BrowserStorageArea,
    migration: StorageMigration = NO_STORAGE_MIGRATION,
  ) {
    this.#storage = localStorage;
    this.#migration = migration;
    this.#runExclusive = createSerializedStorageOperation(
      localStorage,
      'save-pinned-tabs:references',
    );
  }

  /** Runs an operation exclusively after migration completes. */
  runExclusive<T>(operation: StorageOperation<T>): Promise<T> {
    return this.#runExclusive(async () => {
      await this.#migration.ensureMigrated();
      return operation();
    });
  }

  /** Reads and clones the local document, rejecting invalid stored data. */
  async read(): Promise<LocalDocument> {
    await this.#migration.ensureMigrated();
    const stored = await this.#storage.get(LOCAL_DOCUMENT_KEY);
    const document = stored[LOCAL_DOCUMENT_KEY];
    assertLocalDocument(document);
    return structuredClone(document);
  }

  /** Clones and persists the supplied local document. */
  async write(document: LocalDocument): Promise<void> {
    await this.#storage.set({
      [LOCAL_DOCUMENT_KEY]: structuredClone(document),
    });
  }
}

/** Stores local set references in memory while preserving clone semantics. */
export class InMemoryReferenceStorage {
  /** Holds the private mutable document snapshot. */
  #document: LocalDocument = emptyLocalDocument();

  /** Serializes in-memory reference operations. */
  readonly runExclusive = createSerializedStorageOperation(
    this,
    'save-pinned-tabs:memory-references',
  );

  /** Reads an isolated clone of the current document. */
  async read(): Promise<LocalDocument> {
    return structuredClone(this.#document);
  }

  /** Replaces the current document with an isolated clone. */
  async write(document: LocalDocument): Promise<void> {
    this.#document = structuredClone(document);
  }
}