function assignmentError(operation, cause) {
  return new Error(`Failed to ${operation} shortcut assignments: ${cause.message}`, { cause });
}

export class ShortcutAssignmentRepository {
  #storage;
  #hasSet;

  constructor(storage, { hasSet } = {}) {
    this.#storage = storage;
    this.#hasSet = hasSet;
  }

  async list() {
    try {
      return await this.#storage.readAll();
    } catch (error) {
      throw assignmentError('list', error);
    }
  }

  assign(command, setId) {
    return this.#storage.runExclusive(async () => {
      try {
        if (setId && this.#hasSet && !await this.#hasSet(setId)) {
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

  clearSetReferences(setId) {
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
        throw assignmentError(`clear references to tab set "${setId}" from`, error);
      }
    });
  }
}

export class ShortcutAssignmentStorage {
  #references;
  #document;

  constructor(references) {
    this.#references = references;
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
    return { ...document.shortcutAssignments };
  }

  async writeAll(assignments) {
    const document = this.#document ?? await this.#references.read();
    document.shortcutAssignments = { ...assignments };
    await this.#references.write(document);
  }
}
