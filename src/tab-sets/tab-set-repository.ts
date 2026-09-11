import type { TabSet } from '../domain.js';
import {
  AUTOLOAD_SCOPES,
  isUuid,
  newSetId,
} from '../storage/storage-schema.js';

const EXPORT_VERSION = 2;

type AutoloadScope =
  typeof AUTOLOAD_SCOPES extends ReadonlySet<infer Scope extends string>
    ? Scope
    : string;

interface TabSetDraft {
  id?: string;
  name: string;
  tabs: string[];
}

interface AutoloadConfiguration {
  scope: AutoloadScope;
  setIds: string[];
}

interface LegacyTabSet {
  set_name: string;
  tabs: string[];
  autoload?: unknown;
}

interface TabSetStorage {
  list(): Promise<TabSet[]>;
  get(setId: string): Promise<TabSet | null>;
  save(set: TabSet): Promise<void>;
  restore(setId: string, previousSet: TabSet | null): Promise<void>;
  remove(setId: string): Promise<void>;
  identities(): Promise<Set<string>>;
  getAutoload(): Promise<AutoloadConfiguration>;
  setAutoload(configuration: AutoloadConfiguration): Promise<void>;
  import(
    sets: TabSet[],
    configuration: AutoloadConfiguration,
  ): Promise<void>;
  runExclusive<Result>(operation: () => Promise<Result>): Promise<Result>;
}

interface WindowSessions {
  set(windowId: number, setId: string): Promise<void> | void;
  clearSetReferences(setId: string): Promise<void> | void;
}

interface ShortcutAssignments {
  clearSetReferences(setId: string): Promise<void> | void;
}

interface TabSetRepositoryOptions {
  validateImport?: (document: unknown) => boolean;
  windowSessions?: WindowSessions;
  shortcutAssignments?: ShortcutAssignments;
  createId?: () => unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.every((item: unknown) => typeof item === 'string');
}

function isUnknownSet(value: unknown): value is Set<unknown> {
  return value instanceof Set;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (isRecord(error) && typeof error.message === 'string') {
    return error.message;
  }
  return String(error);
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

function validateStoredSet(set: unknown): asserts set is TabSet {
  validateSetDraft(set);

  if (set.id === undefined) {
    throw new TypeError('Stored tab set must have an id');
  }
}

function validateStoredSets(sets: unknown): asserts sets is TabSet[] {
  if (!Array.isArray(sets)) {
    throw new TypeError('Stored tab sets must be an array');
  }

  for (const set of sets) {
    validateStoredSet(set);
  }
}

function isAutoloadScope(value: unknown): value is AutoloadScope {
  if (typeof value !== 'string') return false;

  for (const scope of AUTOLOAD_SCOPES) {
    if (scope === value) return true;
  }

  return false;
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

function validateIdentities(
  identities: unknown,
): asserts identities is Set<string> {
  if (!isUnknownSet(identities)) {
    throw new TypeError('Tab set identities must be a Set');
  }

  for (const identity of identities) {
    if (typeof identity !== 'string') {
      throw new TypeError(
        'Tab set identities must contain only strings',
      );
    }
  }
}

function validateLegacySet(set: unknown): asserts set is LegacyTabSet {
  if (!isRecord(set)) {
    throw new TypeError('Legacy tab set must be an object');
  }

  if (typeof set.set_name !== 'string') {
    throw new TypeError('Legacy tab set name must be a string');
  }

  if (!isStringArray(set.tabs)) {
    throw new TypeError(
      'Legacy tab set tabs must be an array of strings',
    );
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
    | ((document: unknown) => boolean)
    | undefined;
  readonly #windowSessions: WindowSessions | undefined;
  readonly #shortcutAssignments: ShortcutAssignments | undefined;
  readonly #createId: () => unknown;

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
      return await this.#readStoredSets();
    } catch (error) {
      throw tabSetError('list', 'all', error);
    }
  }

  async get(setId: string): Promise<TabSet | null | undefined> {
    try {
      return await this.#readStoredSet(setId);
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
          previousSet = await this.#readStoredSet(set.id) ?? null;
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
        const currentSet = await this.#readStoredSet(setId);

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
      return await this.#readAutoload();
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
          (await this.#readStoredSets()).map((set) => set.id),
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

  async export(): Promise<{
    version: number;
    sets: TabSet[];
    autoload: AutoloadConfiguration;
  }> {
    try {
      return {
        version: EXPORT_VERSION,
        sets: await this.#readStoredSets(),
        autoload: await this.#readAutoload(),
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

        if (!isRecord(document)) {
          throw new TypeError('Import validation failed');
        }

        const identities = await this.#readIdentities();
        const imported: TabSet[] = [];
        const importedAutoloadIds: string[] = [];
        let importedScope: AutoloadScope | undefined;

        if (version === EXPORT_VERSION) {
          const setsValue = document.sets;

          if (!Array.isArray(setsValue)) {
            throw new TypeError('Import validation failed');
          }

          validateAutoload(document.autoload);
          importedScope = document.autoload.scope;

          const documentSets: unknown[] = setsValue;
          const idMap = new Map<string, string>();

          for (const set of documentSets) {
            validateStoredSet(set);

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
          const legacySetsValue = document.version === 1
            ? document.sets
            : document;

          if (!isRecord(legacySetsValue)) {
            throw new TypeError('Import validation failed');
          }

          for (const set of Object.values(legacySetsValue)) {
            validateLegacySet(set);

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

        const currentAutoload = await this.#readAutoload();

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
      id: set.id ?? this.#newId(await this.#readIdentities()),
    };

    if (
      set.id !== undefined
      && !await this.#readStoredSet(set.id)
    ) {
      throw new Error(
        `Tab set id "${set.id}" does not exist and cannot be reused`,
      );
    }

    await this.#storage.save(savedSet);
    return savedSet;
  }

  async #readStoredSets(): Promise<TabSet[]> {
    return this.#storage.list();
  }

  async #readStoredSet(
    setId: string,
  ): Promise<TabSet | null> {
    return this.#storage.get(setId);
  }

  async #readAutoload(): Promise<AutoloadConfiguration> {
    return this.#storage.getAutoload();
  }

  async #readIdentities(): Promise<Set<string>> {
    const identities = await this.#storage.identities();
    validateIdentities(identities);
    return identities;
  }

  #newId(identities: Set<string>): string {
    while (true) {
      const id = this.#createId();

      if (
        typeof id === 'string'
        && isUuid(id)
        && !identities.has(id)
      ) {
        identities.add(id);
        return id;
      }
    }
  }
}