import { createBrowserRepositories } from './repositories.mjs';
import { createSerializedStorageOperation } from './serialized-operation.mjs';

const ALL_WINDOWS_LOCK = 'save-pinned-tabs:all-window-tabs';
const WINDOW_LOCK_PREFIX = 'save-pinned-tabs:window-tabs:';
const WINDOW_TAB_STATE_ERROR = Symbol('windowTabStateError');
const WINDOW_TAB_STATE_MESSAGE = 'save-pinned-tabs:window-tab-state';

function operationError(operation, windowId, cause, rollbackErrors = []) {
  const rollbackContext = rollbackErrors.length === 0
    ? ''
    : `; rollback also failed: ${rollbackErrors.map((error) => error.message).join('; ')}`;
  const error = new Error(
    `Failed to ${operation} pinned tabs in window "${windowId}": ${cause.message}${rollbackContext}`,
    { cause },
  );
  error[WINDOW_TAB_STATE_ERROR] = true;
  return error;
}

class PartialTabCreationError extends Error {
  constructor(createdTabIds, cause) {
    super(cause.message, { cause });
    this.createdTabIds = createdTabIds;
  }
}


export function normalizeUrl(url) {
  if (typeof url !== 'string' || url.length === 0) {
    throw new TypeError('Pinned tab URL must be a non-empty string');
  }

  try {
    return new URL(url).href;
  } catch {
    return url;
  }
}

function effectiveUrl(tab) {
  return normalizeUrl(tab.pendingUrl || tab.url);
}

function normalizeSavedUrls(urls) {
  return urls.map(normalizeUrl);
}

function urlsMatch(tabs, urls) {
  return tabs.length === urls.length
    && tabs.every((tab, index) => tab.url === urls[index]);
}

function missingUrls(tabs, savedUrls) {
  const existingMultiplicity = new Map();
  for (const tab of tabs) {
    existingMultiplicity.set(tab.url, (existingMultiplicity.get(tab.url) ?? 0) + 1);
  }

  return savedUrls.filter((url) => {
    const remaining = existingMultiplicity.get(url) ?? 0;
    if (remaining === 0) return true;
    existingMultiplicity.set(url, remaining - 1);
    return false;
  });
}

function matchingTabIds(tabs, savedUrls) {
  const remainingMultiplicity = new Map();
  for (const url of savedUrls) {
    remainingMultiplicity.set(url, (remainingMultiplicity.get(url) ?? 0) + 1);
  }

  const tabIds = [];
  for (const tab of tabs) {
    const remaining = remainingMultiplicity.get(tab.url) ?? 0;
    if (remaining === 0) continue;
    remainingMultiplicity.set(tab.url, remaining - 1);
    tabIds.push(tab.id);
  }
  return tabIds;
}

export class BrowserTabsAdapter {
  #tabs;

  constructor(tabs) {
    this.#tabs = tabs;
  }

  async queryPinned(windowId) {
    try {
      const tabs = await this.#tabs.query({ pinned: true, windowId });
      return tabs
        .map((tab, position) => ({
          id: tab.id,
          index: Number.isInteger(tab.index) ? tab.index : position,
          url: effectiveUrl(tab),
        }))
        .sort((left, right) => left.index - right.index);
    } catch (error) {
      throw new Error(`Failed to query pinned tabs in window "${windowId}": ${error.message}`, { cause: error });
    }
  }

  async create(windowId, url) {
    try {
      const tab = await this.#tabs.create({ windowId, url, active: false });
      if (!Number.isInteger(tab?.id)) throw new Error('browser returned a tab without an id');
      return tab.id;
    } catch (error) {
      throw new Error(`Failed to create replacement tab for "${url}" in window "${windowId}": ${error.message}`, { cause: error });
    }
  }

  async pin(tabId, windowId, url) {
    try {
      await this.#tabs.update(tabId, { pinned: true });
    } catch (error) {
      throw new Error(`Failed to pin replacement tab "${tabId}" for "${url}" in window "${windowId}": ${error.message}`, { cause: error });
    }
  }

  async remove(tabIds, windowId, purpose) {
    if (tabIds.length === 0) return;
    try {
      await this.#tabs.remove(tabIds);
    } catch (error) {
      throw new Error(`Failed to remove ${purpose} tabs [${tabIds.join(', ')}] in window "${windowId}": ${error.message}`, { cause: error });
    }
  }
}

export class WindowTabState {
  #tabs;
  #tabSets;
  #windowSessions;
  #runTransition;
  #runAllExclusive;
  #onReplace;

  constructor({ tabs, tabSets, windowSessions, runTransition, runAllExclusive, onReplace = () => {} }) {
    this.#tabs = tabs;
    this.#tabSets = tabSets;
    this.#windowSessions = windowSessions;
    this.#runTransition = runTransition;
    this.#runAllExclusive = runAllExclusive;
    this.#onReplace = onReplace;
  }

  snapshot(windowId) {
    return this.#run(windowId, 'snapshot', async () => {
      const tabs = await this.#tabs.queryPinned(windowId);
      return tabs.map((tab) => tab.url);
    });
  }

  replace(windowId, setId) {
    return this.#run(windowId, `replace with tab set "${setId}"`, async () => {
      const set = await this.#requiredSet(setId);
      const savedUrls = normalizeSavedUrls(set.tabs);
      const currentTabs = await this.#tabs.queryPinned(windowId);

      if (urlsMatch(currentTabs, savedUrls)) {
        await this.#activateSession(windowId, setId, set);
        return savedUrls;
      }

      await this.#windowSessions.clear(windowId);
      this.#onReplace(savedUrls);
      await this.#replaceTabs(windowId, setId, set, currentTabs, savedUrls);
      return savedUrls;
    });
  }

  append(windowId, setId) {
    return this.#run(windowId, `append tab set "${setId}"`, async () => {
      const set = await this.#requiredSet(setId);
      const savedUrls = normalizeSavedUrls(set.tabs);
      const currentTabs = await this.#tabs.queryPinned(windowId);
      const urlsToCreate = missingUrls(currentTabs, savedUrls);

      await this.#windowSessions.clear(windowId);
      await this.#createPinnedTabs(windowId, urlsToCreate, 'appended');
      return currentTabs.map((tab) => tab.url).concat(urlsToCreate);
    });
  }

  unload(windowId, setId) {
    return this.#run(windowId, `unload tab set "${setId}"`, async () => {
      const set = await this.#requiredSet(setId);
      const savedUrls = normalizeSavedUrls(set.tabs);
      const currentTabs = await this.#tabs.queryPinned(windowId);
      const tabIds = matchingTabIds(currentTabs, savedUrls);

      await this.#windowSessions.clear(windowId);
      await this.#tabs.remove(tabIds, windowId, 'unloaded');
      const removedIds = new Set(tabIds);
      return currentTabs.filter((tab) => !removedIds.has(tab.id)).map((tab) => tab.url);
    });
  }

  captureAndSave(windowId, set) {
    return this.#run(windowId, `capture and save tab set "${set.id ?? 'new'}"`, async () => {
      const tabs = await this.#tabs.queryPinned(windowId);
      if (tabs.length === 0) {
        await this.#windowSessions.clear(windowId);
        return null;
      }

      const capturedSet = {
        ...set,
        tabs: tabs.map((tab) => tab.url),
      };
      await this.#windowSessions.clear(windowId);
      try {
        return await this.#tabSets.saveForWindow(capturedSet, windowId);
      } catch (error) {
        const rollbackErrors = await this.#clearSessionAfterFailure(windowId);
        throw operationError(
          `capture and save tab set "${set.id ?? 'new'}"`,
          windowId,
          error,
          rollbackErrors,
        );
      }
    });
  }

  deactivate(windowId) {
    return this.#run(windowId, 'deactivate tab set', async () => {
      await this.#windowSessions.clear(windowId);
    });
  }

  resetSessions() {
    return this.#runAllExclusive(async () => {
      try {
        await this.#windowSessions.clearAll();
      } catch (error) {
        throw new Error(`Failed to reset all window sessions: ${error.message}`, { cause: error });
      }
    });
  }

  async #requiredSet(setId) {
    const set = await this.#tabSets.get(setId);
    if (!set) throw new Error(`Tab set "${setId}" does not exist`);
    return set;
  }

  async #activateSession(windowId, setId, set) {
    await this.#windowSessions.clear(windowId);
    try {
      const activated = await this.#tabSets.activateWindowSession(setId, set, windowId);
      if (!activated) throw new Error(`Tab set "${setId}" changed or was deleted during the transition`);
    } catch (error) {
      const rollbackErrors = await this.#clearSessionAfterFailure(windowId);
      throw operationError(`activate tab set "${setId}"`, windowId, error, rollbackErrors);
    }
  }

  async #replaceTabs(windowId, setId, set, currentTabs, savedUrls) {
    let createdTabIds = [];
    try {
      createdTabIds = await this.#createAndPinTabs(windowId, savedUrls);

      const activated = await this.#tabSets.activateWindowSession(setId, set, windowId);
      if (!activated) throw new Error(`Tab set "${setId}" changed or was deleted during the transition`);
      await this.#tabs.remove(currentTabs.map((tab) => tab.id), windowId, 'original pinned');
    } catch (error) {
      const primaryError = error instanceof PartialTabCreationError ? error.cause : error;
      if (error instanceof PartialTabCreationError) createdTabIds = error.createdTabIds;
      const rollbackErrors = await this.#clearSessionAfterFailure(windowId);
      try {
        await this.#tabs.remove(createdTabIds, windowId, 'newly created rollback');
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
      throw operationError('replace', windowId, primaryError, rollbackErrors);
    }
  }

  async #createPinnedTabs(windowId, urls, purpose) {
    let createdTabIds = [];
    try {
      createdTabIds = await this.#createAndPinTabs(windowId, urls);
    } catch (error) {
      const primaryError = error instanceof PartialTabCreationError ? error.cause : error;
      if (error instanceof PartialTabCreationError) createdTabIds = error.createdTabIds;
      const rollbackErrors = [];
      try {
        await this.#tabs.remove(createdTabIds, windowId, `${purpose} rollback`);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
      throw operationError(purpose, windowId, primaryError, rollbackErrors);
    }
  }

  async #createAndPinTabs(windowId, urls) {
    const createdTabIds = [];
    try {
      for (const url of urls) {
        const tabId = await this.#tabs.create(windowId, url);
        createdTabIds.push(tabId);
        await this.#tabs.pin(tabId, windowId, url);
      }
      return createdTabIds;
    } catch (error) {
      throw new PartialTabCreationError(createdTabIds, error);
    }
  }

  async #clearSessionAfterFailure(windowId) {
    try {
      await this.#windowSessions.clear(windowId);
      return [];
    } catch (error) {
      return [error];
    }
  }


  #run(windowId, operation, transition) {
    return this.#runTransition(windowId, async () => {
      try {
        return await transition();
      } catch (error) {
        if (error[WINDOW_TAB_STATE_ERROR]) throw error;
        throw operationError(operation, windowId, error);
      }
    });
  }
}

export function createBrowserWindowTabState(browser, { onReplace } = {}) {
  const repositories = createBrowserRepositories(browser);
  const fallbackGlobalOperation = createSerializedStorageOperation(
    browser.storage.local,
    ALL_WINDOWS_LOCK,
  );

  function runGlobal(mode, operation) {
    const locks = globalThis.navigator?.locks;
    if (locks?.request) return locks.request(ALL_WINDOWS_LOCK, { mode }, operation);
    return fallbackGlobalOperation(operation);
  }

  function runWindowExclusive(windowId, operation) {
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
      return runGlobal('shared', () => runWindowExclusive(windowId, operation));
    },
    runAllExclusive(operation) {
      return runGlobal('exclusive', operation);
    },
    onReplace,
  });
}

function sendWindowTabStateMessage(browser, operation, args) {
  return browser.runtime.sendMessage({
    type: WINDOW_TAB_STATE_MESSAGE,
    operation,
    args,
  }).catch((error) => {
    throw new Error(`Failed to ${operation} pinned tabs through the background context: ${error.message}`, {
      cause: error,
    });
  });
}

export function createWindowTabStateClient(browser) {
  return {
    snapshot(windowId) {
      return sendWindowTabStateMessage(browser, 'snapshot', [windowId]);
    },
    replace(windowId, setId) {
      return sendWindowTabStateMessage(browser, 'replace', [windowId, setId]);
    },
    append(windowId, setId) {
      return sendWindowTabStateMessage(browser, 'append', [windowId, setId]);
    },
    unload(windowId, setId) {
      return sendWindowTabStateMessage(browser, 'unload', [windowId, setId]);
    },
    captureAndSave(windowId, set) {
      return sendWindowTabStateMessage(browser, 'captureAndSave', [windowId, set]);
    },
  };
}

export function registerWindowTabStateMessages(browser, windowTabState) {
  const operations = {
    snapshot: (args) => windowTabState.snapshot(...args),
    replace: (args) => windowTabState.replace(...args),
    append: (args) => windowTabState.append(...args),
    unload: (args) => windowTabState.unload(...args),
    captureAndSave: (args) => windowTabState.captureAndSave(...args),
  };

  browser.runtime.onMessage.addListener((message) => {
    if (message?.type !== WINDOW_TAB_STATE_MESSAGE) return undefined;
    const operation = operations[message.operation];
    if (!operation || !Array.isArray(message.args)) {
      return Promise.reject(new Error(`Unknown WindowTabState operation "${message.operation}"`));
    }
    return operation(message.args);
  });
}
