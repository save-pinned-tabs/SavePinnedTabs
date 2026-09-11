import { createBrowserRepositories } from './browser-repositories.js';
import { createSerializedStorageOperation } from './serialized-operation.js';

const ALL_WINDOWS_LOCK = 'save-pinned-tabs:all-window-tabs';
const WINDOW_LOCK_PREFIX = 'save-pinned-tabs:window-tabs:';
const WINDOW_TAB_STATE_ERROR = Symbol('windowTabStateError');
const WINDOW_TAB_STATE_MESSAGE = 'save-pinned-tabs:window-tab-state';

type RepositoryBrowser = Parameters<typeof createBrowserRepositories>[0];
type RepositoryCollection = ReturnType<typeof createBrowserRepositories>;
type RepositoryTabSets = RepositoryCollection['tabSets'];
type StoredTabSet = NonNullable<
  Parameters<RepositoryTabSets['activateWindowSession']>[1]
>;
type SetId = Parameters<RepositoryTabSets['get']>[0];
type SaveableTabSet = Parameters<RepositoryTabSets['saveForWindow']>[0];
type CapturableTabSet = SaveableTabSet & object;
type SavedTabSet = Awaited<ReturnType<RepositoryTabSets['saveForWindow']>>;
type StorageArea = Parameters<typeof createSerializedStorageOperation>[0];

type WindowTabStateOperation =
  | 'snapshot'
  | 'replace'
  | 'append'
  | 'unload'
  | 'captureAndSave';

interface BrowserTabQuery {
  pinned: boolean;
  windowId: number;
}

interface BrowserTabCreateProperties {
  windowId: number;
  url: string;
  active: boolean;
}

interface BrowserTabUpdateProperties {
  pinned: boolean;
}

interface BrowserTabsApi {
  query(query: BrowserTabQuery): Promise<unknown>;
  create(properties: BrowserTabCreateProperties): Promise<unknown>;
  update(tabId: number, properties: BrowserTabUpdateProperties): Promise<unknown>;
  remove(tabIds: number[]): Promise<unknown>;
}

interface WindowTabStateMessage {
  type: typeof WINDOW_TAB_STATE_MESSAGE;
  operation: WindowTabStateOperation;
  args: unknown[];
}

interface BrowserRuntimeApi {
  sendMessage(message: WindowTabStateMessage): Promise<unknown>;
  onMessage: {
    addListener(
      listener: (message: unknown) => Promise<unknown> | undefined,
    ): void;
  };
}

type BrowserApi = {
  tabs: BrowserTabsApi;
  storage: {
    local: StorageArea;
  };
  runtime: BrowserRuntimeApi;
} & RepositoryBrowser;

interface PinnedTab {
  id: number;
  index: number;
  url: string;
}

interface PinnedTabs {
  queryPinned(windowId: number): Promise<PinnedTab[]>;
  create(windowId: number, url: string): Promise<number>;
  pin(tabId: number, windowId: number, url: string): Promise<void>;
  remove(tabIds: number[], windowId: number, purpose: string): Promise<void>;
}

interface TabSetStore {
  get(setId: SetId): Promise<unknown>;
  saveForWindow(set: SaveableTabSet, windowId: number): Promise<SavedTabSet>;
  activateWindowSession(
    setId: SetId,
    set: StoredTabSet,
    windowId: number,
  ): Promise<unknown>;
}

interface WindowSessionStore {
  clear(windowId: number): Promise<unknown>;
  clearAll(): Promise<unknown>;
}

interface WindowTabStateDependencies {
  tabs: PinnedTabs;
  tabSets: TabSetStore;
  windowSessions: WindowSessionStore;
  runTransition: <Result>(
    windowId: number,
    operation: () => Promise<Result>,
  ) => Promise<Result>;
  runAllExclusive: <Result>(
    operation: () => Promise<Result>,
  ) => Promise<Result>;
  onReplace?: (urls: string[]) => void;
}

interface BrowserWindowTabStateOptions {
  onReplace?: (urls: string[]) => void;
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === 'object' && value !== null;
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

function isSetId(value: unknown): value is SetId {
  return typeof value === 'string';
}

function isCapturableTabSet(value: unknown): value is CapturableTabSet {
  return isRecord(value);
}

function isStoredTabSet(value: unknown): value is StoredTabSet {
  return isRecord(value) && isUnknownArray(value.tabs);
}

function isSavedTabSet(value: unknown): value is SavedTabSet {
  return isRecord(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function displaySetId(set: unknown): string {
  if (!isRecord(set) || set.id === null || set.id === undefined) {
    return 'new';
  }
  return String(set.id);
}

function operationError(
  operation: string,
  windowId: number,
  cause: unknown,
  rollbackErrors: unknown[] = [],
): Error {
  const rollbackContext = rollbackErrors.length === 0
    ? ''
    : `; rollback also failed: ${rollbackErrors.map(errorMessage).join('; ')}`;
  const error = new Error(
    `Failed to ${operation} pinned tabs in window "${windowId}": ${errorMessage(cause)}${rollbackContext}`,
    { cause },
  );
  return Object.assign(error, { [WINDOW_TAB_STATE_ERROR]: true });
}

function isWindowTabStateError(error: unknown): boolean {
  return error instanceof Error
    && WINDOW_TAB_STATE_ERROR in error
    && error[WINDOW_TAB_STATE_ERROR] === true;
}

class PartialTabCreationError extends Error {
  readonly createdTabIds: number[];

  constructor(createdTabIds: number[], cause: unknown) {
    super(errorMessage(cause), { cause });
    this.createdTabIds = createdTabIds;
  }
}

export function normalizeUrl(url: unknown): string {
  if (typeof url !== 'string' || url.length === 0) {
    throw new TypeError('Pinned tab URL must be a non-empty string');
  }

  try {
    return new URL(url).href;
  } catch {
    return url;
  }
}

function effectiveUrl(tab: unknown): string {
  const pendingUrl = isRecord(tab) ? tab.pendingUrl : undefined;
  const url = isRecord(tab) ? tab.url : undefined;
  return normalizeUrl(pendingUrl || url);
}

function normalizeSavedUrls(urls: unknown): string[] {
  if (!isUnknownArray(urls)) {
    throw new TypeError('Pinned tab list must be an array');
  }
  return urls.map(normalizeUrl);
}

function storedTabUrls(set: StoredTabSet): string[] {
  if (!isRecord(set)) {
    throw new TypeError('Stored tab set must be an object');
  }
  return normalizeSavedUrls(set.tabs);
}

function urlsMatch(tabs: PinnedTab[], urls: string[]): boolean {
  return tabs.length === urls.length
    && tabs.every((tab, index) => tab.url === urls[index]);
}

function missingUrls(tabs: PinnedTab[], savedUrls: string[]): string[] {
  const existingMultiplicity = new Map<string, number>();
  for (const tab of tabs) {
    existingMultiplicity.set(
      tab.url,
      (existingMultiplicity.get(tab.url) ?? 0) + 1,
    );
  }

  return savedUrls.filter((url) => {
    const remaining = existingMultiplicity.get(url) ?? 0;
    if (remaining === 0) return true;
    existingMultiplicity.set(url, remaining - 1);
    return false;
  });
}

function matchingTabIds(tabs: PinnedTab[], savedUrls: string[]): number[] {
  const remainingMultiplicity = new Map<string, number>();
  for (const url of savedUrls) {
    remainingMultiplicity.set(
      url,
      (remainingMultiplicity.get(url) ?? 0) + 1,
    );
  }

  const tabIds: number[] = [];
  for (const tab of tabs) {
    const remaining = remainingMultiplicity.get(tab.url) ?? 0;
    if (remaining === 0) continue;
    remainingMultiplicity.set(tab.url, remaining - 1);
    tabIds.push(tab.id);
  }
  return tabIds;
}

function withTabs(
  set: CapturableTabSet,
  tabs: string[],
): CapturableTabSet & { tabs: string[] } {
  return Object.assign({}, set, { tabs });
}

export class BrowserTabsAdapter implements PinnedTabs {
  #tabs: BrowserTabsApi;

  constructor(tabs: BrowserTabsApi) {
    this.#tabs = tabs;
  }

  async queryPinned(windowId: number): Promise<PinnedTab[]> {
    try {
      const result = await this.#tabs.query({ pinned: true, windowId });
      if (!isUnknownArray(result)) {
        throw new Error('browser returned an invalid tab list');
      }

      return result
        .map((tab, position) => {
          if (!isRecord(tab) || !isInteger(tab.id)) {
            throw new Error('browser returned a pinned tab without an id');
          }

          return {
            id: tab.id,
            index: isInteger(tab.index) ? tab.index : position,
            url: effectiveUrl(tab),
          };
        })
        .sort((left, right) => left.index - right.index);
    } catch (error: unknown) {
      throw new Error(
        `Failed to query pinned tabs in window "${windowId}": ${errorMessage(error)}`,
        { cause: error },
      );
    }
  }

  async create(windowId: number, url: string): Promise<number> {
    try {
      const tab = await this.#tabs.create({ windowId, url, active: false });
      if (!isRecord(tab) || !isInteger(tab.id)) {
        throw new Error('browser returned a tab without an id');
      }
      return tab.id;
    } catch (error: unknown) {
      throw new Error(
        `Failed to create replacement tab for "${url}" in window "${windowId}": ${errorMessage(error)}`,
        { cause: error },
      );
    }
  }

  async pin(tabId: number, windowId: number, url: string): Promise<void> {
    try {
      await this.#tabs.update(tabId, { pinned: true });
    } catch (error: unknown) {
      throw new Error(
        `Failed to pin replacement tab "${tabId}" for "${url}" in window "${windowId}": ${errorMessage(error)}`,
        { cause: error },
      );
    }
  }

  async remove(
    tabIds: number[],
    windowId: number,
    purpose: string,
  ): Promise<void> {
    if (tabIds.length === 0) return;

    try {
      await this.#tabs.remove(tabIds);
    } catch (error: unknown) {
      throw new Error(
        `Failed to remove ${purpose} tabs [${tabIds.join(', ')}] in window "${windowId}": ${errorMessage(error)}`,
        { cause: error },
      );
    }
  }
}

export class WindowTabState {
  #tabs: PinnedTabs;
  #tabSets: TabSetStore;
  #windowSessions: WindowSessionStore;
  #runTransition: WindowTabStateDependencies['runTransition'];
  #runAllExclusive: WindowTabStateDependencies['runAllExclusive'];
  #onReplace: (urls: string[]) => void;

  constructor({
    tabs,
    tabSets,
    windowSessions,
    runTransition,
    runAllExclusive,
    onReplace = () => {},
  }: WindowTabStateDependencies) {
    this.#tabs = tabs;
    this.#tabSets = tabSets;
    this.#windowSessions = windowSessions;
    this.#runTransition = runTransition;
    this.#runAllExclusive = runAllExclusive;
    this.#onReplace = onReplace;
  }

  snapshot(windowId: number): Promise<string[]> {
    return this.#run(windowId, 'snapshot', async () => {
      const tabs = await this.#tabs.queryPinned(windowId);
      return tabs.map((tab) => tab.url);
    });
  }

  replace(windowId: number, setId: SetId): Promise<string[]> {
    return this.#run(
      windowId,
      `replace with tab set "${String(setId)}"`,
      async () => {
        const set = await this.#requiredSet(setId);
        const savedUrls = storedTabUrls(set);
        const currentTabs = await this.#tabs.queryPinned(windowId);

        if (urlsMatch(currentTabs, savedUrls)) {
          await this.#activateSession(windowId, setId, set);
          return savedUrls;
        }

        await this.#windowSessions.clear(windowId);
        this.#onReplace(savedUrls);
        await this.#replaceTabs(
          windowId,
          setId,
          set,
          currentTabs,
          savedUrls,
        );
        return savedUrls;
      },
    );
  }

  append(windowId: number, setId: SetId): Promise<string[]> {
    return this.#run(
      windowId,
      `append tab set "${String(setId)}"`,
      async () => {
        const set = await this.#requiredSet(setId);
        const savedUrls = storedTabUrls(set);
        const currentTabs = await this.#tabs.queryPinned(windowId);
        const urlsToCreate = missingUrls(currentTabs, savedUrls);

        await this.#windowSessions.clear(windowId);
        await this.#createPinnedTabs(windowId, urlsToCreate, 'appended');
        return currentTabs.map((tab) => tab.url).concat(urlsToCreate);
      },
    );
  }

  unload(windowId: number, setId: SetId): Promise<string[]> {
    return this.#run(
      windowId,
      `unload tab set "${String(setId)}"`,
      async () => {
        const set = await this.#requiredSet(setId);
        const savedUrls = storedTabUrls(set);
        const currentTabs = await this.#tabs.queryPinned(windowId);
        const tabIds = matchingTabIds(currentTabs, savedUrls);

        await this.#windowSessions.clear(windowId);
        await this.#tabs.remove(tabIds, windowId, 'unloaded');

        const removedIds = new Set(tabIds);
        return currentTabs
          .filter((tab) => !removedIds.has(tab.id))
          .map((tab) => tab.url);
      },
    );
  }

  captureAndSave(
    windowId: number,
    set: CapturableTabSet,
  ): Promise<SavedTabSet | null> {
    const setId = displaySetId(set);

    return this.#run(
      windowId,
      `capture and save tab set "${setId}"`,
      async () => {
        const tabs = await this.#tabs.queryPinned(windowId);
        if (tabs.length === 0) {
          await this.#windowSessions.clear(windowId);
          return null;
        }

        const capturedSet = withTabs(
          set,
          tabs.map((tab) => tab.url),
        );

        await this.#windowSessions.clear(windowId);
        try {
          return await this.#tabSets.saveForWindow(capturedSet, windowId);
        } catch (error: unknown) {
          const rollbackErrors = await this.#clearSessionAfterFailure(windowId);
          throw operationError(
            `capture and save tab set "${setId}"`,
            windowId,
            error,
            rollbackErrors,
          );
        }
      },
    );
  }

  deactivate(windowId: number): Promise<void> {
    return this.#run(windowId, 'deactivate tab set', async () => {
      await this.#windowSessions.clear(windowId);
    });
  }

  resetSessions(): Promise<void> {
    return this.#runAllExclusive(async () => {
      try {
        await this.#windowSessions.clearAll();
      } catch (error: unknown) {
        throw new Error(
          `Failed to reset all window sessions: ${errorMessage(error)}`,
          { cause: error },
        );
      }
    });
  }

  async #requiredSet(setId: SetId): Promise<StoredTabSet> {
    const set = await this.#tabSets.get(setId);

    if (set === null || set === undefined) {
      throw new Error(`Tab set "${String(setId)}" does not exist`);
    }

    if (!isStoredTabSet(set)) {
      if (!isRecord(set)) {
        throw new TypeError('Stored tab set must be an object');
      }
      throw new TypeError('Pinned tab list must be an array');
    }

    return set;
  }

  async #activateSession(
    windowId: number,
    setId: SetId,
    set: StoredTabSet,
  ): Promise<void> {
    await this.#windowSessions.clear(windowId);

    try {
      const activated = await this.#tabSets.activateWindowSession(
        setId,
        set,
        windowId,
      );
      if (!activated) {
        throw new Error(
          `Tab set "${String(setId)}" changed or was deleted during the transition`,
        );
      }
    } catch (error: unknown) {
      const rollbackErrors = await this.#clearSessionAfterFailure(windowId);
      throw operationError(
        `activate tab set "${String(setId)}"`,
        windowId,
        error,
        rollbackErrors,
      );
    }
  }

  async #replaceTabs(
    windowId: number,
    setId: SetId,
    set: StoredTabSet,
    currentTabs: PinnedTab[],
    savedUrls: string[],
  ): Promise<void> {
    let createdTabIds: number[] = [];

    try {
      createdTabIds = await this.#createAndPinTabs(windowId, savedUrls);

      const activated = await this.#tabSets.activateWindowSession(
        setId,
        set,
        windowId,
      );
      if (!activated) {
        throw new Error(
          `Tab set "${String(setId)}" changed or was deleted during the transition`,
        );
      }

      await this.#tabs.remove(
        currentTabs.map((tab) => tab.id),
        windowId,
        'original pinned',
      );
    } catch (error: unknown) {
      const primaryError = error instanceof PartialTabCreationError
        ? error.cause
        : error;

      if (error instanceof PartialTabCreationError) {
        createdTabIds = error.createdTabIds;
      }

      const rollbackErrors = await this.#clearSessionAfterFailure(windowId);
      try {
        await this.#tabs.remove(
          createdTabIds,
          windowId,
          'newly created rollback',
        );
      } catch (rollbackError: unknown) {
        rollbackErrors.push(rollbackError);
      }

      throw operationError(
        'replace',
        windowId,
        primaryError,
        rollbackErrors,
      );
    }
  }

  async #createPinnedTabs(
    windowId: number,
    urls: string[],
    purpose: string,
  ): Promise<void> {
    let createdTabIds: number[] = [];

    try {
      createdTabIds = await this.#createAndPinTabs(windowId, urls);
    } catch (error: unknown) {
      const primaryError = error instanceof PartialTabCreationError
        ? error.cause
        : error;

      if (error instanceof PartialTabCreationError) {
        createdTabIds = error.createdTabIds;
      }

      const rollbackErrors: unknown[] = [];
      try {
        await this.#tabs.remove(
          createdTabIds,
          windowId,
          `${purpose} rollback`,
        );
      } catch (rollbackError: unknown) {
        rollbackErrors.push(rollbackError);
      }

      throw operationError(
        purpose,
        windowId,
        primaryError,
        rollbackErrors,
      );
    }
  }

  async #createAndPinTabs(
    windowId: number,
    urls: string[],
  ): Promise<number[]> {
    const createdTabIds: number[] = [];

    try {
      for (const url of urls) {
        const tabId = await this.#tabs.create(windowId, url);
        createdTabIds.push(tabId);
        await this.#tabs.pin(tabId, windowId, url);
      }
      return createdTabIds;
    } catch (error: unknown) {
      throw new PartialTabCreationError(createdTabIds, error);
    }
  }

  async #clearSessionAfterFailure(windowId: number): Promise<unknown[]> {
    try {
      await this.#windowSessions.clear(windowId);
      return [];
    } catch (error: unknown) {
      return [error];
    }
  }

  #run<Result>(
    windowId: number,
    operation: string,
    transition: () => Promise<Result>,
  ): Promise<Result> {
    return this.#runTransition(windowId, async () => {
      try {
        return await transition();
      } catch (error: unknown) {
        if (isWindowTabStateError(error)) throw error;
        throw operationError(operation, windowId, error);
      }
    });
  }
}

export function createBrowserWindowTabState(
  browser: BrowserApi,
  { onReplace }: BrowserWindowTabStateOptions = {},
): WindowTabState {
  const repositories = createBrowserRepositories(browser);
  const fallbackGlobalOperation = createSerializedStorageOperation(
    browser.storage.local,
    ALL_WINDOWS_LOCK,
  );

  function runGlobal<Result>(
    mode: 'shared' | 'exclusive',
    operation: () => Promise<Result>,
  ): Promise<Result> {
    const locks = globalThis.navigator?.locks;
    if (locks?.request) {
      return locks.request(ALL_WINDOWS_LOCK, { mode }, operation);
    }
    return fallbackGlobalOperation(operation);
  }

  function runWindowExclusive<Result>(
    windowId: number,
    operation: () => Promise<Result>,
  ): Promise<Result> {
    return createSerializedStorageOperation(
      browser.storage.local,
      `${WINDOW_LOCK_PREFIX}${windowId}`,
    )(operation);
  }

  return new WindowTabState({
    tabs: new BrowserTabsAdapter(browser.tabs),
    tabSets: repositories.tabSets,
    windowSessions: repositories.windowSessions,
    runTransition(windowId, operation) {
      return runGlobal(
        'shared',
        () => runWindowExclusive(windowId, operation),
      );
    },
    runAllExclusive(operation) {
      return runGlobal('exclusive', operation);
    },
    ...(onReplace === undefined ? {} : { onReplace }),
  });
}

function sendWindowTabStateMessage(
  browser: BrowserApi,
  operation: WindowTabStateOperation,
  args: unknown[],
): Promise<unknown> {
  return browser.runtime.sendMessage({
    type: WINDOW_TAB_STATE_MESSAGE,
    operation,
    args,
  }).catch((error: unknown) => {
    throw new Error(
      `Failed to ${operation} pinned tabs through the background context: ${errorMessage(error)}`,
      { cause: error },
    );
  });
}

export function createWindowTabStateClient(browser: BrowserApi) {
  return {
    async snapshot(windowId: number): Promise<string[]> {
      const result = await sendWindowTabStateMessage(
        browser,
        'snapshot',
        [windowId],
      );
      return normalizeSavedUrls(result);
    },
    async replace(windowId: number, setId: SetId): Promise<string[]> {
      const result = await sendWindowTabStateMessage(
        browser,
        'replace',
        [windowId, setId],
      );
      return normalizeSavedUrls(result);
    },
    async append(windowId: number, setId: SetId): Promise<string[]> {
      const result = await sendWindowTabStateMessage(
        browser,
        'append',
        [windowId, setId],
      );
      return normalizeSavedUrls(result);
    },
    async unload(windowId: number, setId: SetId): Promise<string[]> {
      const result = await sendWindowTabStateMessage(
        browser,
        'unload',
        [windowId, setId],
      );
      return normalizeSavedUrls(result);
    },
    async captureAndSave(
      windowId: number,
      set: CapturableTabSet,
    ): Promise<SavedTabSet | null> {
      const result = await sendWindowTabStateMessage(
        browser,
        'captureAndSave',
        [windowId, set],
      );

      if (result === null || isSavedTabSet(result)) {
        return result;
      }

      throw new TypeError(
        'Saved tab set response must be an object or null',
      );
    },
  };
}

export function registerWindowTabStateMessages(
  browser: BrowserApi,
  windowTabState: WindowTabState,
): void {
  browser.runtime.onMessage.addListener((message: unknown) => {
    if (
      !isRecord(message)
      || message.type !== WINDOW_TAB_STATE_MESSAGE
    ) {
      return undefined;
    }

    const operation = message.operation;
    const args = message.args;

    if (!isUnknownArray(args)) {
      return Promise.reject(
        new Error(
          `Unknown WindowTabState operation "${String(operation)}"`,
        ),
      );
    }

    if (operation === 'snapshot' && isInteger(args[0])) {
      return windowTabState.snapshot(args[0]);
    }

    if (
      operation === 'replace'
      && isInteger(args[0])
      && isSetId(args[1])
    ) {
      return windowTabState.replace(args[0], args[1]);
    }

    if (
      operation === 'append'
      && isInteger(args[0])
      && isSetId(args[1])
    ) {
      return windowTabState.append(args[0], args[1]);
    }

    if (
      operation === 'unload'
      && isInteger(args[0])
      && isSetId(args[1])
    ) {
      return windowTabState.unload(args[0], args[1]);
    }

    if (
      operation === 'captureAndSave'
      && isInteger(args[0])
      && isCapturableTabSet(args[1])
    ) {
      return windowTabState.captureAndSave(args[0], args[1]);
    }

    return Promise.reject(
      new Error(
        `Unknown WindowTabState operation "${String(operation)}"`,
      ),
    );
  });
}