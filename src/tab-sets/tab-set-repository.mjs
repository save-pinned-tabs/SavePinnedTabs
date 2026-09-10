import {
  AUTOLOAD_SCOPES,
  isUuid,
  newSetId,
} from '../storage/storage-schema.mjs';

const EXPORT_VERSION = 2;

function tabSetError(operation, setId, cause) {
  return new Error(`Failed to ${operation} tab set "${setId}": ${cause.message}`, { cause });
}

function tabSetsEqual(left, right) {
  return left.id === right.id
    && left.name === right.name
    && left.tabs.length === right.tabs.length
    && left.tabs.every((url, index) => url === right.tabs[index]);
}

function validateSetDraft(set) {
  if (!set || typeof set !== 'object') throw new TypeError('Tab set must be an object');
  if (typeof set.name !== 'string' || set.name.length === 0) {
    throw new TypeError('Tab set name must be a non-empty string');
  }
  if (!Array.isArray(set.tabs) || !set.tabs.every((url) => typeof url === 'string')) {
    throw new TypeError('Tab set tabs must be an array of strings');
  }
  if (set.id !== undefined && !isUuid(set.id)) {
    throw new TypeError(`Tab set id "${set.id}" is not a UUID`);
  }
}

function validateAutoload(configuration) {
  if (!configuration || !AUTOLOAD_SCOPES.has(configuration.scope)) {
    throw new TypeError(`Unsupported Autoload scope "${configuration?.scope}"`);
  }
  if (!Array.isArray(configuration.setIds)) {
    throw new TypeError('Autoload setIds must be an array');
  }
}

function importedVersion(document) {
  if (!document || typeof document !== 'object' || Array.isArray(document)) return null;
  return Object.hasOwn(document, 'version') ? document.version : 1;
}

function legacySets(document) {
  return document.version === 1 ? document.sets : document;
}

export class TabSetRepository {
  #storage;
  #validateImport;
  #windowSessions;
  #shortcutAssignments;
  #createId;

  constructor(storage, {
    validateImport,
    windowSessions,
    shortcutAssignments,
    createId = newSetId,
  } = {}) {
    this.#storage = storage;
    this.#validateImport = validateImport;
    this.#windowSessions = windowSessions;
    this.#shortcutAssignments = shortcutAssignments;
    this.#createId = createId;
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

  save(set) {
    return this.#storage.runExclusive(async () => {
      try {
        return await this.#persist(set);
      } catch (error) {
        throw tabSetError('save', set?.id ?? 'new', error);
      }
    });
  }

  saveForWindow(set, windowId) {
    return this.#storage.runExclusive(async () => {
      let savedSet;
      let previousSet = null;
      try {
        if (set?.id) previousSet = await this.#storage.get(set.id);
        savedSet = await this.#persist(set);
        await this.#windowSessions.set(windowId, savedSet.id);
        return savedSet;
      } catch (error) {
        let rollbackContext = '';
        if (savedSet) {
          try {
            await this.#storage.restore(savedSet.id, previousSet);
          } catch (rollbackError) {
            rollbackContext = `; rollback also failed: ${rollbackError.message}`;
          }
        }
        throw new Error(
          `Failed to save tab set "${set?.id ?? 'new'}" for window "${windowId}": ${error.message}${rollbackContext}`,
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

  async getAutoload() {
    try {
      return await this.#storage.getAutoload();
    } catch (error) {
      throw tabSetError('get autoload for', 'all', error);
    }
  }

  setAutoload(configuration) {
    return this.#storage.runExclusive(async () => {
      try {
        validateAutoload(configuration);
        const uniqueSetIds = [...new Set(configuration.setIds)];
        const knownIds = new Set((await this.#storage.list()).map((set) => set.id));
        const staleId = uniqueSetIds.find((setId) => !knownIds.has(setId));
        if (staleId) throw new Error(`Tab set id "${staleId}" does not exist`);
        await this.#storage.setAutoload({
          scope: configuration.scope,
          setIds: uniqueSetIds,
        });
      } catch (error) {
        throw tabSetError('set autoload for', 'configuration', error);
      }
    });
  }

  remove(setId) {
    return this.#storage.runExclusive(async () => {
      try {
        await this.#storage.remove(setId);
        await this.#windowSessions?.clearSetReferences(setId);
        await this.#shortcutAssignments?.clearSetReferences(setId);
      } catch (error) {
        throw tabSetError('remove', setId, error);
      }
    });
  }

  async export() {
    try {
      return {
        version: EXPORT_VERSION,
        sets: await this.#storage.list(),
        autoload: await this.#storage.getAutoload(),
      };
    } catch (error) {
      throw tabSetError('export', 'all', error);
    }
  }

  import(document) {
    return this.#storage.runExclusive(async () => {
      try {
        const version = importedVersion(document);
        if (![1, EXPORT_VERSION].includes(version)) {
          throw new TypeError(
            `Unsupported tab-set document version "${String(version)}". Supported versions are 1 and ${EXPORT_VERSION}`,
          );
        }
        if (!this.#validateImport?.(document)) throw new TypeError('Import validation failed');

        const identities = await this.#storage.identities();
        const imported = [];
        const importedAutoloadIds = [];
        if (version === EXPORT_VERSION) {
          for (const set of document.sets) {
            validateSetDraft(set);
            const id = identities.has(set.id) ? this.#newId(identities) : set.id;
            identities.add(id);
            imported.push({ ...set, id });
          }
          const idMap = new Map(document.sets.map((set, index) => [set.id, imported[index].id]));
          importedAutoloadIds.push(...document.autoload.setIds
            .map((id) => idMap.get(id))
            .filter(Boolean));
        } else {
          for (const set of Object.values(legacySets(document))) {
            const id = this.#newId(identities);
            imported.push({ id, name: set.set_name, tabs: [...set.tabs] });
            if (set.autoload === 1) importedAutoloadIds.push(id);
          }
        }

        const currentAutoload = await this.#storage.getAutoload();
        await this.#storage.import(imported, {
          scope: version === EXPORT_VERSION ? document.autoload.scope : currentAutoload.scope,
          setIds: [...new Set(currentAutoload.setIds.concat(importedAutoloadIds))],
        });
        return imported;
      } catch (error) {
        throw tabSetError('import', 'import payload', error);
      }
    });
  }

  async #persist(set) {
    validateSetDraft(set);
    const savedSet = {
      ...set,
      id: set.id ?? this.#newId(await this.#storage.identities()),
    };
    if (set.id && !await this.#storage.get(set.id)) {
      throw new Error(`Tab set id "${set.id}" does not exist and cannot be reused`);
    }
    await this.#storage.save(savedSet);
    return savedSet;
  }

  #newId(identities) {
    let id;
    do id = this.#createId(); while (!isUuid(id) || identities.has(id));
    identities.add(id);
    return id;
  }
}


