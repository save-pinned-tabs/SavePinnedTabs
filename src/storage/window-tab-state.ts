/**
 * Manages pinned-tab snapshots, tab-set transitions, persistence, and cross-context messaging.
 */

import type { BrowserApi } from '../browser-api.js';
import type {
  TabSet,
  TabSetDetails,
  TabSetDraft,
  TabSetId,
  TabRestorationFailure,
  TabRestorationOutcome,
  WindowId,
} from '../domain.js';
import {
  errorMessage,
  isInteger,
  isRecord,
  isStringArray,
} from '../validation.js';
import { createBrowserRepositories } from './browser-repositories.js';
import { createSerializedStorageOperation } from './serialized-operation.js';

const ALL_WINDOWS_LOCK = 'save-pinned-tabs:all-window-tabs';
const WINDOW_LOCK_PREFIX = 'save-pinned-tabs:window-tabs:';
const WINDOW_TAB_STATE_ERROR = Symbol('windowTabStateError');
const WINDOW_TAB_STATE_MESSAGE = 'save-pinned-tabs:window-tab-state';


const WINDOW_TAB_STATE_OPERATIONS: Record<WindowTabStateOperation, true> = {
  snapshot: true,
  replace: true,
  captureAndSave: true,
};

/** Identifies an operation supported by the window tab-state message protocol. */
type WindowTabStateOperation =
  | 'snapshot'
  | 'replace'
  | 'captureAndSave';

/** Describes a pinned browser tab in display order. */
interface PinnedTab {
  id: number;
  index: number;
  url: string;
}

/** Provides the browser tab operations required by state transitions. */
interface PinnedTabs {
  /** Queries pinned tabs and returns them in display order. */
  queryPinned(windowId: WindowId): Promise<PinnedTab[]>;

  /** Creates an inactive tab and returns its browser-assigned identifier. */
  create(windowId: WindowId, url: string): Promise<number>;

  /** Pins an existing tab, reporting contextual errors on failure. */
  pin(tabId: number, windowId: WindowId, url: string): Promise<void>;

  /** Removes tabs and does nothing when the identifier list is empty. */
  remove(
    tabIds: number[],
    windowId: WindowId,
    purpose: string,
  ): Promise<void>;
}

/** Provides tab-set persistence and session activation operations. */
interface TabSetStore {
  /** Loads a tab set or returns null when it no longer exists. */
  get(setId: TabSetId): Promise<TabSet | null>;

  /** Saves captured tabs and associates the result with a window. */
  saveForWindow(
    set: TabSetDraft,
    windowId: WindowId,
  ): Promise<TabSet>;

  /** Activates a session only if the supplied tab set remains current. */
  activateWindowSession(
    setId: TabSetId,
    set: TabSet,
    windowId: WindowId,
  ): Promise<boolean>;
}

/** Clears active tab-set associations for browser windows. */
interface WindowSessionStore {
  /** Clears the active session for one window. */
  clear(windowId: WindowId): Promise<void>;

  /** Clears active sessions for every window. */
  clearAll(): Promise<void>;
}

/** Supplies storage, browser, locking, and notification dependencies. */
interface WindowTabStateDependencies {
  tabs: PinnedTabs;
  tabSets: TabSetStore;
  windowSessions: WindowSessionStore;

  /** Serializes a transition against other transitions for the same window. */
  runTransition: <Result>(
    windowId: WindowId,
    operation: () => Promise<Result>,
  ) => Promise<Result>;

  /** Runs an operation exclusively against transitions for all windows. */
  runAllExclusive: <Result>(
    operation: () => Promise<Result>,
  ) => Promise<Result>;

  /** Observes replacement URLs before browser tabs are changed. */
  onReplace?: (urls: string[]) => void;
}

/** Configures browser-backed window tab-state behavior. */
interface BrowserWindowTabStateOptions {
  /** Observes replacement URLs before browser tabs are changed. */
  onReplace?: (urls: string[]) => void;
}



/** Checks whether a value is a valid tab-set identifier. */
function isTabSetId(value: unknown): value is TabSetId {
  return typeof value === 'string';
}

/** Checks whether a value contains valid tab-set metadata. */
function isTabSetDetails(value: unknown): value is TabSetDetails {
  return isRecord(value)
    && typeof value.name === 'string'
    && (
      value.id === undefined
      || isTabSetId(value.id)
    );
}

/** Checks whether a value is a complete persisted tab set. */
function isTabSet(value: unknown): value is TabSet {
  return isRecord(value)
    && isTabSetId(value.id)
    && typeof value.name === 'string'
    && isStringArray(value.tabs);
}

/** Formats absent identifiers as "new" for operation messages. */
function displaySetId(set: TabSetDetails): string {
  return set.id === null || set.id === undefined
    ? 'new'
    : String(set.id);
}

/** Creates a marked transition error with optional rollback failure context. */
function operationError(
  operation: string,
  windowId: WindowId,
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

/** Detects errors already enriched with window tab-state context. */
function isWindowTabStateError(error: unknown): boolean {
  return error instanceof Error
    && WINDOW_TAB_STATE_ERROR in error
    && error[WINDOW_TAB_STATE_ERROR] === true;
}


/** Canonicalizes absolute URLs while preserving nonstandard browser URL strings. */
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

/** Resolves a tab's pending URL before its committed URL. */
function effectiveUrl(tab: unknown): string {
  const pendingUrl = isRecord(tab) ? tab.pendingUrl : undefined;
  const url = isRecord(tab) ? tab.url : undefined;
  return normalizeUrl(pendingUrl || url);
}

/** Validates and normalizes a saved URL list. */
function normalizeSavedUrls(urls: unknown): string[] {
  if (!Array.isArray(urls)) {
    throw new TypeError('Pinned tab list must be an array');
  }
  return urls.map(normalizeUrl);
}

/** Normalizes URLs read from a persisted tab set. */
function storedTabUrls(set: TabSet): string[] {
  return set.tabs.map(normalizeUrl);
}

/** Compares current tabs with saved URLs using order and multiplicity. */
function urlsMatch(tabs: PinnedTab[], urls: string[]): boolean {
  return tabs.length === urls.length
    && tabs.every((tab, index) => tab.url === urls[index]);
}


/** Creates a tab-set draft without mutating the supplied details. */
function withTabs(
  set: TabSetDetails,
  tabs: string[],
): TabSetDraft {
  return Object.assign({}, set, { tabs });
}

/** Adapts browser tab APIs to validated pinned-tab operations. */
export class BrowserTabsAdapter implements PinnedTabs {
  #tabs: BrowserApi['tabs'];

  /** Wraps a browser tab API implementation. */
  constructor(tabs: BrowserApi['tabs']) {
    this.#tabs = tabs;
  }

  /** Queries, validates, normalizes, and orders pinned tabs. */
  async queryPinned(windowId: WindowId): Promise<PinnedTab[]> {
    try {
      const result = await this.#tabs.query({ pinned: true, windowId });
      if (!Array.isArray(result)) {
        throw new Error('browser returned an invalid tab list');
      }

      return result
        .map((tab, position) => {
          if (!isRecord(tab) || !isInteger(tab.id)) {
            throw new Error(
              'browser returned a pinned tab without an id',
            );
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

  /** Creates an inactive replacement tab and validates its identifier. */
  async create(windowId: WindowId, url: string): Promise<number> {
    try {
      const tab = await this.#tabs.create({
        windowId,
        url,
        active: false,
      });
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

  /** Pins a replacement tab and adds window and URL context to failures. */
  async pin(
    tabId: number,
    windowId: WindowId,
    url: string,
  ): Promise<void> {
    try {
      await this.#tabs.update(tabId, { pinned: true });
    } catch (error: unknown) {
      throw new Error(
        `Failed to pin replacement tab "${tabId}" for "${url}" in window "${windowId}": ${errorMessage(error)}`,
        { cause: error },
      );
    }
  }

  /** Removes tabs, skipping browser access when none are supplied. */
  async remove(
    tabIds: number[],
    windowId: WindowId,
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

/** Serializes pinned-tab transitions and coordinates window session state. */
export class WindowTabState {
  #tabs: PinnedTabs;
  #tabSets: TabSetStore;
  #windowSessions: WindowSessionStore;
  #runTransition: WindowTabStateDependencies['runTransition'];
  #runAllExclusive: WindowTabStateDependencies['runAllExclusive'];
  #onReplace: (urls: string[]) => void;

  /** Initializes transition coordination with injected persistence and locking. */
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

  /** Captures normalized pinned-tab URLs in display order. */
  snapshot(windowId: WindowId): Promise<string[]> {
    return this.#run(windowId, 'snapshot', async () => {
      const tabs = await this.#tabs.queryPinned(windowId);
      return tabs.map((tab) => tab.url);
    });
  }

  /** Restores available saved tabs, preserving originals when every tab fails. */
  replace(windowId: WindowId, setId: TabSetId): Promise<TabRestorationOutcome> {
    return this.#run(
      windowId,
      `replace with tab set "${String(setId)}"`,
      async () => {
        const set = await this.#requiredSet(setId);
        const savedUrls = storedTabUrls(set);
        const currentTabs = await this.#tabs.queryPinned(windowId);

        if (urlsMatch(currentTabs, savedUrls)) {
          await this.#activateSession(windowId, setId, set);
          return { restoredUrls: savedUrls, total: savedUrls.length, failures: [] };
        }

        await this.#windowSessions.clear(windowId);
        this.#onReplace(savedUrls);
        return this.#replaceTabs(
          windowId,
          setId,
          set,
          currentTabs,
          savedUrls,
        );
      },
    );
  }


  /** Captures pinned tabs and saves them, returning null when none exist. */
  captureAndSave(
    windowId: WindowId,
    set: TabSetDetails,
  ): Promise<TabSet | null> {
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
          return await this.#tabSets.saveForWindow(
            capturedSet,
            windowId,
          );
        } catch (error: unknown) {
          const rollbackErrors =
            await this.#clearSessionAfterFailure(windowId);
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

  /** Clears the active tab-set session for a window. */
  deactivate(windowId: WindowId): Promise<void> {
    return this.#run(windowId, 'deactivate tab set', async () => {
      await this.#windowSessions.clear(windowId);
    });
  }

  /** Clears all window sessions while blocking concurrent transitions. */
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

  /** Loads a tab set or throws when it does not exist. */
  async #requiredSet(setId: TabSetId): Promise<TabSet> {
    const set = await this.#tabSets.get(setId);
    if (set === null) {
      throw new Error(`Tab set "${String(setId)}" does not exist`);
    }
    return set;
  }

  /** Clears prior state and activates a session with rollback on failure. */
  async #activateSession(
    windowId: WindowId,
    setId: TabSetId,
    set: TabSet,
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
      const rollbackErrors =
        await this.#clearSessionAfterFailure(windowId);
      throw operationError(
        `activate tab set "${String(setId)}"`,
        windowId,
        error,
        rollbackErrors,
      );
    }
  }

  /** Retains per-tab successes, rolling back only operation-wide failures. */
  async #replaceTabs(
    windowId: WindowId,
    setId: TabSetId,
    set: TabSet,
    currentTabs: PinnedTab[],
    savedUrls: string[],
  ): Promise<TabRestorationOutcome> {
    let createdTabIds: number[] = [];
    let restoration: TabRestorationOutcome | undefined;

    try {
      const replacements = await this.#createAndPinTabs(windowId, savedUrls);
      createdTabIds = replacements.createdTabIds;
      restoration = replacements.restoration;
      if (restoration.restoredUrls.length === 0 && savedUrls.length > 0) {
        return restoration;
      }

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
      return restoration;
    } catch (error: unknown) {
      const rollbackErrors =
        await this.#clearSessionAfterFailure(windowId);
      if (restoration) {
        for (const failure of restoration.failures) {
          if (failure.cleanupError !== undefined) rollbackErrors.push(failure.cleanupError);
        }
      }
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
        error,
        rollbackErrors,
      );
    }
  }


  /** Pins sequentially so successful replacements retain their saved order. */
  async #createAndPinTabs(
    windowId: WindowId,
    urls: string[],
  ): Promise<{ createdTabIds: number[]; restoration: TabRestorationOutcome }> {
    const createdTabIds: number[] = [];
    const restoration: TabRestorationOutcome = {
      restoredUrls: [],
      total: urls.length,
      failures: [],
    };

    for (const url of urls) {
      let tabId: number;
      try {
        tabId = await this.#tabs.create(windowId, url);
      } catch (error: unknown) {
        restoration.failures.push({ url, reason: errorMessage(error) });
        continue;
      }

      try {
        await this.#tabs.pin(tabId, windowId, url);
      } catch (error: unknown) {
        const failure: TabRestorationFailure = { url, reason: errorMessage(error) };
        try {
          await this.#tabs.remove([tabId], windowId, 'failed replacement');
        } catch (cleanupError: unknown) {
          failure.cleanupError = errorMessage(cleanupError);
          createdTabIds.push(tabId);
        }
        restoration.failures.push(failure);
        continue;
      }

      createdTabIds.push(tabId);
      restoration.restoredUrls.push(url);
    }
    return { createdTabIds, restoration };
  }

  /** Attempts session cleanup and returns any rollback failure. */
  async #clearSessionAfterFailure(
    windowId: WindowId,
  ): Promise<unknown[]> {
    try {
      await this.#windowSessions.clear(windowId);
      return [];
    } catch (error: unknown) {
      return [error];
    }
  }

  /** Serializes a transition and adds consistent operation context to failures. */
  #run<Result>(
    windowId: WindowId,
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

/** Creates browser-backed tab-state coordination with global and per-window locks. */
export function createBrowserWindowTabState(
  browser: BrowserApi,
  { onReplace }: BrowserWindowTabStateOptions = {},
): WindowTabState {
  const repositories = createBrowserRepositories(browser);
  const fallbackGlobalOperation = createSerializedStorageOperation(
    browser.storage.local,
    ALL_WINDOWS_LOCK,
  );

  /** Runs under a Web Lock when available, otherwise using serialized storage. */
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

  /** Serializes operations that target the same browser window. */
  function runWindowExclusive<Result>(
    windowId: WindowId,
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

/** Sends a tab-state request to the background context with contextual errors. */
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

/** Exposes window tab-state operations through background messaging. */
export interface WindowTabStateClient {
  /** Captures pinned-tab URLs in display order. */
  snapshot(windowId: WindowId): Promise<string[]>;

  /** Replaces pinned tabs with a saved tab set. */
  replace(windowId: WindowId, setId: TabSetId): Promise<TabRestorationOutcome>;


  /** Captures and saves pinned tabs, or returns null when none exist. */
  captureAndSave(
    windowId: WindowId,
    set: TabSetDetails,
  ): Promise<TabSet | null>;
}

/** Creates a validated messaging client for background tab-state operations. */
export function createWindowTabStateClient(
  browser: BrowserApi,
): WindowTabStateClient {
  return {
    async snapshot(windowId) {
      return normalizeSavedUrls(
        await sendWindowTabStateMessage(browser, 'snapshot', [windowId]),
      );
    },
    async replace(windowId, setId) {
      const result = await sendWindowTabStateMessage(browser, 'replace', [windowId, setId]);
      if (
        !isRecord(result)
        || !isStringArray(result.restoredUrls)
        || !isInteger(result.total)
        || result.total < 0
        || !Array.isArray(result.failures)
        || !result.failures.every((failure: unknown) =>
          isRecord(failure)
          && typeof failure.url === 'string'
          && typeof failure.reason === 'string'
          && (failure.cleanupError === undefined || typeof failure.cleanupError === 'string')
        )
        || result.restoredUrls.length + result.failures.length !== result.total
      ) {
        throw new TypeError('Invalid tab restoration response');
      }
      return {
        restoredUrls: normalizeSavedUrls(result.restoredUrls),
        total: result.total,
        failures: result.failures as TabRestorationFailure[],
      };
    },

    async captureAndSave(
      windowId: WindowId,
      set: TabSetDetails,
    ): Promise<TabSet | null> {
      const result = await sendWindowTabStateMessage(
        browser,
        'captureAndSave',
        [windowId, set],
      );

      if (result === null || isTabSet(result)) {
        return result;
      }

      throw new TypeError(
        'Saved tab set response must be an object or null',
      );
    },
  };
}

/** Registers and validates background requests for tab-state operations. */
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
    if (
      typeof operation !== 'string'
      || !Object.hasOwn(WINDOW_TAB_STATE_OPERATIONS, operation)
    ) {
      return Promise.reject(
        new Error(`Unknown WindowTabState operation "${String(operation)}"`),
      );
    }

    const args = message.args;
    if (!Array.isArray(args)) {
      return Promise.reject(
        new Error(`Invalid arguments for WindowTabState operation "${operation}"`),
      );
    }

    if (operation === 'snapshot' && isInteger(args[0])) {
      return windowTabState.snapshot(args[0]);
    }

    if (
      operation === 'replace'
      && isInteger(args[0])
      && isTabSetId(args[1])
    ) {
      return windowTabState.replace(args[0], args[1]);
    }


    if (
      operation === 'captureAndSave'
      && isInteger(args[0])
      && isTabSetDetails(args[1])
    ) {
      return windowTabState.captureAndSave(args[0], args[1]);
    }

    return Promise.reject(
      new Error(`Invalid arguments for WindowTabState operation "${operation}"`),
    );
  });
}