import { BrowserReferenceStorage, InMemoryReferenceStorage } from './storage-schema.js';

type WindowId = number;
type SetId = string;
type WindowSessions = Record<string, SetId>;
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

type BrowserStorageSource = ConstructorParameters<typeof BrowserReferenceStorage>[0];
type ReferenceMigration = NonNullable<
  ConstructorParameters<typeof BrowserReferenceStorage>[1]
>;

const DEFAULT_REFERENCE_MIGRATION: ReferenceMigration = {
  ensureMigrated: async () => undefined,
};

function getErrorMessage(error: unknown): string {
  if (
    ((typeof error === 'object' && error !== null) || typeof error === 'function')
    && 'message' in error
  ) {
    return String(error.message);
  }

  return String(error);
}

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

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isWindowSessions(value: unknown): value is WindowSessions {
  return (
    isUnknownRecord(value)
    && Object.values(value).every((setId) => typeof setId === 'string')
  );
}

function isWindowSessionDocument(
  value: unknown,
): value is WindowSessionDocument {
  return (
    isUnknownRecord(value)
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
    `Failed to ${operation} window session for window "${identity}": ${getErrorMessage(cause)}`,
    { cause },
  );
}

export class WindowSessionRepository {
  #storage: WindowSessionStorage;

  constructor(storage: WindowSessionStorage) {
    this.#storage = storage;
  }

  async get(windowId: WindowId): Promise<SetId | null> {
    try {
      const sessions = await this.#storage.readAll();
      return sessions[windowId] ?? null;
    } catch (error) {
      throw sessionError('get', windowId, error);
    }
  }

  set(windowId: WindowId, setId: SetId): Promise<void> {
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

  clearSetReferences(setId: SetId): Promise<void> {
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
          `Failed to clear window sessions for tab set "${setId}": ${getErrorMessage(error)}`,
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
    localStorageOrReferences: BrowserStorageSource | ReferenceStorage,
    migration: ReferenceMigration = DEFAULT_REFERENCE_MIGRATION,
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