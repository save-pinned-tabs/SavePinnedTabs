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

const EXPORT_VERSION = 2;

interface LegacyTabSet {
  set_name: string;
  tabs: string[];
  autoload?: 0 | 1;
}

interface VersionedTabSetDocument {
  version: 2;
  sets: TabSet[];
  autoload: AutoloadConfiguration;
}

interface VersionedLegacyDocument {
  version: 1;
  sets: Record<string, LegacyTabSet>;
}

export type TabSetImportDocument =
  | VersionedTabSetDocument
  | VersionedLegacyDocument
  | Record<string, LegacyTabSet>;

function isVersionedTabSetDocument(
  document: TabSetImportDocument,
): document is VersionedTabSetDocument {
  return 'version' in document && document.version === EXPORT_VERSION;
}

function isVersionedLegacyDocument(
  document: TabSetImportDocument,
): document is VersionedLegacyDocument {
  return 'version' in document && document.version === 1;
}

interface TabSetStorage {
  list(): Promise<TabSet[]>;
  get(setId: TabSetId): Promise<TabSet | null>;
  save(set: TabSet): Promise<void>;
  restore(setId: TabSetId, previousSet: TabSet | null): Promise<void>;
  remove(setId: TabSetId): Promise<void>;
  identities(): Promise<Set<TabSetId>>;
  getAutoload(): Promise<AutoloadConfiguration>;
  setAutoload(configuration: AutoloadConfiguration): Promise<void>;
  import(
    sets: TabSet[],
    configuration: AutoloadConfiguration,
  ): Promise<void>;
  runExclusive<Result>(operation: () => Promise<Result>): Promise<Result>;
}

interface WindowSessions {
  set(windowId: WindowId, setId: TabSetId): Promise<void> | void;
  clearSetReferences(setId: TabSetId): Promise<void> | void;
}

interface ShortcutAssignments {
  clearSetReferences(setId: TabSetId): Promise<void> | void;
}

interface TabSetRepositoryOptions {
  validateImport?: (
    document: unknown,
  ) => document is TabSetImportDocument;
  windowSessions?: WindowSessions;
  shortcutAssignments?: ShortcutAssignments;
  createId?: () => string;
}

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

function tabSetsEqual(left: TabSet, right: TabSet): boolean {
  return left.id === right.id
    && left.name === right.name
    && left.tabs.length === right.tabs.length
    && left.tabs.every((url, index) => url === right.tabs[index]);
}

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
}

function importedVersion(document: unknown): unknown {
  if (!isRecord(document)) return null;
  return Object.hasOwn(document, 'version') ? document.version : 1;
}

function draftIdentifier(set: unknown): string {
  if (!isRecord(set) || set.id === undefined || set.id === null) {
    return 'new';
  }

  return String(set.id);
}

export class TabSetRepository {
  readonly #storage: TabSetStorage;
  readonly #validateImport:
    | ((document: unknown) => document is TabSetImportDocument)
    | undefined;
  readonly #windowSessions: WindowSessions | undefined;
  readonly #shortcutAssignments: ShortcutAssignments | undefined;
  readonly #createId: () => string;

  constructor(
    storage: TabSetStorage,
    {
      validateImport,
      windowSessions,
      shortcutAssignments,
      createId = newSetId,
    }: TabSetRepositoryOptions = {},
  ) {
    this.#storage = storage;
    this.#validateImport = validateImport;
    this.#windowSessions = windowSessions;
    this.#shortcutAssignments = shortcutAssignments;
    this.#createId = createId;
  }

  async list(): Promise<TabSet[]> {
    try {
      return await this.#storage.list();
    } catch (error) {
      throw tabSetError('list', 'all', error);
    }
  }

  async get(setId: TabSetId): Promise<TabSet | null> {
    try {
      return await this.#storage.get(setId);
    } catch (error) {
      throw tabSetError('get', setId, error);
    }
  }

  save(set: unknown): Promise<TabSet> {
    return this.#storage.runExclusive(async () => {
      try {
        return await this.#persist(set);
      } catch (error) {
        throw tabSetError('save', draftIdentifier(set), error);
      }
    });
  }

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

  async getAutoload(): Promise<AutoloadConfiguration> {
    try {
      return await this.#storage.getAutoload();
    } catch (error) {
      throw tabSetError('get autoload for', 'all', error);
    }
  }

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

  remove(setId: string): Promise<void> {
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

        const identities = await this.#storage.identities();
        const imported: TabSet[] = [];
        const importedAutoloadIds: string[] = [];
        let importedScope: AutoloadScope | undefined;

        if (isVersionedTabSetDocument(document)) {
          importedScope = document.autoload.scope;

          const idMap = new Map<string, string>();

          for (const set of document.sets) {
            const id = identities.has(set.id)
              ? this.#newId(identities)
              : set.id;

            identities.add(id);
            imported.push({ ...set, id });
            idMap.set(set.id, id);
          }

          for (const sourceId of document.autoload.setIds) {
            const importedId = idMap.get(sourceId);

            if (importedId !== undefined) {
              importedAutoloadIds.push(importedId);
            }
          }
        } else {
          const legacySets = isVersionedLegacyDocument(document)
            ? document.sets
            : document;

          for (const set of Object.values(legacySets)) {
            const id = this.#newId(identities);
            imported.push({
              id,
              name: set.set_name,
              tabs: [...set.tabs],
            });

            if (set.autoload === 1) {
              importedAutoloadIds.push(id);
            }
          }
        }

        const currentAutoload = await this.#storage.getAutoload();

        await this.#storage.import(imported, {
          scope: importedScope ?? currentAutoload.scope,
          setIds: [
            ...new Set([
              ...currentAutoload.setIds,
              ...importedAutoloadIds,
            ]),
          ],
        });

        return imported;
      } catch (error) {
        throw tabSetError('import', 'import payload', error);
      }
    });
  }

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