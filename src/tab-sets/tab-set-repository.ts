/** Provides validated, transactional access to tab-set storage and related state. */

import type {
  AutoloadConfiguration,
  AutoloadScope,
  ExportDocument,
  TabSet,
  TabSetDraft,
  TabSetId,
  WindowId,
} from '../domain.js';
import {
  isAutoloadScope,
  isUuid,
  newSetId,
} from '../storage/storage-schema.js';
import {
  errorMessage,
  isRecord,
  isStringArray,
} from '../validation.js';
import {
  normalizeImportDocument,
  type TabSetImportDocument,
} from './tab-set-import.js';

/** Identifies the current exported document schema. */
const EXPORT_VERSION = 2;


/** Defines persistent tab-set operations and exclusive transaction support. */
interface TabSetStorage {
  /** Returns every persisted tab set. */
  list(): Promise<TabSet[]>;
  /** Returns tab sets and Autoload settings from one storage snapshot. */
  getPopupData(): Promise<{
    sets: TabSet[];
    autoload: AutoloadConfiguration;
  }>;

  /** Returns the matching set or null when it does not exist. */
  get(setId: TabSetId): Promise<TabSet | null>;

  /** Persists a complete tab set. */
  save(set: TabSet): Promise<void>;

  /** Restores a previous value or removes a newly created set. */
  restore(setId: TabSetId, previousSet: TabSet | null): Promise<void>;

  /** Deletes a persisted set. */
  remove(setId: TabSetId): Promise<void>;

  /** Returns all identifiers currently in use. */
  identities(): Promise<Set<TabSetId>>;

  /** Returns the persisted autoload configuration. */
  getAutoload(): Promise<AutoloadConfiguration>;

  /** Replaces the persisted autoload configuration. */
  setAutoload(configuration: AutoloadConfiguration): Promise<void>;

  /** Atomically imports sets and their resulting autoload configuration. */
  import(
    sets: TabSet[],
    configuration: AutoloadConfiguration,
  ): Promise<void>;

  /** Serializes an operation against other repository mutations. */
  runExclusive<Result>(operation: () => Promise<Result>): Promise<Result>;
}

/** Associates browser windows with their active tab sets. */
interface WindowSessions {
  /** Assigns a tab set to a window. */
  set(windowId: WindowId, setId: TabSetId): Promise<void> | void;

  /** Removes all window associations for a deleted set. */
  clearSetReferences(setId: TabSetId): Promise<void> | void;
}


/** Configures validation, related state collaborators, and ID generation. */
interface TabSetRepositoryOptions {
  /** Validates imported documents before normalization. */
  validateImport?: (
    document: unknown,
  ) => document is TabSetImportDocument;
  windowSessions?: WindowSessions;

  /** Supplies candidate UUIDs and may be called repeatedly on collisions. */
  createId?: () => string;
}

/** Creates a contextual repository error while preserving its cause. */
function tabSetError(
  operation: string,
  setId: string,
  cause: unknown,
): Error {
  return new Error(
    `Failed to ${operation} tab set "${setId}": ${errorMessage(cause)}`,
    { cause },
  );
}

/** Compares tab-set identity, metadata, and ordered tab contents. */
function tabSetsEqual(left: TabSet, right: TabSet): boolean {
  return left.id === right.id
    && left.name === right.name
    && left.tabs.length === right.tabs.length
    && left.tabs.every((url, index) => url === right.tabs[index]);
}

/** Validates a save payload and rejects malformed names, tabs, or IDs. */
function validateSetDraft(set: unknown): asserts set is TabSetDraft {
  if (set === null || typeof set !== 'object') {
    throw new TypeError('Tab set must be an object');
  }

  if (
    !('name' in set)
    || typeof set.name !== 'string'
    || set.name.length === 0
  ) {
    throw new TypeError('Tab set name must be a non-empty string');
  }

  if (!('tabs' in set) || !isStringArray(set.tabs)) {
    throw new TypeError('Tab set tabs must be an array of strings');
  }

  if (
    'id' in set
    && set.id !== undefined
    && (typeof set.id !== 'string' || !isUuid(set.id))
  ) {
    throw new TypeError(`Tab set id "${String(set.id)}" is not a UUID`);
  }
}


/** Validates the autoload scope and set identifier collection. */
function validateAutoload(
  configuration: unknown,
): asserts configuration is AutoloadConfiguration {
  const scope = isRecord(configuration)
    ? configuration.scope
    : undefined;

  if (!isRecord(configuration) || !isAutoloadScope(scope)) {
    throw new TypeError(
      `Unsupported Autoload scope "${String(scope)}"`,
    );
  }

  if (!isStringArray(configuration.setIds)) {
    throw new TypeError('Autoload setIds must be an array');
  }
  if (configuration.setIds.length > 1) {
    throw new TypeError('Autoload supports at most one tab set');
  }
}

/** Reads an import version, defaulting legacy documents to version 1. */
function importedVersion(document: unknown): unknown {
  if (!isRecord(document)) return null;
  return Object.hasOwn(document, 'version') ? document.version : 1;
}

/** Produces a stable identifier for save error messages. */
function draftIdentifier(set: unknown): string {
  if (!isRecord(set) || set.id === undefined || set.id === null) {
    return 'new';
  }

  return String(set.id);
}

/** Coordinates validated tab-set persistence and dependent state updates. */
export class TabSetRepository {
  readonly #storage: TabSetStorage;
  readonly #validateImport:
    | ((document: unknown) => document is TabSetImportDocument)
    | undefined;
  readonly #windowSessions: WindowSessions | undefined;
  readonly #createId: () => string;

  /** Creates a repository with optional validation and assignment collaborators. */
  constructor(
    storage: TabSetStorage,
    {
      validateImport,
      windowSessions,
      createId = newSetId,
    }: TabSetRepositoryOptions = {},
  ) {
    this.#storage = storage;
    this.#validateImport = validateImport;
    this.#windowSessions = windowSessions;
    this.#createId = createId;
  }
  /** Returns the popup data and wraps storage failures with repository context. */
  async getPopupData(): Promise<{
    sets: TabSet[];
    autoload: AutoloadConfiguration;
  }> {
    try {
      return await this.#storage.getPopupData();
    } catch (error) {
      throw tabSetError('load popup data for', 'all', error);
    }
  }

  /** Returns all sets and wraps storage failures with repository context. */
  async list(): Promise<TabSet[]> {
    try {
      return await this.#storage.list();
    } catch (error) {
      throw tabSetError('list', 'all', error);
    }
  }

  /** Returns a set when present and wraps storage failures with its ID. */
  async get(setId: TabSetId): Promise<TabSet | null> {
    try {
      return await this.#storage.get(setId);
    } catch (error) {
      throw tabSetError('get', setId, error);
    }
  }

  /** Validates and persists a draft under exclusive access. */
  save(set: unknown): Promise<TabSet> {
    return this.#storage.runExclusive(async () => {
      try {
        return await this.#persist(set);
      } catch (error) {
        throw tabSetError('save', draftIdentifier(set), error);
      }
    });
  }

  /** Persists a set and assigns it to a window, rolling back on assignment failure. */
  saveForWindow(set: unknown, windowId: number): Promise<TabSet> {
    return this.#storage.runExclusive(async () => {
      let savedSet: TabSet | undefined;
      let previousSet: TabSet | null = null;

      try {
        if (
          isRecord(set)
          && typeof set.id === 'string'
          && set.id.length > 0
        ) {
          previousSet = await this.#storage.get(set.id) ?? null;
        }

        savedSet = await this.#persist(set);

        if (this.#windowSessions === undefined) {
          throw new TypeError(
            'Window sessions collaborator is unavailable',
          );
        }

        await this.#windowSessions.set(windowId, savedSet.id);
        return savedSet;
      } catch (error) {
        let rollbackContext = '';

        if (savedSet !== undefined) {
          try {
            await this.#storage.restore(savedSet.id, previousSet);
          } catch (rollbackError) {
            rollbackContext =
              `; rollback also failed: ${errorMessage(rollbackError)}`;
          }
        }

        throw new Error(
          `Failed to save tab set "${draftIdentifier(set)}" for window "${windowId}": ${errorMessage(error)}${rollbackContext}`,
          { cause: error },
        );
      }
    });
  }

  /** Assigns a set only when its persisted value still matches the expected snapshot. */
  activateWindowSession(
    setId: string,
    expectedSet: TabSet,
    windowId: number,
  ): Promise<boolean> {
    return this.#storage.runExclusive(async () => {
      try {
        const currentSet = await this.#storage.get(setId);

        if (
          !currentSet
          || !tabSetsEqual(currentSet, expectedSet)
        ) {
          return false;
        }

        if (this.#windowSessions === undefined) {
          throw new TypeError(
            'Window sessions collaborator is unavailable',
          );
        }

        await this.#windowSessions.set(windowId, setId);
        return true;
      } catch (error) {
        throw new Error(
          `Failed to activate tab set "${setId}" for window "${windowId}": ${errorMessage(error)}`,
          { cause: error },
        );
      }
    });
  }

  /** Returns the current autoload configuration with contextual error handling. */
  async getAutoload(): Promise<AutoloadConfiguration> {
    try {
      return await this.#storage.getAutoload();
    } catch (error) {
      throw tabSetError('get autoload for', 'all', error);
    }
  }

  /** Validates, deduplicates, and persists references to existing sets only. */
  setAutoload(configuration: unknown): Promise<void> {
    return this.#storage.runExclusive(async () => {
      try {
        validateAutoload(configuration);

        const uniqueSetIds = [...new Set(configuration.setIds)];
        const knownIds = new Set(
          (await this.#storage.list()).map((set) => set.id),
        );
        const staleId = uniqueSetIds.find(
          (setId) => !knownIds.has(setId),
        );

        if (staleId !== undefined) {
          throw new Error(`Tab set id "${staleId}" does not exist`);
        }

        await this.#storage.setAutoload({
          scope: configuration.scope,
          setIds: uniqueSetIds,
        });
      } catch (error) {
        throw tabSetError(
          'set autoload for',
          'configuration',
          error,
        );
      }
    });
  }

  /** Deletes a set and clears its window references. */
  remove(setId: string): Promise<void> {
    return this.#storage.runExclusive(async () => {
      try {
        await this.#storage.remove(setId);
        await this.#windowSessions?.clearSetReferences(setId);
      } catch (error) {
        throw tabSetError('remove', setId, error);
      }
    });
  }

  /** Builds a versioned export from the current sets and autoload configuration. */
  async export(): Promise<ExportDocument> {
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

  /** Validates and imports a supported document while remapping conflicting IDs. */
  import(document: unknown): Promise<TabSet[]> {
    return this.#storage.runExclusive(async () => {
      try {
        const version = importedVersion(document);

        if (version !== 1 && version !== EXPORT_VERSION) {
          throw new TypeError(
            `Unsupported tab-set document version "${String(version)}". Supported versions are 1 and ${EXPORT_VERSION}`,
          );
        }

        if (
          this.#validateImport === undefined
          || !this.#validateImport(document)
        ) {
          throw new TypeError('Import validation failed');
        }

        const normalized = normalizeImportDocument(document);
        const identities = await this.#storage.identities();
        const imported: TabSet[] = [];
        const importedAutoloadIds: string[] = [];
        const importedIdBySource = new Map<TabSetId, TabSetId>();

        for (const set of normalized.sets) {
          const id = set.sourceId !== null && !identities.has(set.sourceId)
            ? set.sourceId
            : this.#newId(identities);
          identities.add(id);
          imported.push({ id, name: set.name, tabs: [...set.tabs] });
          if (set.sourceId !== null) importedIdBySource.set(set.sourceId, id);
          if (set.isAutoload) importedAutoloadIds.push(id);
        }
        for (const sourceId of normalized.autoloadSourceIds) {
          const importedId = importedIdBySource.get(sourceId);
          if (importedId !== undefined) importedAutoloadIds.push(importedId);
        }

        const currentAutoload = await this.#storage.getAutoload();

        const selectedSetId =
          currentAutoload.setIds[0] ?? importedAutoloadIds[0];
        await this.#storage.import(imported, {
          scope: normalized.scope ?? currentAutoload.scope,
          setIds: selectedSetId === undefined ? [] : [selectedSetId],
        });

        return imported;
      } catch (error) {
        throw tabSetError('import', 'import payload', error);
      }
    });
  }

  /** Validates a draft, creates an ID when needed, and persists the result. */
  async #persist(set: unknown): Promise<TabSet> {
    validateSetDraft(set);

    const savedSet: TabSet = {
      ...set,
      id: set.id ?? this.#newId(await this.#storage.identities()),
    };

    if (
      set.id !== undefined
      && !await this.#storage.get(set.id)
    ) {
      throw new Error(
        `Tab set id "${set.id}" does not exist and cannot be reused`,
      );
    }

    await this.#storage.save(savedSet);
    return savedSet;
  }

  /** Generates candidates until it finds a valid UUID not already reserved. */
  #newId(identities: Set<string>): string {
    while (true) {
      const id = this.#createId();

      if (isUuid(id) && !identities.has(id)) {
        identities.add(id);
        return id;
      }
    }
  }
}