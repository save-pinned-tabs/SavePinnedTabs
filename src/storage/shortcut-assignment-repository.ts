import { errorMessage } from '../validation.js';

type ShortcutAssignments = Record<string, string>;

type HasSet = (setId: string) => boolean | Promise<boolean>;

interface ShortcutAssignmentRepositoryOptions {
  hasSet?: HasSet;
}

interface ShortcutAssignmentStore {
  runExclusive<T>(operation: () => Promise<T>): Promise<T>;
  readAll(): Promise<ShortcutAssignments>;
  writeAll(assignments: ShortcutAssignments): Promise<void>;
}

interface ShortcutAssignmentDocument {
  shortcutAssignments: ShortcutAssignments;
}

interface ReferenceDocumentStorage<Document extends ShortcutAssignmentDocument> {
  runExclusive<T>(operation: () => Promise<T>): Promise<T>;
  read(): Promise<Document>;
  write(document: Document): Promise<void>;
}

function assignmentError(operation: string, cause: unknown): Error {
  return new Error(
    `Failed to ${operation} shortcut assignments: ${errorMessage(cause)}`,
    { cause },
  );
}

export class ShortcutAssignmentRepository {
  readonly #storage: ShortcutAssignmentStore;
  readonly #hasSet: HasSet | undefined;

  constructor(
    storage: ShortcutAssignmentStore,
    { hasSet }: ShortcutAssignmentRepositoryOptions = {},
  ) {
    this.#storage = storage;
    this.#hasSet = hasSet;
  }

  async list(): Promise<ShortcutAssignments> {
    try {
      return await this.#storage.readAll();
    } catch (error) {
      throw assignmentError('list', error);
    }
  }

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

export class ShortcutAssignmentStorage<
  Document extends ShortcutAssignmentDocument = ShortcutAssignmentDocument,
> implements ShortcutAssignmentStore {
  readonly #references: ReferenceDocumentStorage<Document>;
  #document: Document | undefined;

  constructor(references: ReferenceDocumentStorage<Document>) {
    this.#references = references;
  }

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

  async readAll(): Promise<ShortcutAssignments> {
    const document = this.#document ?? await this.#references.read();
    return { ...document.shortcutAssignments };
  }

  async writeAll(assignments: ShortcutAssignments): Promise<void> {
    const document = this.#document ?? await this.#references.read();
    document.shortcutAssignments = { ...assignments };
    await this.#references.write(document);
  }
}