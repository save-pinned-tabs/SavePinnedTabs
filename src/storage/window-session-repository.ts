/**
 * Stores associations between browser windows and their active tab sets.
 */

import type { BrowserStorageArea } from '../browser-api.js';
import type { TabSetId, WindowId } from '../domain.js';
import { errorMessage, isRecord } from '../validation.js';
import {
  BrowserReferenceStorage,
  InMemoryReferenceStorage,
  type StorageMigration,
} from './storage-schema.js';

/** Maps window identifiers to their active tab set identifiers. */
type WindowSessions = Record<string, TabSetId>;

/** Identifies operations used when reporting session storage failures. */
type WindowSessionOperation = 'get' | 'set' | 'clear' | 'clear all' | 'clean closed';

/** Defines the persisted window session document. */
interface WindowSessionDocument {
  windowSessions: WindowSessions;
}

/** Provides serialized access to the shared reference document. */
interface ReferenceStorage {
  read(): Promise<unknown>;
  write(document: WindowSessionDocument): Promise<void>;
  runExclusive<T>(operation: () => Promise<T>): Promise<T>;
}

/** Provides atomic access to window session mappings. */
interface WindowSessionStorage {
  readAll(): Promise<WindowSessions>;
  writeAll(sessions: WindowSessions): Promise<void>;
  clearAll(): Promise<void>;
  runExclusive<T>(operation: () => Promise<T>): Promise<T>;
}


/** Skips migration when callers provide no migration strategy. */
const DEFAULT_REFERENCE_MIGRATION: StorageMigration = {
  ensureMigrated: async () => undefined,
};

/** Checks whether a value provides the required reference storage operations. */
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

/** Checks whether a value is a mapping of windows to tab set identifiers. */
function isWindowSessions(value: unknown): value is WindowSessions {
  return (
    isRecord(value)
    && Object.values(value).every((setId) => typeof setId === 'string')
  );
}

/** Checks whether a value is a valid persisted window session document. */
function isWindowSessionDocument(
  value: unknown,
): value is WindowSessionDocument {
  return (
    isRecord(value)
    && isWindowSessions(value['windowSessions'])
  );
}

/** Validates a persisted document and throws when its structure is invalid. */
function validateWindowSessionDocument(value: unknown): WindowSessionDocument {
  if (!isWindowSessionDocument(value)) {
    throw new TypeError('Invalid window session storage document');
  }

  return value;
}

/** Creates a contextual storage error while preserving the original cause. */
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

/** Manages active tab set associations for browser windows. */
export class WindowSessionRepository {
  #storage: WindowSessionStorage;

  /** Creates a repository backed by the provided session storage. */
  constructor(storage: WindowSessionStorage) {
    this.#storage = storage;
  }

  /** Gets the active tab set or returns null when the window has no association. */
  async get(windowId: WindowId): Promise<TabSetId | null> {
    try {
      const sessions = await this.#storage.readAll();
      return sessions[windowId] ?? null;
    } catch (error) {
      throw sessionError('get', windowId, error);
    }
  }

  /** Atomically associates a window with a tab set. */
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

  /** Atomically removes a window association if one exists. */
  clear(windowId: WindowId): Promise<void> {
    return this.#storage.runExclusive(() => this.#removeWindow(windowId, 'clear'));
  }

  /** Atomically removes every window association. */
  clearAll(): Promise<void> {
    return this.#storage.runExclusive(async () => {
      try {
        await this.#storage.clearAll();
      } catch (error) {
        throw sessionError('clear all', 'all', error);
      }
    });
  }

  /** Removes the association for a window that has closed. */
  clearClosedWindow(windowId: WindowId): Promise<void> {
    return this.#storage.runExclusive(
      () => this.#removeWindow(windowId, 'clean closed'),
    );
  }

  /** Atomically removes all window associations that reference a tab set. */
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

  /** Removes one window association and avoids writing when none exists. */
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

/** Persists window sessions within a shared browser reference document. */
export class BrowserWindowSessionStorage implements WindowSessionStorage {
  #references: ReferenceStorage;
  #document: WindowSessionDocument | undefined;

  /** Uses existing reference storage or adapts a browser storage area. */
  constructor(
    localStorageOrReferences: BrowserStorageArea | ReferenceStorage,
    migration: StorageMigration = DEFAULT_REFERENCE_MIGRATION,
  ) {
    this.#references = isReferenceStorage(localStorageOrReferences)
      ? localStorageOrReferences
      : new BrowserReferenceStorage(localStorageOrReferences, migration);
  }

  /** Runs an operation exclusively against one validated document snapshot. */
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

  /** Reads a defensive copy of all window session associations. */
  async readAll(): Promise<WindowSessions> {
    const document = this.#document
      ?? validateWindowSessionDocument(await this.#references.read());

    return { ...document.windowSessions };
  }

  /** Replaces all window session associations in the shared document. */
  async writeAll(sessions: WindowSessions): Promise<void> {
    const document = this.#document
      ?? validateWindowSessionDocument(await this.#references.read());

    document.windowSessions = { ...sessions };
    await this.#references.write(document);
  }

  /** Clears all associations while preserving the rest of the shared document. */
  async clearAll(): Promise<void> {
    const document = this.#document
      ?? validateWindowSessionDocument(await this.#references.read());

    document.windowSessions = {};
    await this.#references.write(document);
  }
}

/** Provides browser-compatible window session storage backed by memory. */
export class InMemoryWindowSessionStorage extends BrowserWindowSessionStorage {
  /** Creates storage with an optional in-memory reference store. */
  constructor(references: ReferenceStorage = new InMemoryReferenceStorage()) {
    super(references);
  }
}