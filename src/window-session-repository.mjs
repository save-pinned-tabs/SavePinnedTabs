import {
  createSerializedOperation,
  createSerializedStorageOperation,
} from './serialized-operation.mjs';

const ACTIVE_TABS_KEY = 'activeTabs';
const WINDOW_SESSION_LOCK = 'save-pinned-tabs:window-sessions';

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
  #storage;
  #runExclusive;

  constructor(localStorage) {
    this.#storage = localStorage;
    this.#runExclusive = createSerializedStorageOperation(localStorage, WINDOW_SESSION_LOCK);
  }

  runExclusive(operation) {
    return this.#runExclusive(operation);
  }

  async readAll() {
    const stored = await this.#storage.get(ACTIVE_TABS_KEY);
    return { ...(stored[ACTIVE_TABS_KEY] ?? {}) };
  }

  async writeAll(sessions) {
    await this.#storage.set({ [ACTIVE_TABS_KEY]: sessions });
  }

  async clearAll() {
    await this.#storage.remove(ACTIVE_TABS_KEY);
  }
}

export class InMemoryWindowSessionStorage {
  #sessions = {};
  #runExclusive = createSerializedOperation('save-pinned-tabs:memory-window-sessions');

  runExclusive(operation) {
    return this.#runExclusive(operation);
  }

  async readAll() {
    return { ...this.#sessions };
  }

  async writeAll(sessions) {
    this.#sessions = { ...sessions };
  }

  async clearAll() {
    this.#sessions = {};
  }
}
