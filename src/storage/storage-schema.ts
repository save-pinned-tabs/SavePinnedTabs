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

/** Identifies the legacy shortcut-assignment record. */
const LEGACY_SHORTCUTS_KEY = 'shortcutSets';

/** Serializes schema migrations across extension contexts. */
const MIGRATION_LOCK = 'save-pinned-tabs:schema-migration';

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
  shortcutAssignments?: Record<string, unknown> | null;
}

/** Represents a normalized local document containing valid set references. */
interface LocalDocument extends StoredLocalDocument {
  windowSessions: Record<string, string>;
  shortcutAssignments: Record<string, string>;
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

/** Creates a local document with no session or shortcut references. */
export function emptyLocalDocument(): LocalDocument {
  return {
    version: STORAGE_SCHEMA_VERSION,
    windowSessions: {},
    shortcutAssignments: {},
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

  if (
    'windowSessions' in document
    && document['windowSessions'] !== null
    && !isRecord(document['windowSessions'])
  ) {
    return false;
  }

  return !(
    'shortcutAssignments' in document
    && document['shortcutAssignments'] !== null
    && !isRecord(document['shortcutAssignments'])
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

  if (
    !isStringRecord(document.windowSessions)
    || !isStringRecord(document.shortcutAssignments)
  ) {
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

/** Extracts well-formed legacy tab sets while excluding the current document. */
function legacySetEntries(stored: StorageRecord): Array<[string, LegacySet]> {
  return Object.entries(stored).filter(
    (entry): entry is [string, LegacySet] => {
      const [key, value] = entry;
      return key !== SYNC_DOCUMENT_KEY
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

/** Converts legacy synchronized entries into a current document. */
function createMigratedSyncDocument(
  stored: StorageRecord,
  createId: () => string,
): SyncDocument {
  const document = emptySyncDocument();
  const legacyIds: Record<string, string> = {};
  const usedIds = new Set<string>();

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

  if (Object.keys(legacyIds).length > 0) {
    document.migration = { legacyIds };
  }
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
  const legacyShortcuts = isRecord(stored[LEGACY_SHORTCUTS_KEY])
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

  const shortcutAssignments: Record<string, string> = {};
  if (isRecord(document.shortcutAssignments)) {
    for (const [command, setId] of Object.entries(
      document.shortcutAssignments,
    )) {
      if (typeof setId === 'string' && knownIds.has(setId)) {
        shortcutAssignments[command] = setId;
      }
    }
  }

  document.windowSessions = windowSessions;
  document.shortcutAssignments = shortcutAssignments;
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

  /** Migrates documents, cleans references, and removes legacy storage entries. */
  async #migrate(): Promise<void> {
    const [storedSync, storedLocal] = await Promise.all([
      this.#syncStorage.get(null),
      this.#localStorage.get(null),
    ]);

    const storedSyncDocument = storedSync[SYNC_DOCUMENT_KEY];
    let syncDocument: SyncDocument;
    let syncChanged = false;
    if (storedSyncDocument === undefined) {
      syncDocument = createMigratedSyncDocument(storedSync, this.#createId);
      await this.#syncStorage.set({ [SYNC_DOCUMENT_KEY]: syncDocument });
      syncChanged = true;
    } else {
      syncDocument = parseSyncDocument(storedSyncDocument);
      syncChanged =
        JSON.stringify(syncDocument) !== JSON.stringify(storedSyncDocument);
    }

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
      localDocument.shortcutAssignments ??= {};
      cleanLocalReferences(
        localDocument,
        new Set(Object.keys(syncDocument.sets)),
      );
      localChanged =
        JSON.stringify(localDocument) !== JSON.stringify(storedLocalDocument);
    }

    if (localChanged) {
      await this.#localStorage.set({
        [LOCAL_DOCUMENT_KEY]: localDocument,
      });
    }

    const legacySetKeys = legacySetEntries(storedSync).map(([key]) => key);
    if (syncDocument.migration) {
      delete syncDocument.migration;
      syncChanged = true;
    }
    if (syncChanged) {
      await this.#syncStorage.set({ [SYNC_DOCUMENT_KEY]: syncDocument });
    }

    await Promise.all([
      removeKeys(this.#syncStorage, legacySetKeys),
      removeKeys(
        this.#localStorage,
        [LEGACY_SESSIONS_KEY, LEGACY_SHORTCUTS_KEY]
          .filter((key) => key in storedLocal),
      ),
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