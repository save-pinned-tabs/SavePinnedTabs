import { restoreAutoloadSets } from './autoload.mjs';
import { createSerializedStorageOperation } from './serialized-operation.mjs';
import { createBrowserWindowTabState } from './window-tab-state.mjs';
import { createBrowserRepositories } from './repositories.mjs';
import {
  AUTOLOAD_EVERY_WINDOW,
  AUTOLOAD_FIRST_WINDOW,
  AUTOLOAD_SCOPES,
} from './storage-schema.mjs';

export { AUTOLOAD_EVERY_WINDOW, AUTOLOAD_FIRST_WINDOW };

const LIFECYCLE_KEY = 'savePinnedTabs:lifecycle';
const LIFECYCLE_LOCK = 'save-pinned-tabs:browser-lifecycle';
const DEFAULT_STARTUP_WINDOW_ATTEMPTS = 100;

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function initialState() {
  return {
    startupObserved: false,
    firstWindowId: null,
    openNormalWindowIds: [],
    restoredWindowIds: [],
  };
}

function normalizedWindowIds(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter(Number.isInteger))];
}

function normalizeState(storedState) {
  if (!storedState || typeof storedState !== 'object') return initialState();
  return {
    startupObserved: storedState.startupObserved === true,
    firstWindowId: Number.isInteger(storedState.firstWindowId)
      ? storedState.firstWindowId
      : null,
    openNormalWindowIds: normalizedWindowIds(storedState.openNormalWindowIds),
    restoredWindowIds: normalizedWindowIds(storedState.restoredWindowIds),
  };
}

function addWindowId(windowIds, windowId) {
  if (!windowIds.includes(windowId)) windowIds.push(windowId);
}

function removeWindowId(windowIds, windowId) {
  return windowIds.filter((storedWindowId) => storedWindowId !== windowId);
}

export class BrowserLifecycleStateStorage {
  #sessionStorage;
  #runExclusive;

  constructor(sessionStorage) {
    if (!sessionStorage) {
      throw new Error('Browser lifecycle requires browser.storage.session');
    }
    this.#sessionStorage = sessionStorage;
    this.#runExclusive = createSerializedStorageOperation(
      sessionStorage,
      LIFECYCLE_LOCK,
    );
  }

  runExclusive(operation) {
    return this.#runExclusive(operation);
  }

  async read() {
    const stored = await this.#sessionStorage.get(LIFECYCLE_KEY);
    return normalizeState(stored[LIFECYCLE_KEY]);
  }

  async write(state) {
    await this.#sessionStorage.set({ [LIFECYCLE_KEY]: normalizeState(state) });
  }
}

export class BrowserLifecycle {
  #getAutoload;
  #stateStorage;
  #windows;
  #windowTabState;
  #restoreAutoload;
  #delay;
  #startupWindowAttempts;

  constructor({
    autoloadPolicy,
    getAutoload,
    stateStorage,
    windows,
    windowTabState,
    restoreAutoload,
    delay = wait,
    startupWindowAttempts = DEFAULT_STARTUP_WINDOW_ATTEMPTS,
  }) {
    if (!getAutoload && !AUTOLOAD_SCOPES.has(autoloadPolicy)) {
      throw new TypeError(`Unsupported Autoload scope "${autoloadPolicy}"`);
    }
    this.#getAutoload = getAutoload ?? (() => ({
      scope: autoloadPolicy,
      setIds: [],
    }));
    this.#stateStorage = stateStorage;
    this.#windows = windows;
    this.#windowTabState = windowTabState;
    this.#restoreAutoload = restoreAutoload;
    this.#delay = delay;
    this.#startupWindowAttempts = startupWindowAttempts;
  }

  async onBrowserStartup() {
    await this.#initializeStartup();
    const configuration = await this.#autoloadConfiguration();
    const startupWindowIds = await this.#findStartupWindowIds();
    const targets = configuration.scope === AUTOLOAD_FIRST_WINDOW
      ? startupWindowIds.slice(0, 1)
      : startupWindowIds;
    await Promise.all(targets.map(
      (windowId) => this.#restoreWindowOnce(windowId, configuration),
    ));

  }
  async onWindowCreated(window) {
    if (window?.type !== 'normal' || !Number.isInteger(window.id)) return;
    const startupObserved = await this.#rememberNormalWindow(window.id);
    if (startupObserved) {
      await this.#restoreWindowOnce(window.id, await this.#autoloadConfiguration());
    }
  }

  async onWindowRemoved(windowId) {
    await this.#stateStorage.runExclusive(async () => {
      const state = normalizeState(await this.#stateStorage.read());
      state.openNormalWindowIds = removeWindowId(state.openNormalWindowIds, windowId);
      state.restoredWindowIds = removeWindowId(state.restoredWindowIds, windowId);
      await this.#stateStorage.write(state);
      await this.#windowTabState.deactivate(windowId);
    });
  }

  async #initializeStartup() {
    await this.#stateStorage.runExclusive(async () => {
      const state = normalizeState(await this.#stateStorage.read());
      if (state.startupObserved) return;

      await this.#windowTabState.resetSessions();
      state.startupObserved = true;
      await this.#stateStorage.write(state);
    });
  }

  async #rememberNormalWindow(windowId) {
    return this.#stateStorage.runExclusive(async () => {
      const state = normalizeState(await this.#stateStorage.read());
      addWindowId(state.openNormalWindowIds, windowId);
      await this.#stateStorage.write(state);
      return state.startupObserved;
    });
  }

  async #findStartupWindowIds() {
    for (let attempt = 0; attempt < this.#startupWindowAttempts; attempt += 1) {
      const windowIds = await this.#currentNormalWindowIds();
      if (windowIds.length > 0) return windowIds;
      await this.#delay(50);
    }
    return [];
  }

  async #currentNormalWindowIds() {
    const state = normalizeState(await this.#stateStorage.read());
    const windowIds = new Set(state.openNormalWindowIds);
    const currentWindows = await this.#windows.getAll(null);
    for (const window of currentWindows) {
      if (window?.type === 'normal' && Number.isInteger(window.id)) {
        windowIds.add(window.id);
      }
    }
    return [...windowIds];
  }

  async #restoreWindowOnce(windowId, configuration) {
    await this.#stateStorage.runExclusive(async () => {
      const state = normalizeState(await this.#stateStorage.read());
      if (!state.startupObserved || state.restoredWindowIds.includes(windowId)) return;
      if (
        configuration.scope === AUTOLOAD_FIRST_WINDOW
        && state.firstWindowId !== null
      ) return;

      await this.#restoreAutoload(windowId, configuration);
      addWindowId(state.restoredWindowIds, windowId);
      if (configuration.scope === AUTOLOAD_FIRST_WINDOW) {
        state.firstWindowId = windowId;
      }
      await this.#stateStorage.write(state);
    });
  }

  async #autoloadConfiguration() {
    const configuration = await this.#getAutoload();
    if (!AUTOLOAD_SCOPES.has(configuration?.scope) || !Array.isArray(configuration.setIds)) {
      throw new TypeError(`Unsupported Autoload scope "${configuration?.scope}"`);
    }
    return configuration;
  }
}

export function createBrowserLifecycle(browser, {
  windowTabState = createBrowserWindowTabState(browser),
  repositories = createBrowserRepositories(browser),
} = {}) {
  return new BrowserLifecycle({
    getAutoload: () => repositories.tabSets.getAutoload(),
    stateStorage: new BrowserLifecycleStateStorage(browser.storage.session),
    windows: browser.windows,
    windowTabState,
    restoreAutoload(windowId, configuration) {
      return restoreAutoloadSets(browser, windowId, configuration, windowTabState);
    },
  });
}
