/** Defines current storage documents, validation, and reference storage adapters. */

import type { BrowserStorageArea } from '../browser-api.js';
import type {
  AutoloadConfiguration,
  AutoloadScope,
  TabSet,
} from '../domain.js';
import { isRecord, isStringArray } from '../validation.js';
import {
  createSerializedStorageOperation,
  type SerializedOperation,
} from './serialized-operation.js';

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



/** Matches supported canonical UUID strings. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;



/** Maps historical storage identifiers to generated set identifiers. */
export interface MigrationMetadata {
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
export interface LocalDocument extends StoredLocalDocument {
  windowSessions: Record<string, string>;
}


/** Represents work executed while holding a storage serialization lock. */
type StorageOperation<T> = () => T | Promise<T>;



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


/** Validates, clones, and retains only known local set references. */
export function parseLocalDocument(
  value: unknown,
  knownIds?: ReadonlySet<string>,
): LocalDocument {
  assertVersion(value, 'local');
  const document = structuredClone(value);
  if (!knownIds) {
    if (!isStringRecord(document.windowSessions)) {
      throw new Error('Invalid local storage document');
    }
    return { ...document, windowSessions: document.windowSessions };
  }
  const windowSessions: Record<string, string> = {};
  if (isRecord(document.windowSessions)) {
    for (const [windowId, setId] of Object.entries(document.windowSessions)) {
      if (
        typeof setId === 'string'
        && knownIds.has(setId)
      ) {
        windowSessions[windowId] = setId;
      }
    }
  }
  return { ...document, windowSessions };
}



/** Persists local set references after ensuring schema migration completes. */
export class BrowserReferenceStorage {
  /** Provides access to device-local browser storage. */
  #storage: BrowserStorageArea;

  /** Guards reads and serialized operations behind schema migration. */
  #migration: StorageMigration;

  /** Serializes reference updates across extension contexts. */
  #runExclusive: SerializedOperation;

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
    return parseLocalDocument(stored[LOCAL_DOCUMENT_KEY]);
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