/** Provides browser-backed and in-memory storage for tab sets and autoload settings. */

import type { BrowserStorageArea } from '../browser-api.js';
import type { AutoloadConfiguration, TabSet } from '../domain.js';
import {
  SYNC_DOCUMENT_KEY,
  emptySyncDocument,
  parseSyncDocument,
  type SyncDocument,
} from '../storage/storage-schema.js';
import {
  createSerializedOperation,
  createSerializedStorageOperation,
} from '../storage/serialized-operation.js';

const TAB_SET_LOCK = 'save-pinned-tabs:tab-sets';


/** Ensures legacy storage data is migrated before access. */
interface Migration {
  /** Completes any required migration before resolving. */
  ensureMigrated(): Promise<void>;
}

/** Configures the initial state of an in-memory tab set store. */
interface InMemoryTabSetStorageOptions {
  sets?: readonly TabSet[];
  autoload?: AutoloadConfiguration;
}


const NOOP_MIGRATION: Migration = {
  ensureMigrated: () => Promise.resolve(),
};



/** Persists tab sets and autoload settings in browser synchronization storage. */
export class BrowserTabSetStorage {
  #storage: BrowserStorageArea;
  #migration: Migration;
  #runExclusive: ReturnType<typeof createSerializedStorageOperation>;

  /** Creates a store that coordinates access through a shared storage lock. */
  constructor(
    syncStorage: BrowserStorageArea,
    migration: Migration = NOOP_MIGRATION,
  ) {
    this.#storage = syncStorage;
    this.#migration = migration;
    this.#runExclusive = createSerializedStorageOperation(
      syncStorage,
      TAB_SET_LOCK,
    );
  }

  /** Runs an operation exclusively after completing any pending migration. */
  runExclusive<Result>(operation: () => Promise<Result>): Promise<Result> {
    return this.#runExclusive(async () => {
      await this.#migration.ensureMigrated();
      return operation();
    });
  }
  /** Reads tab sets and Autoload settings from one storage snapshot. */
  async getPopupData(): Promise<{
    sets: TabSet[];
    autoload: AutoloadConfiguration;
  }> {
    const document = await this.#read();
    return {
      sets: Object.values(document.sets).map((set) => structuredClone(set)),
      autoload: structuredClone(document.autoload),
    };
  }

  /** Lists independent copies of all stored tab sets. */
  async list(): Promise<TabSet[]> {
    const document = await this.#read();
    return Object.values(document.sets).map((set) => structuredClone(set));
  }

  /** Retrieves an independent copy of a tab set, or null when absent. */
  async get(setId: string): Promise<TabSet | null> {
    const document = await this.#read();
    const set = document.sets[setId];
    return set ? structuredClone(set) : null;
  }

  /** Collects identifiers for current and previously deleted tab sets. */
  async identities(): Promise<Set<string>> {
    const document = await this.#read();
    return new Set(Object.keys(document.sets).concat(document.deletedSetIds));
  }

  /** Stores an independent copy of a tab set by its identifier. */
  async save(set: TabSet): Promise<void> {
    const document = await this.#read();
    document.sets[set.id] = structuredClone(set);
    await this.#write(document);
  }

  /** Restores a previous value or records the identifier as deleted. */
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

  /** Retrieves an independent copy of the autoload configuration. */
  async getAutoload(): Promise<AutoloadConfiguration> {
    const document = await this.#read();
    return structuredClone(document.autoload);
  }

  /** Replaces the stored autoload configuration with an independent copy. */
  async setAutoload(
    configuration: AutoloadConfiguration,
  ): Promise<void> {
    const document = await this.#read();
    document.autoload = structuredClone(configuration);
    await this.#write(document);
  }

  /** Deletes a tab set, records its identity, and removes autoload references. */
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

  /** Merges tab sets into storage and replaces the autoload configuration. */
  async import(
    sets: readonly TabSet[],
    autoload: AutoloadConfiguration,
  ): Promise<void> {
    const document = await this.#read();
    for (const set of sets) {
      document.sets[set.id] = structuredClone(set);
    }

    document.autoload = structuredClone(autoload);
    await this.#write(document);
  }

  /** Reads and validates the synchronized document after migration. */
  async #read(): Promise<SyncDocument> {
    await this.#migration.ensureMigrated();

    const stored = await this.#storage.get(SYNC_DOCUMENT_KEY);
    try {
      return parseSyncDocument(stored[SYNC_DOCUMENT_KEY]);
    } catch (cause: unknown) {
      throw new TypeError('Stored tab set document is invalid', { cause });
    }
  }

  /** Writes an independent copy of the complete synchronized document. */
  async #write(document: SyncDocument): Promise<void> {
    await this.#storage.set({
      [SYNC_DOCUMENT_KEY]: structuredClone(document),
    });
  }
}

/** Stores tab sets and autoload settings in memory for isolated use. */
export class InMemoryTabSetStorage {
  #document: SyncDocument;

  /** Serializes operations within this in-memory store. */
  readonly runExclusive = createSerializedOperation(
    'save-pinned-tabs:memory-tab-sets',
  );

  /** Creates a store containing independent copies of the initial values. */
  constructor({ sets = [], autoload }: InMemoryTabSetStorageOptions = {}) {
    this.#document = emptySyncDocument();

    for (const set of sets) {
      this.#document.sets[set.id] = structuredClone(set);
    }

    if (autoload) {
      this.#document.autoload = structuredClone(autoload);
    }
  }


  /** Reads tab sets and Autoload settings from one storage snapshot. */
  async getPopupData(): Promise<{
    sets: TabSet[];
    autoload: AutoloadConfiguration;
  }> {
    return {
      sets: Object.values(this.#document.sets).map((set) =>
        structuredClone(set)
      ),
      autoload: structuredClone(this.#document.autoload),
    };
  }
  /** Lists independent copies of all stored tab sets. */
  async list(): Promise<TabSet[]> {
    return Object.values(this.#document.sets).map((set) =>
      structuredClone(set),
    );
  }

  /** Retrieves an independent copy of a tab set, or null when absent. */
  async get(setId: string): Promise<TabSet | null> {
    const set = this.#document.sets[setId];
    return set ? structuredClone(set) : null;
  }

  /** Collects identifiers for current and previously deleted tab sets. */
  async identities(): Promise<Set<string>> {
    return new Set(
      Object.keys(this.#document.sets).concat(
        this.#document.deletedSetIds,
      ),
    );
  }

  /** Stores an independent copy of a tab set by its identifier. */
  async save(set: TabSet): Promise<void> {
    this.#document.sets[set.id] = structuredClone(set);
  }

  /** Restores a previous value or records the identifier as deleted. */
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

  /** Retrieves an independent copy of the autoload configuration. */
  async getAutoload(): Promise<AutoloadConfiguration> {
    return structuredClone(this.#document.autoload);
  }

  /** Replaces the stored autoload configuration with an independent copy. */
  async setAutoload(
    configuration: AutoloadConfiguration,
  ): Promise<void> {
    this.#document.autoload = structuredClone(configuration);
  }

  /** Deletes a tab set, records its identity, and removes autoload references. */
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

  /** Merges tab sets into memory and replaces the autoload configuration. */
  async import(
    sets: readonly TabSet[],
    autoload: AutoloadConfiguration,
  ): Promise<void> {
    for (const set of sets) {
      this.#document.sets[set.id] = structuredClone(set);
    }

    this.#document.autoload = structuredClone(autoload);
  }
}