import type { BrowserStorageArea } from '../browser-api.js';
import type { TabSetId, WindowId } from '../domain.js';
import { errorMessage, isRecord } from '../validation.js';
import {
  BrowserReferenceStorage,
  InMemoryReferenceStorage,
  type StorageMigration,
} from './storage-schema.js';

type WindowSessions = Record<string, TabSetId>;
type WindowSessionOperation = 'get' | 'set' | 'clear' | 'clear all' | 'clean closed';

interface WindowSessionDocument {
  windowSessions: WindowSessions;
}

interface ReferenceStorage {
  read(): Promise<unknown>;
  write(document: WindowSessionDocument): Promise<void>;
  runExclusive<T>(operation: () => Promise<T>): Promise<T>;
}

interface WindowSessionStorage {
  readAll(): Promise<WindowSessions>;
  writeAll(sessions: WindowSessions): Promise<void>;
  clearAll(): Promise<void>;
  runExclusive<T>(operation: () => Promise<T>): Promise<T>;
}


const DEFAULT_REFERENCE_MIGRATION: StorageMigration = {
  ensureMigrated: async () => undefined,
};

function isReferenceStorage(value: unknown): value is ReferenceStorage {
  if (
    (typeof value !== 'object' || value === null)
    && typeof value !== 'function'
  ) {
    return false;
  }

  return (
    'read' in value
    && typeof value.read === 'function'
    && 'write' in value
    && typeof value.write === 'function'
    && 'runExclusive' in value
    && typeof value.runExclusive === 'function'
  );
}

function isWindowSessions(value: unknown): value is WindowSessions {
  return (
    isRecord(value)
    && Object.values(value).every((setId) => typeof setId === 'string')
  );
}

function isWindowSessionDocument(
  value: unknown,
): value is WindowSessionDocument {
  return (
    isRecord(value)
    && isWindowSessions(value['windowSessions'])
  );
}

function validateWindowSessionDocument(value: unknown): WindowSessionDocument {
  if (!isWindowSessionDocument(value)) {
    throw new TypeError('Invalid window session storage document');
  }

  return value;
}

function sessionError(
  operation: WindowSessionOperation,
  identity: WindowId | 'all',
  cause: unknown,
): Error {
  return new Error(
    `Failed to ${operation} window session for window "${identity}": ${errorMessage(cause)}`,
    { cause },
  );
}

export class WindowSessionRepository {
  #storage: WindowSessionStorage;

  constructor(storage: WindowSessionStorage) {
    this.#storage = storage;
  }

  async get(windowId: WindowId): Promise<TabSetId | null> {
    try {
      const sessions = await this.#storage.readAll();
      return sessions[windowId] ?? null;
    } catch (error) {
      throw sessionError('get', windowId, error);
    }
  }

  set(windowId: WindowId, setId: TabSetId): Promise<void> {
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

  clear(windowId: WindowId): Promise<void> {
    return this.#storage.runExclusive(() => this.#removeWindow(windowId, 'clear'));
  }

  clearAll(): Promise<void> {
    return this.#storage.runExclusive(async () => {
      try {
        await this.#storage.clearAll();
      } catch (error) {
        throw sessionError('clear all', 'all', error);
      }
    });
  }

  clearClosedWindow(windowId: WindowId): Promise<void> {
    return this.#storage.runExclusive(
      () => this.#removeWindow(windowId, 'clean closed'),
    );
  }

  clearSetReferences(setId: TabSetId): Promise<void> {
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
        throw new Error(
          `Failed to clear window sessions for tab set "${setId}": ${errorMessage(error)}`,
          { cause: error },
        );
      }
    });
  }

  async #removeWindow(
    windowId: WindowId,
    operation: 'clear' | 'clean closed',
  ): Promise<void> {
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

export class BrowserWindowSessionStorage implements WindowSessionStorage {
  #references: ReferenceStorage;
  #document: WindowSessionDocument | undefined;

  constructor(
    localStorageOrReferences: BrowserStorageArea | ReferenceStorage,
    migration: StorageMigration = DEFAULT_REFERENCE_MIGRATION,
  ) {
    this.#references = isReferenceStorage(localStorageOrReferences)
      ? localStorageOrReferences
      : new BrowserReferenceStorage(localStorageOrReferences, migration);
  }

  runExclusive<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.#references.runExclusive(async () => {
      this.#document = validateWindowSessionDocument(
        await this.#references.read(),
      );

      try {
        return await operation();
      } finally {
        this.#document = undefined;
      }
    });
  }

  async readAll(): Promise<WindowSessions> {
    const document = this.#document
      ?? validateWindowSessionDocument(await this.#references.read());

    return { ...document.windowSessions };
  }

  async writeAll(sessions: WindowSessions): Promise<void> {
    const document = this.#document
      ?? validateWindowSessionDocument(await this.#references.read());

    document.windowSessions = { ...sessions };
    await this.#references.write(document);
  }

  async clearAll(): Promise<void> {
    const document = this.#document
      ?? validateWindowSessionDocument(await this.#references.read());

    document.windowSessions = {};
    await this.#references.write(document);
  }
}

export class InMemoryWindowSessionStorage extends BrowserWindowSessionStorage {
  constructor(references: ReferenceStorage = new InMemoryReferenceStorage()) {
    super(references);
  }
}