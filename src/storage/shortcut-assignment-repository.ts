/** Provides persistence and transactional management for command shortcut assignments. */

import { errorMessage } from '../validation.js';

/** Maps command names to assigned tab set identifiers. */
type ShortcutAssignments = Record<string, string>;

/** Determines whether a tab set exists, synchronously or asynchronously. */
type HasSet = (setId: string) => boolean | Promise<boolean>;

/** Configures shortcut assignment validation. */
interface ShortcutAssignmentRepositoryOptions {
  /** Validates assigned tab set identifiers when provided. */
  hasSet?: HasSet;
}

/** Defines transactional storage for shortcut assignments. */
interface ShortcutAssignmentStore {
  /** Runs an operation with exclusive access to the stored assignments. */
  runExclusive<T>(operation: () => Promise<T>): Promise<T>;

  /** Reads a detached copy of all assignments. */
  readAll(): Promise<ShortcutAssignments>;

  /** Replaces all stored assignments. */
  writeAll(assignments: ShortcutAssignments): Promise<void>;
}

/** Defines the assignment data embedded in a reference document. */
interface ShortcutAssignmentDocument {
  shortcutAssignments: ShortcutAssignments;
}

/** Defines exclusive read and write access to a reference document. */
interface ReferenceDocumentStorage<Document extends ShortcutAssignmentDocument> {
  /** Runs an operation with exclusive access to the reference document. */
  runExclusive<T>(operation: () => Promise<T>): Promise<T>;

  /** Reads the current reference document. */
  read(): Promise<Document>;

  /** Persists the complete reference document. */
  write(document: Document): Promise<void>;
}

/** Wraps a storage failure with shortcut assignment operation context. */
function assignmentError(operation: string, cause: unknown): Error {
  return new Error(
    `Failed to ${operation} shortcut assignments: ${errorMessage(cause)}`,
    { cause },
  );
}

/** Manages validated command-to-tab-set assignments through transactional storage. */
export class ShortcutAssignmentRepository {
  readonly #storage: ShortcutAssignmentStore;
  readonly #hasSet: HasSet | undefined;

  /** Creates a repository backed by the supplied assignment store. */
  constructor(
    storage: ShortcutAssignmentStore,
    { hasSet }: ShortcutAssignmentRepositoryOptions = {},
  ) {
    this.#storage = storage;
    this.#hasSet = hasSet;
  }

  /** Lists all assignments and wraps storage failures with operation context. */
  async list(): Promise<ShortcutAssignments> {
    try {
      return await this.#storage.readAll();
    } catch (error) {
      throw assignmentError('list', error);
    }
  }

  /** Assigns a command or removes its assignment when no set identifier is given. */
  assign(command: string, setId?: string | null): Promise<void> {
    return this.#storage.runExclusive(async () => {
      try {
        if (
          setId
          && this.#hasSet
          && !(await this.#hasSet(setId))
        ) {
          throw new Error(`Tab set id "${setId}" does not exist`);
        }

        const assignments = await this.#storage.readAll();

        if (setId) assignments[command] = setId;
        else delete assignments[command];

        await this.#storage.writeAll(assignments);
      } catch (error) {
        throw assignmentError(`assign command "${command}"`, error);
      }
    });
  }

  /** Removes every assignment to a tab set and avoids writing when none exist. */
  clearSetReferences(setId: string): Promise<void> {
    return this.#storage.runExclusive(async () => {
      try {
        const assignments = await this.#storage.readAll();
        let changed = false;

        for (const [command, assignedSetId] of Object.entries(assignments)) {
          if (assignedSetId !== setId) continue;

          delete assignments[command];
          changed = true;
        }

        if (changed) await this.#storage.writeAll(assignments);
      } catch (error) {
        throw assignmentError(
          `clear references to tab set "${setId}" from`,
          error,
        );
      }
    });
  }
}

/** Adapts assignment data embedded in a reference document to assignment storage. */
export class ShortcutAssignmentStorage<
  Document extends ShortcutAssignmentDocument = ShortcutAssignmentDocument,
> implements ShortcutAssignmentStore {
  readonly #references: ReferenceDocumentStorage<Document>;
  #document: Document | undefined;

  /** Creates storage backed by a reference document provider. */
  constructor(references: ReferenceDocumentStorage<Document>) {
    this.#references = references;
  }

  /** Caches one document during an exclusive operation and always clears the cache. */
  runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    return this.#references.runExclusive(async () => {
      this.#document = await this.#references.read();

      try {
        return await operation();
      } finally {
        this.#document = undefined;
      }
    });
  }

  /** Reads assignments from the active document and returns a detached copy. */
  async readAll(): Promise<ShortcutAssignments> {
    const document = this.#document ?? await this.#references.read();
    return { ...document.shortcutAssignments };
  }

  /** Replaces assignments with a detached copy and persists the document. */
  async writeAll(assignments: ShortcutAssignments): Promise<void> {
    const document = this.#document ?? await this.#references.read();
    document.shortcutAssignments = { ...assignments };
    await this.#references.write(document);
  }
}