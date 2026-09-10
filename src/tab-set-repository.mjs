import {
  createSerializedOperation,
  createSerializedStorageOperation,
} from './serialized-operation.mjs';

const TAB_SET_LOCK = 'save-pinned-tabs:tab-sets';

function tabSetError(operation, setId, cause) {
  return new Error(`Failed to ${operation} tab set "${setId}": ${cause.message}`, { cause });
}

function tabSetsEqual(left, right) {
  return left.set_name === right.set_name
    && left.autoload === right.autoload
    && left.tabs.length === right.tabs.length
    && left.tabs.every((url, index) => url === right.tabs[index]);
}

export class TabSetRepository {
  #storage;
  #validateImport;
  #windowSessions;

  constructor(storage, { validateImport, windowSessions } = {}) {
    this.#storage = storage;
    this.#validateImport = validateImport;
    this.#windowSessions = windowSessions;
  }

  async list() {
    try {
      return await this.#storage.list();
    } catch (error) {
      throw tabSetError('list', 'all', error);
    }
  }

  async get(setId) {
    try {
      return await this.#storage.get(setId);
    } catch (error) {
      throw tabSetError('get', setId, error);
    }
  }

  save(setId, set) {
    return this.#storage.runExclusive(async () => {
      try {
        await this.#storage.save(setId, set);
      } catch (error) {
        throw tabSetError('save', setId, error);
      }
    });
  }

  saveForWindow(setId, set, windowId) {
    return this.#storage.runExclusive(async () => {
      try {
        await this.#storage.save(setId, set);
        await this.#windowSessions.set(windowId, setId);
      } catch (error) {
        throw new Error(
          `Failed to save tab set "${setId}" for window "${windowId}": ${error.message}`,
          { cause: error },
        );
      }
    });
  }

  activateWindowSession(setId, expectedSet, windowId) {
    return this.#storage.runExclusive(async () => {
      try {
        const currentSet = await this.#storage.get(setId);
        if (!currentSet || !tabSetsEqual(currentSet, expectedSet)) return false;
        await this.#windowSessions.set(windowId, setId);
        return true;
      } catch (error) {
        throw new Error(
          `Failed to activate tab set "${setId}" for window "${windowId}": ${error.message}`,
          { cause: error },
        );
      }
    });
  }

  setAutoload(setId) {
    return this.#storage.runExclusive(async () => {
      try {
        const sets = await this.#storage.list();
        for (const [storedSetId, set] of Object.entries(sets)) {
          set.autoload = setId && storedSetId === setId ? 1 : 0;
        }
        await this.#storage.saveAll(sets);
      } catch (error) {
        throw tabSetError('set autoload for', setId ?? 'none', error);
      }
    });
  }

  remove(setId) {
    return this.#storage.runExclusive(async () => {
      try {
        await this.#storage.remove(setId);
        await this.#windowSessions?.clearSetReferences(setId);
      } catch (error) {
        throw tabSetError('remove', setId, error);
      }
    });
  }

  async export() {
    try {
      return await this.#storage.list();
    } catch (error) {
      throw tabSetError('export', 'all', error);
    }
  }

  import(sets) {
    return this.#storage.runExclusive(async () => {
      try {
        if (!this.#validateImport?.(sets)) {
          throw new TypeError('Import validation failed');
        }
        await this.#storage.saveAll(sets);
      } catch (error) {
        throw tabSetError('import', 'import payload', error);
      }
    });
  }
}

export class BrowserTabSetStorage {
  #storage;
  #runExclusive;

  constructor(syncStorage) {
    this.#storage = syncStorage;
    this.#runExclusive = createSerializedStorageOperation(syncStorage, TAB_SET_LOCK);
  }

  runExclusive(operation) {
    return this.#runExclusive(operation);
  }

  async list() {
    return this.#storage.get(null);
  }

  async get(setId) {
    const stored = await this.#storage.get(setId);
    return stored[setId] ?? null;
  }

  async save(setId, set) {
    await this.#storage.set({ [setId]: set });
  }

  async saveAll(sets) {
    await this.#storage.set(sets);
  }

  async remove(setId) {
    await this.#storage.remove(setId);
  }
}

export class InMemoryTabSetStorage {
  #sets;
  #runExclusive = createSerializedOperation('save-pinned-tabs:memory-tab-sets');

  constructor(sets = {}) {
    this.#sets = structuredClone(sets);
  }

  runExclusive(operation) {
    return this.#runExclusive(operation);
  }

  async list() {
    return structuredClone(this.#sets);
  }

  async get(setId) {
    return this.#sets[setId] ? structuredClone(this.#sets[setId]) : null;
  }

  async save(setId, set) {
    this.#sets[setId] = structuredClone(set);
  }

  async saveAll(sets) {
    Object.assign(this.#sets, structuredClone(sets));
  }

  async remove(setId) {
    delete this.#sets[setId];
  }
}
