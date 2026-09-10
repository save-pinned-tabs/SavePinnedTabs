import { SYNC_DOCUMENT_KEY, emptySyncDocument } from '../storage/storage-schema.mjs';
import {
  createSerializedOperation,
  createSerializedStorageOperation,
} from '../storage/serialized-operation.mjs';

const TAB_SET_LOCK = 'save-pinned-tabs:tab-sets';

export class BrowserTabSetStorage {
  #storage;
  #migration;
  #runExclusive;

  constructor(syncStorage, migration) {
    this.#storage = syncStorage;
    this.#migration = migration;
    this.#runExclusive = createSerializedStorageOperation(syncStorage, TAB_SET_LOCK);
  }

  runExclusive(operation) {
    return this.#runExclusive(async () => {
      await this.#migration.ensureMigrated();
      return operation();
    });
  }

  async list() {
    const document = await this.#read();
    return Object.values(document.sets).map((set) => structuredClone(set));
  }

  async get(setId) {
    const document = await this.#read();
    return document.sets[setId] ? structuredClone(document.sets[setId]) : null;
  }

  async identities() {
    const document = await this.#read();
    return new Set(Object.keys(document.sets).concat(document.deletedSetIds));
  }

  async save(set) {
    const document = await this.#read();
    document.sets[set.id] = structuredClone(set);
    await this.#write(document);
  }
  async restore(setId, previousSet) {
    const document = await this.#read();
    if (previousSet) {
      document.sets[setId] = structuredClone(previousSet);
    } else {
      delete document.sets[setId];
      if (!document.deletedSetIds.includes(setId)) document.deletedSetIds.push(setId);
    }
    await this.#write(document);
  }

  async getAutoload() {
    const document = await this.#read();
    return structuredClone(document.autoload);
  }

  async setAutoload(configuration) {
    const document = await this.#read();
    document.autoload = structuredClone(configuration);
    await this.#write(document);
  }

  async remove(setId) {
    const document = await this.#read();
    if (document.sets[setId]) {
      delete document.sets[setId];
      if (!document.deletedSetIds.includes(setId)) document.deletedSetIds.push(setId);
    }
    document.autoload.setIds = document.autoload.setIds.filter((id) => id !== setId);
    await this.#write(document);
  }

  async import(sets, autoload) {
    const document = await this.#read();
    for (const set of sets) document.sets[set.id] = structuredClone(set);
    document.autoload = structuredClone(autoload);
    await this.#write(document);
  }

  async #read() {
    await this.#migration.ensureMigrated();
    const stored = await this.#storage.get(SYNC_DOCUMENT_KEY);
    return structuredClone(stored[SYNC_DOCUMENT_KEY]);
  }

  async #write(document) {
    await this.#storage.set({ [SYNC_DOCUMENT_KEY]: structuredClone(document) });
  }
}

export class InMemoryTabSetStorage {
  #document;
  #runExclusive = createSerializedOperation('save-pinned-tabs:memory-tab-sets');

  constructor({ sets = [], autoload } = {}) {
    this.#document = emptySyncDocument();
    for (const set of sets) this.#document.sets[set.id] = structuredClone(set);
    if (autoload) this.#document.autoload = structuredClone(autoload);
  }

  runExclusive(operation) {
    return this.#runExclusive(operation);
  }

  async list() {
    return Object.values(this.#document.sets).map((set) => structuredClone(set));
  }

  async get(setId) {
    return this.#document.sets[setId] ? structuredClone(this.#document.sets[setId]) : null;
  }

  async identities() {
    return new Set(Object.keys(this.#document.sets).concat(this.#document.deletedSetIds));
  }

  async save(set) {
    this.#document.sets[set.id] = structuredClone(set);
  }
  async restore(setId, previousSet) {
    if (previousSet) {
      this.#document.sets[setId] = structuredClone(previousSet);
    } else {
      delete this.#document.sets[setId];
      if (!this.#document.deletedSetIds.includes(setId)) {
        this.#document.deletedSetIds.push(setId);
      }
    }
  }

  async getAutoload() {
    return structuredClone(this.#document.autoload);
  }

  async setAutoload(configuration) {
    this.#document.autoload = structuredClone(configuration);
  }

  async remove(setId) {
    if (this.#document.sets[setId]) {
      delete this.#document.sets[setId];
      if (!this.#document.deletedSetIds.includes(setId)) this.#document.deletedSetIds.push(setId);
    }
    this.#document.autoload.setIds = this.#document.autoload.setIds.filter((id) => id !== setId);
  }

  async import(sets, autoload) {
    for (const set of sets) this.#document.sets[set.id] = structuredClone(set);
    this.#document.autoload = structuredClone(autoload);
  }
}
