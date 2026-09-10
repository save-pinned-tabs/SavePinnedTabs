import { BrowserReferenceStorage, InMemoryReferenceStorage } from './storage-schema.mjs';

function sessionError(operation, identity, cause) {
  return new Error(`Failed to ${operation} window session for window "${identity}": ${cause.message}`, { cause });
}

export class WindowSessionRepository {
  #storage;

  constructor(storage) {
    this.#storage = storage;
  }

  async get(windowId) {
    try {
      const sessions = await this.#storage.readAll();
      return sessions[windowId] ?? null;
    } catch (error) {
      throw sessionError('get', windowId, error);
    }
  }

  set(windowId, setId) {
    return this.#storage.runExclusive(async () => {
      try {
        const sessions = await this.#storage.readAll();
        sessions[windowId] = setId;
        await this.#storage.writeAll(sessions);
      } catch (error) {
        throw sessionError('set', windowId, error);
      }
    });
  }

  clear(windowId) {
    return this.#storage.runExclusive(() => this.#removeWindow(windowId, 'clear'));
  }

  clearAll() {
    return this.#storage.runExclusive(async () => {
      try {
        await this.#storage.clearAll();
      } catch (error) {
        throw sessionError('clear all', 'all', error);
      }
    });
  }

  clearClosedWindow(windowId) {
    return this.#storage.runExclusive(() => this.#removeWindow(windowId, 'clean closed'));
  }

  clearSetReferences(setId) {
    return this.#storage.runExclusive(async () => {
      try {
        const sessions = await this.#storage.readAll();
        let changed = false;
        for (const [windowId, activeSetId] of Object.entries(sessions)) {
          if (activeSetId !== setId) continue;
          delete sessions[windowId];
          changed = true;
        }
        if (changed) await this.#storage.writeAll(sessions);
      } catch (error) {
        throw new Error(`Failed to clear window sessions for tab set "${setId}": ${error.message}`, { cause: error });
      }
    });
  }

  async #removeWindow(windowId, operation) {
    try {
      const sessions = await this.#storage.readAll();
      if (!(windowId in sessions)) return;
      delete sessions[windowId];
      await this.#storage.writeAll(sessions);
    } catch (error) {
      throw sessionError(operation, windowId, error);
    }
  }
}

export class BrowserWindowSessionStorage {
  #references;
  #document;

  constructor(localStorageOrReferences, migration) {
    this.#references = typeof localStorageOrReferences?.read === 'function'
      ? localStorageOrReferences
      : new BrowserReferenceStorage(localStorageOrReferences, migration);
  }

  runExclusive(operation) {
    return this.#references.runExclusive(async () => {
      this.#document = await this.#references.read();
      try {
        return await operation();
      } finally {
        this.#document = undefined;
      }
    });
  }

  async readAll() {
    const document = this.#document ?? await this.#references.read();
    return { ...document.windowSessions };
  }

  async writeAll(sessions) {
    const document = this.#document ?? await this.#references.read();
    document.windowSessions = { ...sessions };
    await this.#references.write(document);
  }

  async clearAll() {
    const document = this.#document ?? await this.#references.read();
    document.windowSessions = {};
    await this.#references.write(document);
  }
}

export class InMemoryWindowSessionStorage extends BrowserWindowSessionStorage {
  constructor(references = new InMemoryReferenceStorage()) {
    super(references);
  }
}
