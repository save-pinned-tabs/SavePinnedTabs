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


interface Migration {
  ensureMigrated(): Promise<void>;
}

interface InMemoryTabSetStorageOptions {
  sets?: readonly TabSet[];
  autoload?: AutoloadConfiguration;
}


const NOOP_MIGRATION: Migration = {
  ensureMigrated: () => Promise.resolve(),
};



export class BrowserTabSetStorage {
  #storage: BrowserStorageArea;
  #migration: Migration;
  #runExclusive: ReturnType<typeof createSerializedStorageOperation>;

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
  ): Promise<void> {
    const document = await this.#read();
    for (const set of sets) {
      document.sets[set.id] = structuredClone(set);
    }

    document.autoload = structuredClone(autoload);
    await this.#write(document);
  }

  async #read(): Promise<SyncDocument> {
    await this.#migration.ensureMigrated();

    const stored = await this.#storage.get(SYNC_DOCUMENT_KEY);
    try {
      return parseSyncDocument(stored[SYNC_DOCUMENT_KEY]);
    } catch (cause: unknown) {
      throw new TypeError('Stored tab set document is invalid', { cause });
    }
  }

  async #write(document: SyncDocument): Promise<void> {
    await this.#storage.set({
      [SYNC_DOCUMENT_KEY]: structuredClone(document),
    });
  }
}

export class InMemoryTabSetStorage {
  #document: SyncDocument;
  readonly runExclusive = createSerializedOperation(
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
  ): Promise<void> {
    for (const set of sets) {
      this.#document.sets[set.id] = structuredClone(set);
    }

    this.#document.autoload = structuredClone(autoload);
  }
}