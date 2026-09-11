import type { BrowserStorageArea } from '../browser-api.js';
import type {
  AutoloadConfiguration,
  AutoloadScope,
  TabSet,
} from '../domain.js';
import { isRecord, isStringArray } from '../validation.js';
import { createSerializedStorageOperation } from './serialized-operation.js';

export const STORAGE_SCHEMA_VERSION = 2;
export const SYNC_DOCUMENT_KEY = 'savePinnedTabs:sync';
export const LOCAL_DOCUMENT_KEY = 'savePinnedTabs:local';
export const AUTOLOAD_FIRST_WINDOW = 'first-window';
export const AUTOLOAD_EVERY_WINDOW = 'every-window';


const DEFAULT_AUTOLOAD_SCOPE: AutoloadScope = AUTOLOAD_FIRST_WINDOW;


const LEGACY_SESSIONS_KEY = 'activeTabs';
const LEGACY_SHORTCUTS_KEY = 'shortcutSets';
const MIGRATION_LOCK = 'save-pinned-tabs:schema-migration';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;



interface MigrationMetadata {
  legacyIds: Record<string, string>;
}

interface LooseAutoloadConfiguration {
  scope?: unknown;
  setIds?: unknown;
}

interface StoredSyncDocument {
  version: typeof STORAGE_SCHEMA_VERSION;
  sets: Record<string, TabSet>;
  autoload?: LooseAutoloadConfiguration | null;
  deletedSetIds?: unknown;
  migration?: MigrationMetadata;
}

export interface SyncDocument extends StoredSyncDocument {
  autoload: AutoloadConfiguration;
  deletedSetIds: string[];
}

interface StoredLocalDocument {
  version: typeof STORAGE_SCHEMA_VERSION;
  windowSessions?: Record<string, unknown> | null;
  shortcutAssignments?: Record<string, unknown> | null;
}

interface LocalDocument extends StoredLocalDocument {
  windowSessions: Record<string, string>;
  shortcutAssignments: Record<string, string>;
}

interface LegacySet {
  set_name: string;
  tabs: string[];
  autoload: 0 | 1;
}

type StorageRecord = Record<string, unknown>;
type StorageOperation<T> = () => T | Promise<T>;


interface MigrationOptions {
  createId?: () => string;
}

export interface StorageMigration {
  ensureMigrated(): Promise<void>;
}

const NO_STORAGE_MIGRATION: StorageMigration = {
  ensureMigrated(): Promise<void> {
    return Promise.resolve();
  },
};

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

export function newSetId(): string {
  return globalThis.crypto.randomUUID();
}

export function emptySyncDocument(): SyncDocument {
  return {
    version: STORAGE_SCHEMA_VERSION,
    sets: {},
    autoload: { scope: DEFAULT_AUTOLOAD_SCOPE, setIds: [] },
    deletedSetIds: [],
  };
}

export function emptyLocalDocument(): LocalDocument {
  return {
    version: STORAGE_SCHEMA_VERSION,
    windowSessions: {},
    shortcutAssignments: {},
  };
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value)
    && Object.values(value).every(
      (item: unknown) => typeof item === 'string',
    );
}

export function isAutoloadScope(value: unknown): value is AutoloadScope {
  return value === AUTOLOAD_FIRST_WINDOW
    || value === AUTOLOAD_EVERY_WINDOW;
}

function isStoredSet(value: unknown): value is TabSet {
  return isRecord(value)
    && typeof value['id'] === 'string'
    && typeof value['name'] === 'string'
    && isStringArray(value['tabs']);
}

function isMigrationMetadata(value: unknown): value is MigrationMetadata {
  return isRecord(value) && isStringRecord(value['legacyIds']);
}

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

function assertVersion(
  document: unknown,
  location: 'synchronized',
): asserts document is StoredSyncDocument;
function assertVersion(
  document: unknown,
  location: 'local',
): asserts document is StoredLocalDocument;
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

function uniqueId(usedIds: Set<string>, createId: () => string): string {
  let id: string;
  do {
    id = createId();
  } while (!isUuid(id) || usedIds.has(id));
  usedIds.add(id);
  return id;
}

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
      ]
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

export function parseSyncDocument(value: unknown): SyncDocument {
  assertVersion(value, 'synchronized');
  const document = structuredClone(value);
  normalizeAutoload(document);
  return document;
}

function migrateReference(
  reference: unknown,
  legacyIds: Record<string, string>,
  knownIds: ReadonlySet<string>,
): string | null {
  if (typeof reference !== 'string') return null;
  const setId = legacyIds[reference] ?? reference;
  return knownIds.has(setId) ? setId : null;
}

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

async function removeKeys(
  storage: BrowserStorageArea,
  keys: string[],
): Promise<void> {
  if (keys.length > 0) await storage.remove(keys);
}

export class BrowserStorageMigration implements StorageMigration {
  #syncStorage: BrowserStorageArea;
  #localStorage: BrowserStorageArea;
  #createId: () => string;
  #runExclusive: ReturnType<typeof createSerializedStorageOperation>;
  #migration: Promise<void> | undefined;

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

export class BrowserReferenceStorage {
  #storage: BrowserStorageArea;
  #migration: StorageMigration;
  #runExclusive: ReturnType<typeof createSerializedStorageOperation>;

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

  runExclusive<T>(operation: StorageOperation<T>): Promise<T> {
    return this.#runExclusive(async () => {
      await this.#migration.ensureMigrated();
      return operation();
    });
  }

  async read(): Promise<LocalDocument> {
    await this.#migration.ensureMigrated();
    const stored = await this.#storage.get(LOCAL_DOCUMENT_KEY);
    const document = stored[LOCAL_DOCUMENT_KEY];
    assertLocalDocument(document);
    return structuredClone(document);
  }

  async write(document: LocalDocument): Promise<void> {
    await this.#storage.set({
      [LOCAL_DOCUMENT_KEY]: structuredClone(document),
    });
  }
}

export class InMemoryReferenceStorage {
  #document: LocalDocument = emptyLocalDocument();
  readonly runExclusive = createSerializedStorageOperation(
    this,
    'save-pinned-tabs:memory-references',
  );

  async read(): Promise<LocalDocument> {
    return structuredClone(this.#document);
  }

  async write(document: LocalDocument): Promise<void> {
    this.#document = structuredClone(document);
  }
}