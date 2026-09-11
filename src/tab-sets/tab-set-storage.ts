import { SYNC_DOCUMENT_KEY, emptySyncDocument } from '../storage/storage-schema.js';
import {
  createSerializedOperation,
  createSerializedStorageOperation,
} from '../storage/serialized-operation.js';

const TAB_SET_LOCK = 'save-pinned-tabs:tab-sets';

type SyncDocument = ReturnType<typeof emptySyncDocument>;
type TabSet = SyncDocument['sets'][string];
type AutoloadConfiguration = SyncDocument['autoload'];
interface SyncStorage {
  get(key: string): Promise<unknown>;
  set(values: Record<string, unknown>): Promise<void>;
}

interface Migration {
  ensureMigrated(): Promise<void>;
}

interface InMemoryTabSetStorageOptions {
  sets?: readonly TabSet[];
  autoload?: AutoloadConfiguration;
}

const EMPTY_SYNC_DOCUMENT = emptySyncDocument();

const NOOP_MIGRATION: Migration = {
  ensureMigrated: () => Promise.resolve(),
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasShape(value: unknown, template: unknown): boolean {
  if (Array.isArray(template)) {
    return Array.isArray(value);
  }

  if (isRecord(template)) {
    if (!isRecord(value)) {
      return false;
    }

    return Object.entries(template).every(
      ([key, expectedValue]) =>
        key in value && hasShape(value[key], expectedValue),
    );
  }

  if (template === null) {
    return value === null;
  }

  return typeof value === typeof template;
}

function isTabSet(value: unknown): value is TabSet {
  return isRecord(value) && typeof value.id === 'string';
}

function isAutoloadConfiguration(
  value: unknown,
): value is AutoloadConfiguration {
  if (!isRecord(value) || !hasShape(value, EMPTY_SYNC_DOCUMENT.autoload)) {
    return false;
  }

  const setIds = value.setIds;
  return (
    Array.isArray(setIds) &&
    setIds.every((setId) => typeof setId === 'string')
  );
}

function isSyncDocument(value: unknown): value is SyncDocument {
  if (!isRecord(value) || !hasShape(value, EMPTY_SYNC_DOCUMENT)) {
    return false;
  }

  const sets = value.sets;
  const deletedSetIds = value.deletedSetIds;
  const autoload = value.autoload;

  return (
    isRecord(sets) &&
    Object.values(sets).every(isTabSet) &&
    Array.isArray(deletedSetIds) &&
    deletedSetIds.every((setId) => typeof setId === 'string') &&
    isAutoloadConfiguration(autoload)
  );
}

function readImportedTabSets(value: unknown): TabSet[] {
  if (!Array.isArray(value)) {
    throw new TypeError('Imported tab sets must be an array');
  }

  const sets: TabSet[] = [];

  for (const set of value) {
    if (!isTabSet(set)) {
      throw new TypeError('Imported tab sets contain an invalid tab set');
    }

    sets.push(set);
  }

  return sets;
}

function readImportedAutoload(value: unknown): AutoloadConfiguration {
  if (!isAutoloadConfiguration(value)) {
    throw new TypeError('Imported autoload configuration is invalid');
  }

  return value;
}

export class BrowserTabSetStorage {
  #storage: SyncStorage;
  #migration: Migration;
  #runExclusive: ReturnType<typeof createSerializedStorageOperation>;

  constructor(
    syncStorage: SyncStorage,
    migration: Migration = NOOP_MIGRATION,
  ) {
    this.#storage = syncStorage;
    this.#migration = migration;
    this.#runExclusive = createSerializedStorageOperation(
      syncStorage,
      TAB_SET_LOCK,
    );
  }

  runExclusive<Result>(operation: () => Promise<Result>): Promise<Result> {
    return this.#runExclusive(async () => {
      await this.#migration.ensureMigrated();
      return operation();
    });
  }

  async list(): Promise<TabSet[]> {
    const document = await this.#read();
    return Object.values(document.sets).map((set) => structuredClone(set));
  }

  async get(setId: string): Promise<TabSet | null> {
    const document = await this.#read();
    const set = document.sets[setId];
    return set ? structuredClone(set) : null;
  }

  async identities(): Promise<Set<string>> {
    const document = await this.#read();
    return new Set(Object.keys(document.sets).concat(document.deletedSetIds));
  }

  async save(set: TabSet): Promise<void> {
    const document = await this.#read();
    document.sets[set.id] = structuredClone(set);
    await this.#write(document);
  }

  async restore(setId: string, previousSet?: TabSet | null): Promise<void> {
    const document = await this.#read();

    if (previousSet) {
      document.sets[setId] = structuredClone(previousSet);
    } else {
      delete document.sets[setId];

      if (!document.deletedSetIds.includes(setId)) {
        document.deletedSetIds.push(setId);
      }
    }

    await this.#write(document);
  }

  async getAutoload(): Promise<AutoloadConfiguration> {
    const document = await this.#read();
    return structuredClone(document.autoload);
  }

  async setAutoload(
    configuration: AutoloadConfiguration,
  ): Promise<void> {
    const document = await this.#read();
    document.autoload = structuredClone(configuration);
    await this.#write(document);
  }

  async remove(setId: string): Promise<void> {
    const document = await this.#read();

    if (document.sets[setId]) {
      delete document.sets[setId];

      if (!document.deletedSetIds.includes(setId)) {
        document.deletedSetIds.push(setId);
      }
    }

    document.autoload.setIds = document.autoload.setIds.filter(
      (id) => id !== setId,
    );

    await this.#write(document);
  }

  async import(
    sets: readonly TabSet[],
    autoload: AutoloadConfiguration,
  ): Promise<void>;
  async import(sets: unknown, autoload: unknown): Promise<void> {
    const document = await this.#read();
    const importedSets = readImportedTabSets(sets);
    const importedAutoload = readImportedAutoload(autoload);

    for (const set of importedSets) {
      document.sets[set.id] = structuredClone(set);
    }

    document.autoload = structuredClone(importedAutoload);
    await this.#write(document);
  }

  async #read(): Promise<SyncDocument> {
    await this.#migration.ensureMigrated();

    const stored: unknown = await this.#storage.get(SYNC_DOCUMENT_KEY);

    if (!isRecord(stored)) {
      throw new TypeError('Stored tab set document is invalid');
    }

    const value = stored[SYNC_DOCUMENT_KEY];

    if (!isSyncDocument(value)) {
      throw new TypeError('Stored tab set document is invalid');
    }

    return structuredClone(value);
  }

  async #write(document: SyncDocument): Promise<void> {
    await this.#storage.set({
      [SYNC_DOCUMENT_KEY]: structuredClone(document),
    });
  }
}

export class InMemoryTabSetStorage {
  #document: SyncDocument;
  #runExclusive = createSerializedOperation(
    'save-pinned-tabs:memory-tab-sets',
  );

  constructor({ sets = [], autoload }: InMemoryTabSetStorageOptions = {}) {
    this.#document = emptySyncDocument();

    for (const set of sets) {
      this.#document.sets[set.id] = structuredClone(set);
    }

    if (autoload) {
      this.#document.autoload = structuredClone(autoload);
    }
  }

  runExclusive<Result>(operation: () => Promise<Result>): Promise<Result> {
    return this.#runExclusive(operation);
  }

  async list(): Promise<TabSet[]> {
    return Object.values(this.#document.sets).map((set) =>
      structuredClone(set),
    );
  }

  async get(setId: string): Promise<TabSet | null> {
    const set = this.#document.sets[setId];
    return set ? structuredClone(set) : null;
  }

  async identities(): Promise<Set<string>> {
    return new Set(
      Object.keys(this.#document.sets).concat(
        this.#document.deletedSetIds,
      ),
    );
  }

  async save(set: TabSet): Promise<void> {
    this.#document.sets[set.id] = structuredClone(set);
  }

  async restore(setId: string, previousSet?: TabSet | null): Promise<void> {
    if (previousSet) {
      this.#document.sets[setId] = structuredClone(previousSet);
    } else {
      delete this.#document.sets[setId];

      if (!this.#document.deletedSetIds.includes(setId)) {
        this.#document.deletedSetIds.push(setId);
      }
    }
  }

  async getAutoload(): Promise<AutoloadConfiguration> {
    return structuredClone(this.#document.autoload);
  }

  async setAutoload(
    configuration: AutoloadConfiguration,
  ): Promise<void> {
    this.#document.autoload = structuredClone(configuration);
  }

  async remove(setId: string): Promise<void> {
    if (this.#document.sets[setId]) {
      delete this.#document.sets[setId];

      if (!this.#document.deletedSetIds.includes(setId)) {
        this.#document.deletedSetIds.push(setId);
      }
    }

    this.#document.autoload.setIds =
      this.#document.autoload.setIds.filter((id) => id !== setId);
  }

  async import(
    sets: readonly TabSet[],
    autoload: AutoloadConfiguration,
  ): Promise<void>;
  async import(sets: unknown, autoload: unknown): Promise<void> {
    const importedSets = readImportedTabSets(sets);
    const importedAutoload = readImportedAutoload(autoload);

    for (const set of importedSets) {
      this.#document.sets[set.id] = structuredClone(set);
    }

    this.#document.autoload = structuredClone(importedAutoload);
  }
}